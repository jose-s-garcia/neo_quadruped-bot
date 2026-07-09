"""
follow.py - Seguimiento fisico: el robot se mueve para mantener CENTRADO al
objetivo del tracker de vision (la persona que sigues).

OPT-IN y conservador. Usa los MISMOS comandos que el manejo manual (move ->
teclas w/a/s/d), asi que el mapeo es el conocido y seguro. Cuando el objetivo
esta centrado, DEVUELVE la postura a neutro (no se queda inclinado); si pierde
el objetivo, deja de avanzar y se recentra.

SEGURIDAD: pruebalo primero con el robot ELEVADO (patas al aire) y en modo
caminar. Si gira hacia el lado equivocado, invierte FLIP_STEER=1.
"""
import os
import threading
import time

from camera import camera
from robot import robot

FLIP_STEER = os.environ.get("FOLLOW_FLIP_STEER", "0") == "1"   # invierte izq/der si va al reves
DEAD = 0.16          # banda muerta horizontal (|cx-0.5| < DEAD = centrado)
NEAR = 0.62          # altura de caja (fraccion) a partir de la cual esta "cerca" -> no avanzar
FAR = 0.38           # por debajo de esto esta "lejos" -> avanzar


class Follower:
    def __init__(self, interval=0.4):
        self.on = False
        self.interval = interval
        threading.Thread(target=self._loop, daemon=True).start()

    def set(self, on):
        self.on = bool(on) and camera.vision is not None
        if camera.vision is not None:
            camera.vision.follow_on = self.on
        return self.status()

    def status(self):
        tgt = camera.vision.get_target() if (self.on and camera.vision) else None
        return {"follow": self.on, "target": (tgt or {}).get("id")}

    # -- pasos de recentrado (usan robot.state, que 'move' mantiene) ----------
    def _center_roll(self):
        r = robot.state.get("roll", 1500)
        if r > 1500: robot.move("left")
        elif r < 1500: robot.move("right")

    def _center_pitch(self):
        p = robot.state.get("pitch", 1500)
        if p > 1500: robot.move("back")
        elif p < 1500: robot.move("forward")

    def _loop(self):
        while True:
            if not self.on or camera.vision is None:
                time.sleep(0.2); continue
            tgt = camera.vision.get_target()
            if tgt is None:                       # sin objetivo: no avanzar, volver a neutro
                self._center_roll(); self._center_pitch()
                time.sleep(self.interval); continue

            cx, size = tgt["cx"], tgt["size"]
            left, right = ("right", "left") if FLIP_STEER else ("left", "right")
            # 1) centrar horizontalmente
            if cx < 0.5 - DEAD:
                robot.move(left)
            elif cx > 0.5 + DEAD:
                robot.move(right)
            else:
                self._center_roll()               # centrado -> devuelve la inclinacion
            # 2) mantener distancia (por el tamano de la caja)
            if size < FAR:
                robot.move("forward")
            else:
                self._center_pitch()
            time.sleep(self.interval)


follower = Follower()
