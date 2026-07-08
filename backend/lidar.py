"""
lidar.py - RPLIDAR C1 en el Jetson con DRIVER NATIVO.

Habla el protocolo Slamtec directamente por pyserial, SIN la libreria 'rplidar'.

Por que nativo: la libreria 'rplidar' de PyPI (2020) es anterior al C1 (2024).
El C1 usa el mismo protocolo de la serie A pero el bit 'new_scan' llega con un
timing distinto -> el iter_scans() de la libreria se cuelga o tira los errores
"Descriptor length mismatch" / "too many values to unpack" (el flapping que veias).
Este driver (portado de tu lidar_test_C1_v5) hace yield por wrap-around angular
+ conteo de puntos + timeout de respaldo: robusto y estable para el C1.

Ademas del escaneo entrega informacion educativa: modelo, firmware, salud del
sensor, tasa de escaneo real (Hz), puntos por vuelta, y detecta objetos con su
tamano, distancia y velocidad radial.

Puerto por env LIDAR_PORT (default /dev/ttyUSB1; en el robot conviene un
/dev/serial/by-id/... estable). 460800 baud, alcance 12 m.
    LIDAR_PORT=/dev/serial/by-id/usb-Silicon_Labs_CP2102N_... python -m uvicorn main:app ...
"""
import json
import math
import os
import struct
import threading
import time
from collections import deque

try:
    import serial
    _HAS_SERIAL = True
except Exception as e:
    _HAS_SERIAL = False
    print(f"[lidar] pyserial no disponible -> LIDAR desactivado ({type(e).__name__})")

LIDAR_PORT = os.environ.get("LIDAR_PORT", "/dev/ttyUSB1")
LIDAR_BAUD = int(os.environ.get("LIDAR_BAUD", "460800"))
MAX_RANGE_MM = 12000        # RPLIDAR C1: alcance 12 m (objeto blanco)
MIN_RANGE_MM = int(os.environ.get("LIDAR_MIN_MM", "120"))  # ignora hits del propio chasis

# ── Protocolo RPLIDAR ──────────────────────────────────────────────────────
SYNC1, SYNC2 = 0xA5, 0x5A
CMD_STOP, CMD_RESET = 0x25, 0x40
CMD_GET_INFO, CMD_GET_HEALTH, CMD_SCAN = 0x50, 0x52, 0x20
DESCRIPTOR_LEN, INFO_LEN, HEALTH_LEN, SCAN_DATA_LEN = 7, 20, 3, 5
# El C1 a 10 Hz produce ~500 puntos/vuelta; 280 es un umbral conservador.
PUNTOS_POR_VUELTA = 280

# Ficha tecnica del C1 (para el panel educativo del frontend)
SPECS = {
    "modelo": "Slamtec RPLIDAR C1",
    "principio": "Triangulacion laser (mide angulo del reflejo, no tiempo de vuelo)",
    "baudrate": LIDAR_BAUD,
    "muestras_por_s": 5000,
    "frecuencia_giro_hz": 10,
    "resolucion_angular_deg": 0.72,
    "alcance_blanco_m": 12,
    "alcance_negro_m": 6,
    "longitud_onda_nm": 905,
}


