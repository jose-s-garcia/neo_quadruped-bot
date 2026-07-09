"""
camera.py - Captura de la camara IMX477 (Arducam) en el Jetson via GStreamer,
expuesta como stream MJPEG para el dashboard.

Pipeline: nvarguscamerasrc -> appsink (BGR) para que OpenCV lea los frames.
Si cv2 o la camara no estan disponibles (ej. probando en la PC), se desactiva
de forma limpia y el servidor sigue corriendo igual.

Nota sobre resolucion: 1920x1080@60 (lo que usas con nveglglessink) es ideal para
PANTALLA local. Para STREAM web por MJPEG conviene bajar a 1280x720@30: misma
fluidez visual con mucho menos ancho de banda. Ajustable abajo.
"""
import os
import threading
import time

try:
    import cv2
    import numpy as np
    _HAS_CV2 = True
except Exception as e:
    # ImportError (sin cv2, ej. en la PC) o AttributeError (cv2 vs NumPy 2.x en el Jetson)
    _HAS_CV2 = False
    print(f"[camera] OpenCV (cv2) no disponible -> camara desactivada ({type(e).__name__})")


# Tope de exposicion (ns) para congelar el motion blur cuando el robot camina.
#   4_000_000 ns = 4 ms = 1/250 s  -> buen punto de partida con luz decente.
#   Baja a 2_000_000 (1/500) o 1_000_000 (1/1000) si sigue borroso al moverse.
#   Si la imagen queda oscura: mas luz en la sala, o sube MAX_GAIN.
MAX_EXPOSURE_NS = 4_000_000
MAX_GAIN = 16


def gst_pipeline(sensor_id=0, width=1280, height=720, fps=30, flip=0,
                 max_exposure_ns=MAX_EXPOSURE_NS, max_gain=MAX_GAIN):
    """Pipeline GStreamer hacia appsink en formato BGR (lo que espera OpenCV).

    exposuretimerange topa la exposicion para que el auto-exposure NO use tiempos
    largos (que emborronan el movimiento). gainrange/ispdigitalgainrange dejan
    subir la ganancia para compensar el brillo que se pierde al exponer menos.
    """
    return (
        f"nvarguscamerasrc sensor-id={sensor_id} "
        f'exposuretimerange="13000 {max_exposure_ns}" '
        f'gainrange="1 {max_gain}" ispdigitalgainrange="1 8" ! '
        f"video/x-raw(memory:NVMM),width={width},height={height},framerate={fps}/1 ! "
        f"nvvidconv flip-method={flip} ! "
        f"video/x-raw,format=BGRx ! videoconvert ! video/x-raw,format=BGR ! "
        f"appsink drop=true max-buffers=1 sync=false"
    )


