"""
robot.py - Puente serial al ESP32 del robot NEO.
Encapsula el envio de comandos (las mismas teclas que el firmware ya entiende).
"""
import os
import threading
import time
from collections import deque

import serial

STEP = 50  # incremento de pitch/roll por tecla (coincide con main.cpp del firmware)


class Robot:
    def __init__(self, port="/dev/ttyUSB0", baud=115200):
        self.port = port
        self.baud = baud
        self.ser = None
        self.lock = threading.Lock()
        self.state = {"connected": False, "stand": False, "walking": False,
                      "pitch": 1500, "roll": 1500}
        self.log = deque(maxlen=600)   # salida serial del ESP32 (para la consola web)
        self._seq = 0
        self.connect()
        threading.Thread(target=self._reader, daemon=True).start()

    # -- conexion --------------------------------------------------------
    def connect(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=1)
            time.sleep(2)  # abrir el puerto resetea el ESP32: esperar boot
            self.state["connected"] = True
            print(f"[robot] conectado a {self.port} @ {self.baud}")
        except Exception as e:
            self.ser = None
            self.state["connected"] = False
            print(f"[robot] no se pudo abrir {self.port}: {e}  (la web igual carga)")

    def _send(self, c):
        with self.lock:
            if self.ser and self.ser.is_open:
                try:
                    self.ser.write(c.encode())
                except Exception as e:
                    print(f"[robot] error write: {e}")

    def _reader(self):
        """Lee la salida serial del ESP32 SIN bloquear, usando el MISMO lock que _send.
        pyserial no es thread-safe: leer y escribir el mismo puerto desde hilos distintos
        a la vez rompe la comunicacion. Por eso solo leemos lo que ya esta en el buffer
        (in_waiting), tomando el lock un instante, sin bloquear las escrituras."""
        buf = ""
        while True:
            if not (self.ser and self.ser.is_open):
                time.sleep(0.3); continue
            data = ""
            try:
                with self.lock:
                    n = self.ser.in_waiting
                    if n:
                        data = self.ser.read(n).decode(errors="replace")
            except Exception:
                time.sleep(0.3); continue
            if not data:
                time.sleep(0.03); continue   # nada que leer: cede CPU y suelta el lock
            buf += data
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.rstrip("\r")
                if line:
                    self._seq += 1
                    self.log.append((self._seq, line))

    def log_since(self, seq):
        """Lineas con secuencia > seq (para el stream incremental de la consola)."""
        return [(s, l) for (s, l) in list(self.log) if s > seq]

    # -- comandos de alto nivel -----------------------------------------
    def stand(self):
        self._send(" ")
        self.state["stand"] = not self.state["stand"]
        return self.state["stand"]

    def walk(self):
        self._send("1")
        self.state["walking"] = not self.state["walking"]
        return self.state["walking"]

    def gait(self):
        self._send("2")

    def move(self, direction):
        keymap = {"forward": "w", "back": "s", "left": "a", "right": "d"}
        k = keymap.get(direction)
        if not k:
            return
        self._send(k)
        if k == "w":
            self.state["pitch"] = min(2000, self.state["pitch"] + STEP)
        elif k == "s":
            self.state["pitch"] = max(1000, self.state["pitch"] - STEP)
        elif k == "d":
            self.state["roll"] = min(2000, self.state["roll"] + STEP)
        elif k == "a":
            self.state["roll"] = max(1000, self.state["roll"] - STEP)

    def stop(self):
        """Recentra pitch/roll a 1500 enviando teclas opuestas."""
        while self.state["pitch"] > 1500:
            self._send("s"); self.state["pitch"] -= STEP; time.sleep(0.02)
        while self.state["pitch"] < 1500:
            self._send("w"); self.state["pitch"] += STEP; time.sleep(0.02)
        while self.state["roll"] > 1500:
            self._send("a"); self.state["roll"] -= STEP; time.sleep(0.02)
        while self.state["roll"] < 1500:
            self._send("d"); self.state["roll"] += STEP; time.sleep(0.02)

    def raw(self, key):
        """Envia una tecla cruda al firmware (para modulos avanzados)."""
        self._send(key)


# instancia global. El puerto se toma de la variable de entorno ROBOT_PORT
# (no de sys.argv, porque bajo uvicorn argv son los argumentos de uvicorn).
#   ROBOT_PORT=/dev/ttyACM0 python -m uvicorn main:app --host 0.0.0.0 --port 8000
PORT = os.environ.get("ROBOT_PORT", "/dev/ttyUSB0")
robot = Robot(port=PORT)
