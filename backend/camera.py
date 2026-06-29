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
import threading
import time

try:
    import cv2
    _HAS_CV2 = True
except Exception as e:
    # ImportError (sin cv2, ej. en la PC) o AttributeError (cv2 vs NumPy 2.x en el Jetson)
    _HAS_CV2 = False
    print(f"[camera] OpenCV (cv2) no disponible -> camara desactivada ({type(e).__name__})")


def gst_pipeline(sensor_id=0, width=1280, height=720, fps=30, flip=0):
    """Pipeline GStreamer hacia appsink en formato BGR (lo que espera OpenCV)."""
    return (
        f"nvarguscamerasrc sensor-id={sensor_id} ! "
        f"video/x-raw(memory:NVMM),width={width},height={height},framerate={fps}/1 ! "
        f"nvvidconv flip-method={flip} ! "
        f"video/x-raw,format=BGRx ! videoconvert ! video/x-raw,format=BGR ! "
        f"appsink drop=true max-buffers=1 sync=false"
    )


class Camera:
    def __init__(self, sensor_id=0, jpeg_quality=80):
        self.sensor_id = sensor_id
        self.jpeg_quality = jpeg_quality
        self.cap = None
        self.lock = threading.Lock()
        if _HAS_CV2:
            self._open()

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
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            if ok:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                       + jpg.tobytes() + b"\r\n")


# instancia global
camera = Camera()
