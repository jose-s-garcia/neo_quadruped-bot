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
    """Vision por computador sobre el frame (solo OpenCV, sin modelos externos).

    Dos capacidades, encendibles por separado:
      - COLORES: umbraliza en espacio HSV (mas estable que RGB ante cambios de luz),
        agrupa por contornos y marca cada mancha con su color y tamano.
      - PERSONAS: detector de peatones HOG + SVM que ya trae OpenCV (cuerpo completo,
        no rostros). Es pesado, asi que corre cada pocos frames sobre una version
        reducida y reutiliza las cajas (cache) para no bajar los FPS.
    """
    # Rangos HSV (OpenCV: H 0-179, S 0-255, V 0-255). El rojo cruza el 0 -> 2 rangos.
    COLORS = {
        "rojo":     [((0, 120, 80), (10, 255, 255)), ((170, 120, 80), (179, 255, 255))],
        "naranja":  [((11, 120, 90), (22, 255, 255))],
        "amarillo": [((23, 90, 90), (33, 255, 255))],
        "verde":    [((34, 70, 60), (85, 255, 255))],
        "azul":     [((86, 90, 60), (125, 255, 255))],
        "violeta":  [((126, 60, 60), (160, 255, 255))],
    }
    DRAW = {"rojo": (60, 60, 255), "naranja": (0, 140, 255), "amarillo": (0, 220, 220),
            "verde": (0, 220, 0), "azul": (255, 150, 0), "violeta": (200, 0, 200)}

    def __init__(self, min_area=1500):
        self.colors_on = False
        self.people_on = False
        self.min_area = min_area          # ignora manchas de color mas chicas que esto (px)
        self._hog = None
        self._frame_i = 0
        self._person_boxes = []
        self.counts = {"personas": 0, "colores": 0}

    @property
    def active(self):
        return self.colors_on or self.people_on

    def _ensure_hog(self):
        if self._hog is None:
            self._hog = cv2.HOGDescriptor()
            self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        return self._hog

    def _detect_colors(self, frame):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
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
                cv2.rectangle(frame, (x, y), (x + w, y + h), col, 2)
                cv2.putText(frame, name, (x + 2, max(y - 6, 12)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
                found += 1
        self.counts["colores"] = found

    def _detect_people(self, frame):
        self._frame_i += 1
        # HOG es caro -> correrlo cada 3 frames en baja resolucion y cachear las cajas
        if self._frame_i % 3 == 0:
            scale = 640.0 / frame.shape[1] if frame.shape[1] > 640 else 1.0
            small = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
            rects, _ = self._ensure_hog().detectMultiScale(
                small, winStride=(8, 8), padding=(8, 8), scale=1.05)
            self._person_boxes = [(int(x / scale), int(y / scale),
                                   int(w / scale), int(h / scale)) for (x, y, w, h) in rects]
        for (x, y, w, h) in self._person_boxes:
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 120), 2)
            cv2.putText(frame, "persona", (x + 2, max(y - 6, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 120), 2)
        self.counts["personas"] = len(self._person_boxes)

    def apply(self, frame):
        if self.colors_on:
            self._detect_colors(frame)
        if self.people_on:
            self._detect_people(frame)
        return frame


class Camera:
    def __init__(self, sensor_id=0, jpeg_quality=80, stabilize=False):
        self.sensor_id = sensor_id
        self.jpeg_quality = jpeg_quality
        self.cap = None
        self.lock = threading.Lock()
        self.stabilize_enabled = stabilize
        self.stabilizer = Stabilizer() if _HAS_CV2 else None
        self.vision = Vision() if _HAS_CV2 else None
        if _HAS_CV2:
            self._open()

    def set_stabilize(self, on):
        """Enciende/apaga el EIS. Devuelve el estado resultante."""
        self.stabilize_enabled = bool(on)
        if self.stabilizer is not None and not self.stabilize_enabled:
            self.stabilizer.reset()
        return self.stabilize_enabled

    def set_vision(self, colors=None, people=None):
        """Enciende/apaga las capas de vision. Devuelve el estado resultante."""
        if self.vision is None:
            return {"colores": False, "personas": False, "disponible": False}
        if colors is not None:
            self.vision.colors_on = bool(colors)
        if people is not None:
            self.vision.people_on = bool(people)
        return self.vision_status()

    def vision_status(self):
        if self.vision is None:
            return {"colores": False, "personas": False, "disponible": False, "counts": {}}
        return {"colores": self.vision.colors_on, "personas": self.vision.people_on,
                "disponible": True, "counts": self.vision.counts}

    def _open(self):
        try:
            self.cap = cv2.VideoCapture(gst_pipeline(self.sensor_id), cv2.CAP_GSTREAMER)
            if self.cap.isOpened():
                print("[camera] camara abierta (IMX477)")
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
            if self.vision is not None and self.vision.active:
                try:
                    frame = self.vision.apply(frame)
                except Exception as e:
                    print(f"[camera] vision fallo, la desactivo: {e}")
                    self.vision.colors_on = self.vision.people_on = False
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            if ok:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                       + jpg.tobytes() + b"\r\n")


# instancia global. CAMERA_STABILIZE=1 arranca con el EIS encendido.
camera = Camera(stabilize=os.environ.get("CAMERA_STABILIZE", "0") == "1")