# ══════════════════════════════════════════════════════════════════════════
#  DRIVER NATIVO C1  (portado de lidar_test_C1_v5, adaptado a 12 m)
# ══════════════════════════════════════════════════════════════════════════
class C1Driver:
    def __init__(self, port, baudrate):
        self.port = port
        self.baudrate = baudrate
        self._ser = None

    def connect(self):
        self._ser = serial.Serial(
            self.port, baudrate=self.baudrate, timeout=0.5,
            bytesize=serial.EIGHTBITS, parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE)
        self._reset()

    def disconnect(self):
        try:
            if self._ser and self._ser.is_open:
                self._send(CMD_STOP)
                time.sleep(0.1)
                self._ser.reset_input_buffer()
                self._ser.close()
        except Exception:
            pass

    def _send(self, cmd):
        self._ser.write(bytes([SYNC1, cmd]))

    def _reset(self):
        # STOP + limpiar + RESET + esperar el arranque del motor (esto es lo que
        # realinea el buffer y evita el flapping del descriptor en el C1).
        self._send(CMD_STOP)
        time.sleep(0.15)
        self._ser.reset_input_buffer()
        self._send(CMD_RESET)
        time.sleep(2.0)
        self._ser.reset_input_buffer()

    def _read_descriptor(self):
        desc = self._ser.read(DESCRIPTOR_LEN)
        if len(desc) != DESCRIPTOR_LEN:
            raise IOError(f"Descriptor incompleto ({len(desc)}/{DESCRIPTOR_LEN}b). "
                          f"Revisa el cable / que sea el C1 a {self.baudrate} baud.")
        if desc[0] != SYNC1 or desc[1] != SYNC2:
            raise IOError(f"Sync incorrecto: {desc[:2].hex()} (esperado a55a)")
        return

    def get_info(self):
        self._send(CMD_GET_INFO)
        self._ser.timeout = 2.0
        self._read_descriptor()
        raw = self._ser.read(INFO_LEN)
        self._ser.timeout = 0.5
        if len(raw) < INFO_LEN:
            raise IOError("Respuesta GET_INFO incompleta")
        return {
            "model": raw[0],
            "modelo": "C1" if raw[0] == 97 else f"0x{raw[0]:02X}",
            "firmware": f"{raw[2]}.{raw[1]}",
            "hardware": raw[3],
            "serial": raw[4:].hex().upper(),
        }

    def get_health(self):
        self._send(CMD_GET_HEALTH)
        self._ser.timeout = 2.0
        self._read_descriptor()
        raw = self._ser.read(HEALTH_LEN)
        self._ser.timeout = 0.5
        if len(raw) < HEALTH_LEN:
            raise IOError("Respuesta GET_HEALTH incompleta")
        estados = {0: "Good", 1: "Warning", 2: "Error"}
        return {"estado": estados.get(raw[0], f"Unknown({raw[0]})"),
                "codigo": struct.unpack('<H', raw[1:3])[0]}

    def iter_scans(self):
        """Genera una lista de (angulo_deg, distancia_mm) por cada vuelta completa.

        En vez de fiarse del bit new_scan (timing variable en el C1), hace yield
        cuando el angulo pasa por 0 (wrap-around) o cuando junta suficientes puntos,
        con un timeout de respaldo. Esto es lo que lo hace estable en el C1.
        """
        self._send(CMD_SCAN)
        self._ser.timeout = 2.0
        self._read_descriptor()
        self._ser.timeout = 0.1

        buf, ultimo_ang, t_yield = [], -1.0, time.time()
        while True:
            raw = self._ser.read(SCAN_DATA_LEN)
            if len(raw) < SCAN_DATA_LEN:
                if buf and (time.time() - t_yield) > 0.3:
                    yield buf
                    buf, t_yield = [], time.time()
                continue

            b0, b1 = raw[0], raw[1]
            quality = b0 >> 2
            if (b0 & 0x02) == (b1 & 0x01):     # checksum de bit del protocolo
                continue
            angle = ((b1 >> 1) | (raw[2] << 7)) / 64.0
            dist = (raw[3] | (raw[4] << 8)) / 4.0

            if ultimo_ang > 300.0 and angle < 60.0 and buf:
                yield buf
                buf, t_yield = [], time.time()
            elif len(buf) >= PUNTOS_POR_VUELTA and angle < ultimo_ang:
                yield buf
                buf, t_yield = [], time.time()

            if quality > 0 and MIN_RANGE_MM <= dist <= MAX_RANGE_MM:
                buf.append((angle, dist))
            ultimo_ang = angle


# ══════════════════════════════════════════════════════════════════════════
#  DETECCION DE OBJETOS
# ══════════════════════════════════════════════════════════════════════════
def _polar_to_xy(angle_deg, dist_mm):
    a = math.radians(angle_deg)
    return dist_mm * math.sin(a), dist_mm * math.cos(a)