class Stabilizer:
    """EIS (estabilizacion digital) en tiempo real, solo con OpenCV.

    Estima el movimiento entre frames (features + flujo optico), suaviza la
    trayectoria con un EMA causal (sin frames futuros -> sirve en vivo) y compensa
    con warpAffine + un leve zoom para tapar los bordes.
    OJO: corrige temblor frame-a-frame; NO deshace el 'jello' de rolling shutter
    (para eso, montaje anti-vibracion).
    """
    def __init__(self, smoothing=0.88, zoom=1.06, proc_scale=0.5, max_corners=200):
        self.smoothing = smoothing      # 0.8-0.95: mas alto = mas estable pero mas "flota"
        self.zoom = zoom                # recorte para tapar bordes (1.06 = ~6% menos FOV)
        self.proc_scale = proc_scale    # trackea en resolucion reducida = menos CPU
        self.max_corners = max_corners
        self.prev_gray = None
        self.traj = np.zeros(3)         # trayectoria cruda acumulada (x, y, angulo)
        self.smooth = np.zeros(3)       # trayectoria suavizada

    def reset(self):
        self.prev_gray = None
        self.traj[:] = 0
        self.smooth[:] = 0

    def apply(self, frame):
        h, w = frame.shape[:2]
        small = cv2.resize(frame, None, fx=self.proc_scale, fy=self.proc_scale)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        if self.prev_gray is None:
            self.prev_gray = gray
            return frame

        dx = dy = da = 0.0
        prev_pts = cv2.goodFeaturesToTrack(self.prev_gray, self.max_corners, 0.01, 15, blockSize=3)
        if prev_pts is not None:
            cur_pts, st, _ = cv2.calcOpticalFlowPyrLK(self.prev_gray, gray, prev_pts, None)
            if cur_pts is not None:
                st = st.reshape(-1).astype(bool)
                gp, gc = prev_pts[st], cur_pts[st]
                if len(gp) >= 6:
                    m, _ = cv2.estimateAffinePartial2D(gp, gc)
                    if m is not None:
                        dx = m[0, 2] / self.proc_scale
                        dy = m[1, 2] / self.proc_scale
                        da = np.arctan2(m[1, 0], m[0, 0])
        self.prev_gray = gray

        # acumula la trayectoria cruda y sacale una version suave (EMA)
        self.traj += (dx, dy, da)
        self.smooth = self.smoothing * self.smooth + (1 - self.smoothing) * self.traj
        cx, cy, ca = self.smooth - self.traj    # cuanto corregir para llegar a lo suave

        # limita la correccion al margen del zoom para no dejar bordes negros
        mx, my = w * (self.zoom - 1) / 2, h * (self.zoom - 1) / 2
        cx = float(np.clip(cx, -mx, mx))
        cy = float(np.clip(cy, -my, my))

        M = cv2.getRotationMatrix2D((w / 2, h / 2), np.degrees(ca), 1.0)
        M[0, 2] += cx
        M[1, 2] += cy
        out = cv2.warpAffine(frame, M, (w, h))

        # zoom central para esconder el borde que deja la compensacion
        cw, ch = int(w / self.zoom), int(h / self.zoom)
        x0, y0 = (w - cw) // 2, (h - ch) // 2
        return cv2.resize(out[y0:y0 + ch, x0:x0 + cw], (w, h))


