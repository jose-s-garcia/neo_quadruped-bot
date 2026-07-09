#!/usr/bin/env python3
"""
Genera un 'chime' WAV de arranque usando SOLO la libreria estandar (sin numpy).
El instalador lo ejecuta una vez para crear ready.wav; luego el servicio lo
reproduce al levantarse para avisar que el dashboard esta activo.

    python3 make_chime.py ready.wav
"""
import math
import struct
import sys
import wave

RATE = 22050


def tone(freq, ms, vol=0.5, fade_ms=15):
    n = int(RATE * ms / 1000)
    fade = int(RATE * fade_ms / 1000) or 1
    out = []
    for i in range(n):
        env = min(1.0, i / fade, (n - i) / fade)     # fade in/out para que no "chasquee"
        out.append(vol * env * math.sin(2 * math.pi * freq * (i / RATE)))
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "ready.wav"
    # acorde ascendente alegre: Do - Mi - Sol - Do (octava)
    seq = tone(523, 110) + tone(659, 110) + tone(784, 110) + tone(1047, 240)
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in seq)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f"[chime] {path}  ({len(seq) / RATE:.2f}s)")


if __name__ == "__main__":
    main()
