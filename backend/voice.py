"""
voice.py - Audio del robot: TTS (que NEO hable) y reproduccion de sonidos
(ladrido, chime) por el ALTAVOZ del Jetson.

TTS: espeak-ng (offline, liviano, espanol). Degrada limpio si no esta.

IMPORTANTE sobre el audio en el Jetson corriendo como servicio systemd:
  - Un servicio de sistema NO tiene sesion de PulseAudio. Dos formas de que suene:
      1) ALSA directo a la tarjeta:  AUDIO_DEV=plughw:1,0  (numero de 'aplay -l')
      2) PulseAudio del usuario: el .service exporta XDG_RUNTIME_DIR/PULSE_SERVER
         y se habilita 'loginctl enable-linger'.
  - Si instalas espeak-ng, hay que REINICIAR el servicio (el motor se detecta al
    arrancar).

Env: AUDIO_DEV (tarjeta ALSA), VOICE_LANG (es), VOICE_SPEED (155).
"""
import os
import shutil
import subprocess
import threading
import queue

AUDIO_DEV = os.environ.get("AUDIO_DEV", "")
VOICE_LANG = os.environ.get("VOICE_LANG", "es")
VOICE_SPEED = os.environ.get("VOICE_SPEED", "155")


def _has(cmd):
    return shutil.which(cmd) is not None


class Voice:
    def __init__(self):
        self.engine = "espeak-ng" if _has("espeak-ng") else ("espeak" if _has("espeak") else None)
        self.available = self.engine is not None          # ¿hay TTS?
        self.last = ""
        self.last_error = ""
        self._q = queue.Queue(maxsize=16)
        threading.Thread(target=self._worker, daemon=True).start()   # siempre (tambien reproduce archivos)
        if self.available:
            print(f"[voice] TTS listo (motor: {self.engine}); reproductores: {self._players()}")
        else:
            print("[voice] TTS NO disponible -> 'sudo apt install espeak-ng' y REINICIA el servicio")

    @staticmethod
    def _players():
        return [p for p in ("aplay", "paplay", "ffplay", "mpg123") if _has(p)]

    @property
    def can_play(self):
        return bool(self._players()) or self.available

    # -- API publica --------------------------------------------------------
    def say(self, text):
        text = " ".join((text or "").split())[:300]
        if not text:
            return {"ok": False, "error": "texto vacio"}
        if not self.available:
            return {"ok": False, "available": False,
                    "error": "TTS no instalado: 'sudo apt install espeak-ng' y reinicia el servicio"}
        try:
            self._q.put_nowait(("say", text))
        except queue.Full:
            return {"ok": False, "error": "cola de voz llena"}
        self.last = text
        return {"ok": True, "text": text}

    def play(self, path):
        if not os.path.exists(path):
            return {"ok": False, "error": f"archivo no encontrado: {path}"}
        if not self.can_play:
            return {"ok": False, "error": "sin reproductor de audio (instala alsa-utils / mpg123)"}
        try:
            self._q.put_nowait(("file", path))
        except queue.Full:
            return {"ok": False, "error": "cola de audio llena"}
        return {"ok": True, "file": os.path.basename(path)}

    def status(self):
        return {"available": self.available, "engine": self.engine, "lang": VOICE_LANG,
                "players": self._players(), "audio_dev": AUDIO_DEV or "(default)",
                "pulse": bool(os.environ.get("XDG_RUNTIME_DIR")),
                "last": self.last, "last_error": self.last_error}

    # -- interno ------------------------------------------------------------
    def _worker(self):
        while True:
            kind, arg = self._q.get()
            try:
                self._speak(arg) if kind == "say" else self._play_file(arg)
            except Exception as e:
                self.last_error = str(e)
                print(f"[voice] error reproduciendo audio: {e}")

    def _aplay(self):
        return ["aplay", "-q"] + (["-D", AUDIO_DEV] if AUDIO_DEV else [])

    def _run(self, cmd, **kw):
        subprocess.run(cmd, check=False, timeout=30, **kw)

    def _speak(self, text):
        base = [self.engine, "-v", VOICE_LANG, "-s", VOICE_SPEED]
        if _has("aplay"):                    # espeak -> WAV por stdout -> aplay (respeta AUDIO_DEV)
            p = subprocess.Popen(base + ["--stdout", text], stdout=subprocess.PIPE)
            self._run(self._aplay(), stdin=p.stdout)
            if p.stdout:
                p.stdout.close()
            p.wait(timeout=30)
        elif _has("paplay"):
            p = subprocess.Popen(base + ["--stdout", text], stdout=subprocess.PIPE)
            self._run(["paplay"], stdin=p.stdout)
            if p.stdout:
                p.stdout.close()
            p.wait(timeout=30)
        else:
            self._run(base + [text])         # espeak toca solo por ALSA

    def _play_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".wav" and _has("aplay"):
            self._run(self._aplay() + [path]); return
        for name, cmd in (("ffplay", ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]),
                          ("mpg123", ["mpg123", "-q", path]),
                          ("paplay", ["paplay", path]),
                          ("aplay", self._aplay() + [path])):
            if _has(name):
                self._run(cmd); return
        self.last_error = f"sin reproductor para {ext} (instala mpg123 o convierte a .wav)"


# instancia global
voice = Voice()