def _make_object(cluster):
    """Grupo de puntos contiguos -> objeto con distancia, tamano y ancho angular."""
    n = len(cluster)
    dists = sorted(p["dist"] for p in cluster)
    angs = [p["angle"] for p in cluster]
    x0, y0 = _polar_to_xy(cluster[0]["angle"], cluster[0]["dist"])
    x1, y1 = _polar_to_xy(cluster[-1]["angle"], cluster[-1]["dist"])
    return {
        "angle": round(sum(angs) / n, 1),
        "dist": round(dists[n // 2]),                  # mediana (robusta a ruido)
        "size": round(math.hypot(x1 - x0, y1 - y0)),   # tamano aprox (mm)
        "width_deg": round(angs[-1] - angs[0], 1),
        "a0": cluster[0]["angle"], "d0": cluster[0]["dist"],
        "a1": cluster[-1]["angle"], "d1": cluster[-1]["dist"],
        "_n": n,
    }


def cluster_objects(points, gap_mm=250, gap_deg=8, min_pts=3):
    """Agrupa puntos vecinos (ordenados por angulo). Corta el grupo si el salto
    de distancia o de angulo entre dos puntos consecutivos es grande."""
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
        self.info = {}         # modelo/firmware/serial
        self.health = {}       # estado del sensor
        self.scan_hz = 0.0     # tasa de escaneo REAL medida
        self.points_per_scan = 0
        self._prev_objects = []
        self._prev_ts = 0.0
        self._scan_times = deque(maxlen=10)
        self._driver = None
        if _HAS_SERIAL:
            threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            try:
                self._driver = C1Driver(LIDAR_PORT, LIDAR_BAUD)
                self._driver.connect()
                try:
                    self.info = self._driver.get_info()
                    self.health = self._driver.get_health()
                    print(f"[lidar] {self.info.get('modelo')} fw {self.info.get('firmware')} "
                          f"salud {self.health.get('estado')} en {LIDAR_PORT}")
                except Exception as e:
                    print(f"[lidar] info/health no disponible ({e}), sigo con el escaneo")
                self.available = True
                for scan in self._driver.iter_scans():
                    self._process(scan)
            except Exception as e:
                self.available = False
                print(f"[lidar] error/desconexion: {e}; reintento en 3s")
                if self._driver:
                    self._driver.disconnect()
                time.sleep(3)

    def _process(self, scan):
        # scan: lista de (angle_deg, dist_mm) ya filtrada por el driver
        pts = [{"angle": round(a, 1), "dist": round(d)} for (a, d) in scan]
        objs = cluster_objects(pts)
        now = time.time()
        self._attach_velocity(objs, now)
        self._scan_times.append(now)
        hz = 0.0
        if len(self._scan_times) >= 2:
            span = self._scan_times[-1] - self._scan_times[0]
            if span > 0:
                hz = round((len(self._scan_times) - 1) / span, 1)
        with self.lock:
            self.points, self.objects, self.ts = pts, objs, now
            self.scan_hz, self.points_per_scan = hz, len(pts)

    def _attach_velocity(self, objs, now):
        """Velocidad radial (m/s): empareja cada objeto con el mas cercano en
        angulo del escaneo previo y mide el cambio de distancia. Negativo = se acerca."""
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
            return {"points": self.points, "objects": self.objects, "ts": self.ts,
                    "max_range": MAX_RANGE_MM, "min_range": MIN_RANGE_MM,
                    "available": self.available, "info": self.info, "health": self.health,
                    "scan_hz": self.scan_hz, "points_per_scan": self.points_per_scan,
                    "specs": SPECS}

    def status(self):
        return {"available": self.available, "info": self.info, "health": self.health,
                "scan_hz": self.scan_hz, "points_per_scan": self.points_per_scan,
                "objects": len(self.objects), "specs": SPECS, "port": LIDAR_PORT}

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
