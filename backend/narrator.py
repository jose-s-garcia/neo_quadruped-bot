"""
narrator.py - NEO narra por voz lo que percibe (vision + LIDAR). Fase 2.

Habla SOLO cuando la escena cambia (o cada ~15 s), para no repetir sin parar.
Ejemplos: "Veo 2 personas y una botella. Obstaculo a 40 centimetros a la derecha".
Necesita el TTS (voice) activo; si no hay espeak, no dice nada.
"""
import threading
import time

from camera import camera
from lidar import lidar
from voice import voice

# clases COCO femeninas (para decir "una" en vez de "un")
_FEM = {"persona", "botella", "silla", "taza", "laptop", "mochila", "corbata",
        "maleta", "pelota", "raqueta", "copa", "banana", "manzana", "naranja",
        "zanahoria", "pizza", "dona", "cama", "mesa", "planta", "tijeras"}


class Narrator:
    def __init__(self):
        self.on = False
        self._last = ""
        self._last_t = 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    def set(self, on):
        self.on = bool(on)
        if self.on:
            self._last = ""          # fuerza a describir la proxima escena
        return {"narrate": self.on}

    def _loop(self):
        while True:
            if not self.on:
                time.sleep(0.5); continue
            phrase = self._describe()
            now = time.time()
            if phrase and (phrase != self._last or now - self._last_t > 15):
                voice.say(phrase)
                self._last, self._last_t = phrase, now
            time.sleep(3.5)

    def _describe(self):
        parts = []
        v = camera.vision
        if v is not None and v.objects_on and v.detections:
            counts = {}
            for d in v.detections:
                counts[d["label"]] = counts.get(d["label"], 0) + 1
            items = [self._fmt(n, lbl) for lbl, n in sorted(counts.items(), key=lambda x: -x[1])][:3]
            parts.append("Veo " + self._join(items))
        if lidar.available and lidar.objects:
            near = min(lidar.objects, key=lambda o: o["dist"])
            if near["dist"] < 900:
                cm = int(round(near["dist"] / 10))
                a = near["angle"]
                a2 = a if a <= 180 else a - 360          # -180..180, 0 = frente
                side = "al frente" if abs(a2) < 25 else ("a la derecha" if a2 > 0 else "a la izquierda")
                parts.append(f"obstaculo a {cm} centimetros {side}")
        return ". ".join(parts)

    @staticmethod
    def _fmt(n, label):
        if n == 1:
            return ("una " if label in _FEM else "un ") + label
        plural = label if label.endswith("s") else label + "s"
        return f"{n} {plural}"

    @staticmethod
    def _join(items):
        if len(items) == 1:
            return items[0]
        return ", ".join(items[:-1]) + " y " + items[-1]


narrator = Narrator()