class Vision:
    """Vision por computador sobre el frame.

    Capas (encendibles por separado):
      - COLORES: umbraliza en HSV. Rangos afinados: minimos de saturacion/valor mas
        altos para que los grises/blancos NO se cuelen como "azul" (el sesgo tipico
        del auto-white-balance).
      - OBJETOS (IA): red neuronal YOLOv4-tiny (COCO, 80 clases) via cv2.dnn.
        Detecta VARIAS cosas a la vez (persona + telefono + botella...). Si los
        archivos del modelo no estan en backend/models/, cae a HOG (solo personas).
      - FILTROS de laboratorio (nivel superior): bordes (Canny), contornos, gris,
        termica (mapa de color) y movimiento (resta de cuadros).
    """
    # Rangos HSV (OpenCV: H 0-179, S 0-255, V 0-255). El rojo cruza el 0 -> 2 rangos.
    # S minimo alto (>=100) = solo colores VIVOS; evita que lo gris se lea "azul".
    COLORS = {
        "rojo":     [((0, 110, 90), (8, 255, 255)), ((172, 110, 90), (179, 255, 255))],
        "naranja":  [((9, 120, 110), (20, 255, 255))],
        "amarillo": [((21, 100, 110), (33, 255, 255))],
        "verde":    [((38, 80, 70), (85, 255, 255))],
        "azul":     [((95, 110, 70), (126, 255, 255))],
        "violeta":  [((127, 70, 70), (158, 255, 255))],
    }
    DRAW = {"rojo": (60, 60, 255), "naranja": (0, 140, 255), "amarillo": (0, 220, 220),
            "verde": (0, 220, 0), "azul": (255, 150, 0), "violeta": (200, 0, 200)}

    # Las 80 clases COCO en espanol SIN acentos (cv2.putText solo dibuja ASCII)
    COCO_ES = [
        "persona", "bicicleta", "auto", "moto", "avion", "bus", "tren", "camion", "bote", "semaforo",
        "hidrante", "senal de alto", "parquimetro", "banca", "pajaro", "gato", "perro", "caballo", "oveja", "vaca",
        "elefante", "oso", "cebra", "jirafa", "mochila", "paraguas", "bolso", "corbata", "maleta", "frisbee",
        "esquis", "snowboard", "pelota", "cometa", "bate", "guante", "patineta", "tabla de surf", "raqueta", "botella",
        "copa", "taza", "tenedor", "cuchillo", "cuchara", "tazon", "banana", "manzana", "sandwich", "naranja",
        "brocoli", "zanahoria", "hot dog", "pizza", "dona", "pastel", "silla", "sofa", "planta", "cama",
        "mesa", "inodoro", "televisor", "laptop", "mouse", "control remoto", "teclado", "telefono", "microondas", "horno",
        "tostadora", "lavabo", "refrigerador", "libro", "reloj", "florero", "tijeras", "peluche", "secador", "cepillo",
    ]
    FILTERS = ("normal", "bordes", "contornos", "gris", "termica", "movimiento")
    # --- tracker (arregla el parpadeo, da ID a cada objeto y permite seguir) ---
    CONF_MIN = 0.35        # umbral YOLO (bajo, para no perder al objeto en cuadros dificiles)
    IOU_MATCH = 0.3        # solape minimo para considerar "el mismo objeto" entre cuadros
    MAX_MISSES = 6         # pases de deteccion que un objeto sobrevive sin verse (anti-parpadeo)
    MIN_HITS = 2           # veces visto para confirmarlo (evita destellos falsos)

    def __init__(self, min_area=1200):
        self.colors_on = False
        self.objects_on = False
        self.filter = "normal"
        self.min_area = min_area          # ignora manchas de color mas chicas que esto (px)
        self._hog = None
        self._net = None
        self._out_names = None
        self.dnn_ok = False
        self._frame_i = 0
        self._prev_motion = None
        self._wh = (1, 1)                 # tamano del ultimo frame (para normalizar el objetivo)
        self.tracks = []                  # {id,label,box:[x,y,w,h],conf,hits,misses}
        self._next_id = 1
        self.target_id = None             # id del objeto que se sigue/resalta
        self.follow_on = False
        self.counts = {"objetos": 0, "colores": 0}
        self.detections = []              # [{id,label,conf}] para el frontend
        self._load_dnn()

    @property
    def active(self):
        return self.colors_on or self.objects_on or self.filter != "normal"

    # -- red neuronal (YOLOv4-tiny) ---------------------------------------
    def _load_dnn(self):
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
        cfg, weights = os.path.join(base, "yolov4-tiny.cfg"), os.path.join(base, "yolov4-tiny.weights")
        if not (os.path.exists(cfg) and os.path.exists(weights)):
            print("[vision] modelo YOLO no encontrado en backend/models/ -> "
                  "'Objetos' usara HOG (solo personas). Ver backend/models/README.md")
            return
        try:
            self._net = cv2.dnn.readNetFromDarknet(cfg, weights)
            try:   # si este build de OpenCV trae CUDA, usarla; si no, CPU
                self._net.setPreferableBackend(cv2.dnn.DNN_BACKEND_CUDA)
                self._net.setPreferableTarget(cv2.dnn.DNN_TARGET_CUDA)
            except Exception:
                pass
            self._out_names = self._net.getUnconnectedOutLayersNames()
            self.dnn_ok = True
            print("[vision] YOLOv4-tiny cargado (80 clases COCO)")
        except Exception as e:
            self._net = None
            print(f"[vision] no se pudo cargar YOLO: {e}")

    @staticmethod
    def _class_color(name):
        """Color BGR estable por clase (derivado del nombre)."""
        h = sum(ord(c) for c in name) * 47 % 180
        col = cv2.cvtColor(np.uint8([[[h, 200, 255]]]), cv2.COLOR_HSV2BGR)[0][0]
        return int(col[0]), int(col[1]), int(col[2])

    def _detect_objects(self, src, out):
        """Corre la red cada 3 cuadros y ALIMENTA un tracker; dibuja cada cuadro las
        cajas suavizadas del tracker -> estables, sin parpadeo y con ID por objeto."""
        self._frame_i += 1
        self._wh = (src.shape[1], src.shape[0])
        if self._frame_i % 3 == 0:
            dets = self._run_yolo(src) if self.dnn_ok else self._run_hog(src)
            self._update_tracks(dets)
        self._draw_tracks(out)

    def _run_yolo(self, src):
        h, w = src.shape[:2]
        blob = cv2.dnn.blobFromImage(src, 1 / 255.0, (320, 320), swapRB=True, crop=False)
        self._net.setInput(blob)
        boxes, confs, ids = [], [], []
        for o in self._net.forward(self._out_names):
            for d in o:
                scores = d[5:]
                cid = int(np.argmax(scores))
                conf = float(scores[cid])
                if conf < self.CONF_MIN:
                    continue
                bw, bh = d[2] * w, d[3] * h
                boxes.append([int(d[0] * w - bw / 2), int(d[1] * h - bh / 2), int(bw), int(bh)])
                confs.append(conf)
                ids.append(cid)
        keep = cv2.dnn.NMSBoxes(boxes, confs, self.CONF_MIN, 0.4)
        keep = np.array(keep).flatten() if len(keep) else []
        return [(boxes[i], self.COCO_ES[ids[i]], confs[i]) for i in keep]

    def _run_hog(self, src):
        if self._hog is None:
            self._hog = cv2.HOGDescriptor()
            self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        scale = 640.0 / src.shape[1] if src.shape[1] > 640 else 1.0
        small = cv2.resize(src, None, fx=scale, fy=scale) if scale < 1 else src
        rects, _ = self._hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
        return [([int(x / scale), int(y / scale), int(w / scale), int(h / scale)], "persona", 0.5)
                for (x, y, w, h) in rects]

    @staticmethod
    def _iou(a, b):
        ax, ay, aw, ah = a; bx, by, bw, bh = b
        x1, y1, x2, y2 = max(ax, bx), max(ay, by), min(ax + aw, bx + bw), min(ay + ah, by + bh)
        inter = max(0, x2 - x1) * max(0, y2 - y1)
        union = aw * ah + bw * bh - inter
        return inter / union if union > 0 else 0.0

    def _update_tracks(self, dets):
        # empareja detecciones con tracks por IoU (greedy, mayor solape primero)
        pairs = sorted(((self._iou(t["box"], d[0]), ti, di)
                        for ti, t in enumerate(self.tracks) for di, d in enumerate(dets)),
                       reverse=True)
        mt, md = set(), set()
        for iou, ti, di in pairs:
            if iou < self.IOU_MATCH or ti in mt or di in md:
                continue
            box, label, conf = dets[di]
            t = self.tracks[ti]
            t["box"] = [int(0.5 * o + 0.5 * n) for o, n in zip(t["box"], box)]   # EMA anti-jitter
            t["label"], t["conf"] = label, conf
            t["hits"] += 1; t["misses"] = 0
            mt.add(ti); md.add(di)
        for di, (box, label, conf) in enumerate(dets):        # detecciones nuevas -> track nuevo
            if di not in md:
                self.tracks.append({"id": self._next_id, "label": label, "box": list(box),
                                    "conf": conf, "hits": 1, "misses": 0})
                self._next_id += 1
        for ti, t in enumerate(self.tracks):                  # tracks no vistos -> envejecen
            if ti not in mt:
                t["misses"] += 1
        self.tracks = [t for t in self.tracks if t["misses"] <= self.MAX_MISSES]
        conf_tracks = [t for t in self.tracks if t["hits"] >= self.MIN_HITS]
        self.detections = [{"id": t["id"], "label": t["label"], "conf": round(t["conf"], 2)} for t in conf_tracks]
        self.counts["objetos"] = len(conf_tracks)
        self._refresh_target(conf_tracks)

    def _refresh_target(self, conf_tracks):
        if self.target_id in {t["id"] for t in conf_tracks}:
            return                                            # el objetivo sigue vivo
        if self.follow_on and conf_tracks:                    # perdido y seguimos -> re-elige
            persons = [t for t in conf_tracks if t["label"] == "persona"] or conf_tracks
            self.target_id = max(persons, key=lambda t: t["box"][2] * t["box"][3])["id"]
        else:
            self.target_id = None

    def _draw_tracks(self, out):
        W, H = self._wh
        for t in self.tracks:
            if t["hits"] < self.MIN_HITS and t["misses"] > 0:
                continue
            x, y, w, h = t["box"]
            tgt = (t["id"] == self.target_id)
            col = (0, 215, 255) if tgt else self._class_color(t["label"])
            cv2.rectangle(out, (x, y), (x + w, y + h), col, 3 if tgt else 2)
            cv2.putText(out, f"{'SIGO ' if tgt else ''}{t['label']} #{t['id']} {t['conf']:.0%}",
                        (x + 2, max(y - 6, 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
            if tgt:   # linea del centro al objetivo (muestra el error de seguimiento)
                cv2.line(out, (W // 2, H // 2), (x + w // 2, y + h // 2), (0, 215, 255), 1)

    # -- objetivo / seguimiento -------------------------------------------
    def get_target(self):
        """Datos normalizados del objetivo, para el controlador de seguimiento."""
        W, H = self._wh
        for t in self.tracks:
            if t["id"] == self.target_id and t["hits"] >= self.MIN_HITS and t["misses"] == 0:
                x, y, w, h = t["box"]
                return {"id": t["id"], "cx": (x + w / 2) / W, "size": h / H, "label": t["label"]}
        return None

    def select_target_xy(self, xn, yn):
        """Elige como objetivo el track (mas pequeno) que contiene el punto (xn,yn)."""
        W, H = self._wh
        px, py = xn * W, yn * H
        for t in sorted(self.tracks, key=lambda t: t["box"][2] * t["box"][3]):
            x, y, w, h = t["box"]
            if t["hits"] >= self.MIN_HITS and x <= px <= x + w and y <= py <= y + h:
                self.target_id = t["id"]
                return t["id"]
        return None

    def cycle_target(self):
        """Pasa al siguiente objetivo confirmado (util con muchas personas)."""
        ids = [t["id"] for t in self.tracks if t["hits"] >= self.MIN_HITS]
        if not ids:
            self.target_id = None
        elif self.target_id in ids:
            self.target_id = ids[(ids.index(self.target_id) + 1) % len(ids)]
        else:
            self.target_id = ids[0]
        return self.target_id

    # -- colores ------------------------------------------------------------
    def _detect_colors(self, src, out):
        hsv = cv2.cvtColor(src, cv2.COLOR_BGR2HSV)
        found = 0
        for name, ranges in self.COLORS.items():
            mask = None
            for lo, hi in ranges:
                m = cv2.inRange(hsv, np.array(lo), np.array(hi))
                mask = m if mask is None else (mask | m)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
            cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            col = self.DRAW[name]
            for c in cnts:
                if cv2.contourArea(c) < self.min_area:
                    continue
                x, y, w, h = cv2.boundingRect(c)
                cv2.rectangle(out, (x, y), (x + w, y + h), col, 2)
                cv2.putText(out, name, (x + 2, max(y - 6, 12)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
                found += 1
        self.counts["colores"] = found

    @staticmethod
    def classify_hsv(h, s, v):
        """Nombra un pixel HSV (para el cuentagotas)."""
        if v < 45:
            return "negro"
        if s < 45:
            return "blanco" if v > 170 else "gris"
        for name, ranges in Vision.COLORS.items():
            for lo, hi in ranges:
                if lo[0] <= h <= hi[0]:
                    return name
        return "sin clasificar"

    # -- filtros de laboratorio ----------------------------------------------
    def _apply_filter(self, frame):
        f = self.filter
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if f == "bordes":
            return cv2.cvtColor(cv2.Canny(gray, 60, 140), cv2.COLOR_GRAY2BGR)
        if f == "gris":
            return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        if f == "termica":
            return cv2.applyColorMap(gray, cv2.COLORMAP_JET)
        if f == "contornos":
            cnts, _ = cv2.findContours(cv2.Canny(gray, 60, 140),
                                       cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            out = frame.copy()
            cv2.drawContours(out, cnts, -1, (80, 220, 255), 1)
            return out
        if f == "movimiento":
            g = cv2.GaussianBlur(gray, (15, 15), 0)
            if self._prev_motion is None:
                self._prev_motion = g
                return frame
            diff = cv2.absdiff(self._prev_motion, g)
            self._prev_motion = g
            _, mask = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
            mask = cv2.dilate(mask, None, iterations=2)
            tint = frame.copy()
            tint[mask > 0] = (0, 255, 120)    # verde = lo que se movio
            return cv2.addWeighted(frame, 0.55, tint, 0.45, 0)
        return frame

    def apply(self, frame):
        # el filtro genera OTRA imagen; las detecciones se calculan sobre el
        # frame ORIGINAL (colores reales) y se dibujan sobre la imagen filtrada
        out = self._apply_filter(frame) if self.filter != "normal" else frame
        if self.colors_on:
            self._detect_colors(frame, out)
        if self.objects_on:
            self._detect_objects(frame, out)
        return out


class Camera:
    def __init__(self, sensor_id=0, jpeg_quality=80, stabilize=False):
        self.sensor_id = sensor_id
        self.jpeg_quality = jpeg_quality
        self.cap = None
        self.lock = threading.Lock()
        self.stabilize_enabled = stabilize
        self.stabilizer = Stabilizer() if _HAS_CV2 else None
        self.vision = Vision() if _HAS_CV2 else None
        # la camara del robot va montada invertida -> flip-method=2 (180 grados).
        # Ajustable con CAMERA_FLIP=0 o el boton "Girar 180" del dashboard.
        self.flip = int(os.environ.get("CAMERA_FLIP", "2"))
        self.last_raw = None    # ultimo frame limpio (para el cuentagotas)
        self.last_out = None    # ultimo frame procesado (para la foto)
        if _HAS_CV2:
            self._open()

    def set_stabilize(self, on):
        """Enciende/apaga el EIS. Devuelve el estado resultante."""
        self.stabilize_enabled = bool(on)
        if self.stabilizer is not None and not self.stabilize_enabled:
            self.stabilizer.reset()
        return self.stabilize_enabled

    def set_flip(self):
        """Alterna la rotacion 180 grados y reabre el pipeline (el flip lo hace
        el hardware del Jetson via nvvidconv, asi que hay que reabrir)."""
        self.flip = 0 if self.flip else 2
        if _HAS_CV2:
            with self.lock:
                try:
                    if self.cap:
                        self.cap.release()
                except Exception:
                    pass
                self.cap = None
                self._open()
        if self.stabilizer is not None:
            self.stabilizer.reset()
        return self.flip

    def set_vision(self, colors=None, objects=None):
        """Enciende/apaga las capas de vision. Devuelve el estado resultante."""
        if self.vision is None:
            return self.vision_status()
        if colors is not None:
            self.vision.colors_on = bool(colors)
        if objects is not None:
            self.vision.objects_on = bool(objects)
        return self.vision_status()

    def set_filter(self, name):
        if self.vision is not None and name in Vision.FILTERS:
            self.vision.filter = name
            self.vision._prev_motion = None
        return self.vision_status()

    def vision_status(self):
        if self.vision is None:
            return {"colores": False, "objetos": False, "filtro": "normal",
                    "dnn": False, "disponible": False, "counts": {}, "detections": [], "target": None}
        return {"colores": self.vision.colors_on, "objetos": self.vision.objects_on,
                "filtro": self.vision.filter, "dnn": self.vision.dnn_ok,
                "disponible": True, "counts": self.vision.counts,
                "detections": self.vision.detections if self.vision.objects_on else [],
                "target": self.vision.target_id}

    def target_at(self, x, y):
        """Elige objetivo por click (coords normalizadas 0-1)."""
        return {"target": self.vision.select_target_xy(x, y)} if self.vision else {"target": None}

    def cycle_target(self):
        return {"target": self.vision.cycle_target()} if self.vision else {"target": None}

    def probe(self, x, y):
        """Cuentagotas: color en el punto (x, y) normalizado [0-1] del video."""
        f = self.last_raw
        if f is None:
            return {"ok": False, "error": "sin video activo (abre la camara primero)"}
        h, w = f.shape[:2]
        px = int(min(max(x, 0.0), 0.999) * w)
        py = int(min(max(y, 0.0), 0.999) * h)
        patch = f[max(py - 3, 0):py + 4, max(px - 3, 0):px + 4]   # media 7x7 (anti-ruido)
        b, g, r = [int(v) for v in patch.reshape(-1, 3).mean(axis=0)]
        hsv = cv2.cvtColor(np.uint8([[[b, g, r]]]), cv2.COLOR_BGR2HSV)[0][0]
        H, S, V = int(hsv[0]), int(hsv[1]), int(hsv[2])
        return {"ok": True, "hex": f"#{r:02x}{g:02x}{b:02x}", "rgb": [r, g, b],
                "hsv": [H, S, V], "nombre": Vision.classify_hsv(H, S, V)}

    def snapshot(self):
        """Guarda una foto (con las capas activas dibujadas) en captures/."""
        f = self.last_out if self.last_out is not None else self.last_raw
        if f is None:
            return {"ok": False, "error": "sin video activo (abre la camara primero)"}
        os.makedirs("captures", exist_ok=True)
        name = f"captures/foto_{int(time.time())}.jpg"
        try:
            cv2.imwrite(name, f)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "saved": name, "url": "/" + name}

    def _open(self):
        try:
            self.cap = cv2.VideoCapture(gst_pipeline(self.sensor_id, flip=self.flip),
                                        cv2.CAP_GSTREAMER)
            if self.cap.isOpened():
                print(f"[camera] camara abierta (IMX477, flip={self.flip})")
            else:
                self.cap = None
                print("[camera] no se pudo abrir el pipeline GStreamer")
        except Exception as e:
            self.cap = None
            print(f"[camera] error al abrir: {e}")

    @property
    def available(self):
        return self.cap is not None

    def mjpeg_frames(self):
        """Generador de frames JPEG para multipart/x-mixed-replace."""
        while True:
            if self.cap is None:
                time.sleep(0.5)
                continue
            with self.lock:
                ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.01)
                continue
            if self.stabilize_enabled and self.stabilizer is not None:
                try:
                    frame = self.stabilizer.apply(frame)
                except Exception as e:
                    print(f"[camera] EIS fallo, sigo sin estabilizar: {e}")
                    self.stabilize_enabled = False
            self.last_raw = frame.copy()   # frame limpio para el cuentagotas
            if self.vision is not None and self.vision.active:
                try:
                    frame = self.vision.apply(frame)
                except Exception as e:
                    print(f"[camera] vision fallo, la desactivo: {e}")
                    self.vision.colors_on = self.vision.objects_on = False
                    self.vision.filter = "normal"
            self.last_out = frame          # frame final (con capas) para la foto
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            if ok:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                       + jpg.tobytes() + b"\r\n")


# instancia global. CAMERA_STABILIZE=1 arranca con el EIS encendido.
camera = Camera(stabilize=os.environ.get("CAMERA_STABILIZE", "0") == "1")
