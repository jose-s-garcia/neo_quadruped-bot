"""
voice.py - Audio del robot: TTS (que NEO hable) y sonidos (ladrido, chime) por el
ALTAVOZ del Jetson.

El problema tipico: corriendo como servicio systemd NO hay sesion de PulseAudio,
asi que 'aplay default' (que pasa por Pulse) no suena aunque en la terminal si.
Solucion: probamos varias salidas EN ORDEN y nos quedamos con la primera que
funciona (codigo de salida 0):
    1) AUDIO_DEV si esta definido (fuerza una tarjeta ALSA concreta)
    2) aplay 'default' (Pulse, por si hay sesion)
    3) paplay
    4) ALSA DIRECTO a cada tarjeta de 'aplay -l' (plughw:N,0) -> no necesita Pulse

Si suena por la salida equivocada (p. ej. HDMI sin pantalla), fija la buena con
AUDIO_DEV=plughw:1,0 (numero de tarjeta de 'aplay -l').

TTS: espeak-ng (offline, espanol). Env: AUDIO_DEV, VOICE_LANG (es), VOICE_SPEED.
"""
import os
import re
import shutil
import subprocess
import tempfile
import threading
import queue

AUDIO_DEV = os.environ.get("AUDIO_DEV", "")
VOICE_LANG = os.environ.get("VOICE_LANG", "es")
VOICE_SPEED = os.environ.get("VOICE_SPEED", "155")
_NULL = subprocess.DEVNULL


def _has(cmd):
    return shutil.which(cmd) is not None


def _alsa_cards():
    """Tarjetas de reproduccion de 'aplay -l', ordenadas con USB/analogico primero
    y HDMI/NVIDIA al final (esas casi nunca tienen altavoz conectado en el robot)."""
    if not _has("aplay"):
        return []
    try:
        out = subprocess.run(["aplay", "-l"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    cards, seen = [], set()
    for m in re.finditer(r"card (\d+): \S+ \[([^\]]*)\]", out):
        num, name = int(m.group(1)), m.group(2).lower()
        if num in seen:
            continue
        seen.add(num)
        hdmi = any(k in name for k in ("hdmi", "nvidia", "tegra", "display"))
        cards.append((1 if hdmi else 0, num))
    return [num for _, num in sorted(cards)]


class Voice:
    def __init__(self):
        self.engine = "espeak-ng" if _has("espeak-ng") else ("espeak" if _has("espeak") else None)
        self.available = self.engine is not None
        self.last = ""
        self.last_ok = ""          # que salida sono la ultima vez (diagnostico)
        self.last_error = ""
        self._q = queue.Queue(maxsize=16)
        threading.Thread(target=self._worker, daemon=True).start()
        cards = _alsa_cards()
        if self.available:
            print(f"[voice] TTS listo (motor: {self.engine}); aplay/paplay: "
                  f"{[p for p in ('aplay', 'paplay') if _has(p)]}; tarjetas ALSA: {cards}")
        else:
            print("[voice] TTS NO disponible -> 'sudo apt install espeak-ng' y REINICIA el servicio")

    @property
    def can_play(self):
        return _has("aplay") or _has("paplay") or _has("ffplay") or _has("mpg123")

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
                "audio_dev": AUDIO_DEV or "(auto)", "cards": _alsa_cards(),
                "players": [p for p in ("aplay", "paplay", "ffplay", "mpg123") if _has(p)],
                "pulse": bool(os.environ.get("XDG_RUNTIME_DIR")),
                "last": self.last, "last_ok": self.last_ok, "last_error": self.last_error}

    # -- interno ------------------------------------------------------------
    def _worker(self):
        while True:
            kind, arg = self._q.get()
            try:
                self._speak(arg) if kind == "say" else self._play_file(arg)
            except Exception as e:
                self.last_error = str(e)
                print(f"[voice] error reproduciendo audio: {e}")

    def _try(self, cmd, label):
        try:
            r = subprocess.run(cmd, timeout=30, stdout=_NULL, stderr=_NULL)
            if r.returncode == 0:
                self.last_ok = label
                return True
        except Exception as e:
            self.last_error = f"{label}: {e}"
        return False

    def _play_wav(self, path):
        """Prueba salidas en orden hasta que una funcione (ver docstring del modulo)."""
        if AUDIO_DEV:
            if self._try(["aplay", "-q", "-D", AUDIO_DEV, path], f"aplay {AUDIO_DEV}"):
                return True
        if _has("aplay") and self._try(["aplay", "-q", path], "aplay default"):
            return True
        if _has("paplay") and self._try(["paplay", path], "paplay"):
            return True
        for c in _alsa_cards():                      # ALSA directo: no necesita PulseAudio
            if self._try(["aplay", "-q", "-D", f"plughw:{c},0", path], f"aplay plughw:{c},0"):
                return True
        self.last_error = "ninguna salida de audio funciono (revisa 'aplay -l' o fija AUDIO_DEV)"
        return False

    def _play_file(self, path):
        if os.path.splitext(path)[1].lower() == ".wav":
            self._play_wav(path)
            return
        for name, cmd in (("ffplay", ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]),
                          ("mpg123", ["mpg123", "-q", path])):
            if _has(name) and self._try(cmd, name):
                return
        self.last_error = "sin reproductor de mp3 (instala mpg123, o usa bark.wav)"

    def _speak(self, text):
        fd, tmp = tempfile.mkstemp(suffix=".wav")     # espeak -> WAV temporal -> misma cadena de salidas
        os.close(fd)
        try:
            subprocess.run([self.engine, "-v", VOICE_LANG, "-s", VOICE_SPEED, "-w", tmp, text],
                           timeout=30, stdout=_NULL, stderr=_NULL)
            self._play_wav(tmp)
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass


# instancia global
voice = Voice()
