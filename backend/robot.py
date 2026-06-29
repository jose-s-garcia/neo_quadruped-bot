"""
robot.py - Puente serial al ESP32 del robot NEO.
Encapsula el envio de comandos (las mismas teclas que el firmware ya entiende).
"""
import sys
import threading
import time

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
        self.connect()

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


# instancia global (el puerto se puede pasar por argumento)
PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB0"
robot = Robot(port=PORT)
