"""
voice.py - TTS: hace que el robot HABLE (texto -> voz por el altavoz del Jetson).

Motor por defecto: espeak-ng (offline, liviano, voz robotica, soporta espanol).
Si instalas 'piper' + un modelo de voz, se puede cambiar por una voz neural mucho
mas natural (ver deploy/README.md). Degrada limpio si no hay audio ni motor: el
resto del servidor sigue igual (como camara/lidar).

Reproduce en cola con un solo hilo para que las frases no se pisen.
Env:
    AUDIO_DEV=plughw:1,0   fuerza la tarjeta ALSA (altavoz USB). Ver 'aplay -l'.
    VOICE_LANG=es          idioma de espeak.
"""
import os
import shutil
import subprocess
import threading
import queue

AUDIO_DEV = os.environ.get("AUDIO_DEV", "")
VOICE_LANG = os.environ.get("VOICE_LANG", "es")
VOICE_SPEED = os.environ.get("VOICE_SPEED", "155")   # palabras/min de espeak


def _has(cmd):
    return shutil.which(cmd) is not None


class Voice:
    def __init__(self):
        self.engine = "espeak-ng" if _has("espeak-ng") else ("espeak" if _has("espeak") else None)
        self.available = self.engine is not None
        self.last = ""
        self._q = queue.Queue(maxsize=16)
        if self.available:
            threading.Thread(target=self._worker, daemon=True).start()
            print(f"[voice] TTS listo (motor: {self.engine}, idioma: {VOICE_LANG})")
        else:
            print("[voice] TTS no disponible -> instala espeak-ng para que el robot hable "
                  "(sudo apt install espeak-ng)")

    def say(self, text):
        text = " ".join((text or "").split())[:300]   # limpia y limita
        if not text:
            return {"ok": False, "error": "texto vacio"}
        if not self.available:
            return {"ok": False, "available": False,
                    "error": "TTS no instalado (sudo apt install espeak-ng)"}
        try:
            self._q.put_nowait(text)
        except queue.Full:
            return {"ok": False, "error": "cola de voz llena"}
        self.last = text
        return {"ok": True, "text": text}

    def status(self):
        return {"available": self.available, "engine": self.engine,
                "lang": VOICE_LANG, "last": self.last}

    def _worker(self):
        while True:
            text = self._q.get()
            try:
                self._speak(text)
            except Exception as e:
                print(f"[voice] error al hablar: {e}")

    def _speak(self, text):
        base = [self.engine, "-v", VOICE_LANG, "-s", VOICE_SPEED]
        # Con aplay podemos elegir la tarjeta (AUDIO_DEV); si no, espeak toca solo.
        if _has("aplay"):
            p = subprocess.Popen(base + ["--stdout", text], stdout=subprocess.PIPE)
            aplay = ["aplay", "-q"] + (["-D", AUDIO_DEV] if AUDIO_DEV else [])
            subprocess.run(aplay, stdin=p.stdout, check=False, timeout=30)
            if p.stdout:
                p.stdout.close()
            p.wait(timeout=30)
        else:
            subprocess.run(base + [text], check=False, timeout=30)


# instancia global
voice = Voice()
