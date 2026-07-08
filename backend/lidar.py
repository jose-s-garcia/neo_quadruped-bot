"""
lidar.py - RPLIDAR C1 en el Jetson: escaneo 2D, deteccion de objetos
(tamano + distancia), velocidad radial y captura de escaneos.

Degrada limpio si no hay LIDAR o la libreria (ej. probando en la PC): el
servidor sigue corriendo y la vista muestra "sin senal".

Puerto por env LIDAR_PORT (default /dev/ttyUSB1, porque ttyUSB0 suele ser el
ESP32). El RPLIDAR C1 usa 460800 baud y alcanza 12 m.
    pip install rplidar
    LIDAR_PORT=/dev/ttyUSB1 python -m uvicorn main:app ...
"""
import json
import math
import os
import threading
import time

LIDAR_PORT = os.environ.get("LIDAR_PORT", "/dev/ttyUSB1")
LIDAR_BAUD = int(os.environ.get("LIDAR_BAUD", "460800"))
MAX_RANGE_MM = 12000        # RPLIDAR C1: alcance 12 m
MIN_RANGE_MM = int(os.environ.get("LIDAR_MIN_MM", "120"))  # ignora hits muy cercanos (el propio robot); subir si el LIDAR ve su chasis

try:
    from rplidar import RPLidar
    _HAS_LIB = True
except Exception as e:
    _HAS_LIB = False
    print(f"[lidar] libreria 'rplidar' no disponible -> LIDAR desactivado ({type(e).__name__})")


def _polar_to_xy(angle_deg, dist_mm):
    a = math.radians(angle_deg)
    return dist_mm * math.sin(a), dist_mm * math.cos(a)


def _make_object(cluster):
    """Convierte un grupo de puntos contiguos en un 'objeto' con distancia,
    tamano (cuerda en mm entre los extremos) y ancho angular."""
    n = len(cluster)
    dists = sorted(p["dist"] for p in cluster)
    angs = [p["angle"] for p in cluster]
    x0, y0 = _polar_to_xy(cluster[0]["angle"], cluster[0]["dist"])
    x1, y1 = _polar_to_xy(cluster[-1]["angle"], cluster[-1]["dist"])
    return {
        "angle": round(sum(angs) / n, 1),
        "dist": round(dists[n // 2]),              # mediana (robusta a ruido)
        "size": round(math.hypot(x1 - x0, y1 - y0)),  # tamano aprox en mm
        "width_deg": round(angs[-1] - angs[0], 1),
        "a0": cluster[0]["angle"], "d0": cluster[0]["dist"],
        "a1": cluster[-1]["angle"], "d1": cluster[-1]["dist"],
        "_n": n,
    }


def cluster_objects(points, gap_mm=250, gap_deg=8, min_pts=3):
    """Agrupa puntos contiguos (ordenados por angulo) en objetos: si el salto de
    distancia o de angulo entre dos puntos vecinos es grande, corta el grupo."""
    if not points:
        return []
    pts = sorted(points, key=lambda p: p["angle"])
    objects, cluster = [], [pts[0]]
    for prev, cur in zip(pts, pts[1:]):
        if abs(cur["dist"] - prev["dist"]) <= gap_mm and (cur["angle"] - prev["angle"]) <= gap_deg:
            cluster.append(cur)
        else:
            objects.append(_make_object(cluster))
            cluster = [cur]
    objects.append(_make_object(cluster))
    return [o for o in objects if o["_n"] >= min_pts]


class Lidar:
    def __init__(self):
        self.lock = threading.Lock()
        self.points = []       # [{angle, dist}]
        self.objects = []      # [{angle, dist, size, width_deg, speed}]
        self.ts = 0.0
        self.available = False
        self._prev_objects = []
        self._prev_ts = 0.0
        self._dev = None
        if _HAS_LIB:
            threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            try:
                self._dev = RPLidar(LIDAR_PORT, baudrate=LIDAR_BAUD, timeout=3)
                self.available = True
                print(f"[lidar] conectado en {LIDAR_PORT} @ {LIDAR_BAUD}")
                for scan in self._dev.iter_scans(max_buf_meas=1500):
                    self._process(scan)
            except Exception as e:
                self.available = False
                print(f"[lidar] error/desconexion: {e}; reintento en 3s")
                try:
                    if self._dev:
                        self._dev.stop()
                        self._dev.disconnect()
                except Exception:
                    pass
                time.sleep(3)

    def _process(self, scan):
        # scan: lista de (quality, angle_deg, distance_mm)
        pts = [{"angle": round(a, 1), "dist": round(d)}
               for (_q, a, d) in scan if MIN_RANGE_MM <= d <= MAX_RANGE_MM]
        objs = cluster_objects(pts)
        now = time.time()
        self._attach_velocity(objs, now)
        with self.lock:
            self.points, self.objects, self.ts = pts, objs, now

    def _attach_velocity(self, objs, now):
        """Velocidad radial (m/s): empareja cada objeto con el mas cercano en
        angulo del escaneo anterior y mide el cambio de distancia. Negativo = se acerca."""
        dt = now - self._prev_ts if self._prev_ts else 0
        for o in objs:
            o["speed"] = 0.0
            if dt > 0 and self._prev_objects:
                best = min(self._prev_objects, key=lambda p: abs(p["angle"] - o["angle"]))
                if abs(best["angle"] - o["angle"]) < 15:
                    o["speed"] = round((o["dist"] - best["dist"]) / dt / 1000.0, 2)
        self._prev_objects, self._prev_ts = objs, now

    def latest(self):
        with self.lock:
            return {"points": self.points, "objects": self.objects,
                    "ts": self.ts, "max_range": MAX_RANGE_MM, "available": self.available}

    def capture(self):
        snap = self.latest()
        os.makedirs("captures", exist_ok=True)
        fname = f"captures/lidar_{int(time.time())}.json"
        try:
            with open(fname, "w") as f:
                json.dump(snap, f)
        except Exception as e:
            print(f"[lidar] no se pudo guardar la captura: {e}")
            fname = None
        snap["saved"] = fname
        snap["object_count"] = len(snap["objects"])
        return snap


# instancia global
lidar = Lidar()
