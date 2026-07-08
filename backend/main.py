"""
main.py - Servidor FastAPI del dashboard del robot NEO.

Correr en el Jetson:
    pip install -r requirements.txt
    python -m uvicorn main:app --host 0.0.0.0 --port 8000
    # o con puerto serial distinto:  ROBOT_PORT=/dev/ttyUSB0 python ...
    # abrir:  http://<IP_DEL_JETSON>:8000
"""
import asyncio
import json
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from robot import robot
from camera import camera

app = FastAPI(title="NEO Robot API", version="0.1.0",
              description="API de control del robot cuadrupedo NEO (educativo).")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")


# ===========================================================================
# API de control  (los modulos del frontend llaman aqui)
# ===========================================================================
@app.post("/api/stand", tags=["control"])
def api_stand():
    """Alterna stand mode (pararse / sentarse)."""
    return {"ok": True, "stand": robot.stand()}


@app.post("/api/walk", tags=["control"])
def api_walk():
    """Alterna walk mode (caminar / detener)."""
    return {"ok": True, "walking": robot.walk()}


@app.post("/api/gait", tags=["control"])
def api_gait():
    """Cambia el patron de marcha (Trot -> Lateral -> Diagonal)."""
    robot.gait()
    return {"ok": True}


@app.post("/api/move/{direction}", tags=["control"])
def api_move(direction: str):
    """Mueve en una direccion: forward | back | left | right."""
    robot.move(direction)
    return {"ok": True}


@app.post("/api/stop", tags=["control"])
def api_stop():
    """Recentra el robot (lo detiene)."""
    robot.stop()
    return {"ok": True}


@app.post("/api/raw/{key}", tags=["avanzado"])
def api_raw(key: str):
    """Envia una tecla cruda al firmware (modulos avanzados / API Superior)."""
    robot.raw(key)
    return {"ok": True}


@app.get("/api/state", tags=["control"])
def api_state():
    """Estado actual del robot."""
    return JSONResponse(robot.state)


# ===========================================================================
# WebSocket de telemetria (estado en vivo para el dashboard)
# ===========================================================================
@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_text(json.dumps(robot.state))
            await asyncio.sleep(0.3)
    except WebSocketDisconnect:
        pass


# ===========================================================================
# Camara (stream MJPEG de la IMX477)
# ===========================================================================
@app.get("/api/camera", tags=["sensores"])
def api_camera():
    """Stream MJPEG de la camara. Si no hay camara, responde 503."""
    if not camera.available:
        return JSONResponse({"error": "camara no disponible"}, status_code=503)
    return StreamingResponse(camera.mjpeg_frames(),
                             media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/api/camera/stabilize", tags=["sensores"])
def api_camera_stabilize():
    """Alterna el EIS (estabilizacion digital de imagen) de la camara."""
    return {"ok": True, "stabilize": camera.set_stabilize(not camera.stabilize_enabled)}


@app.get("/api/camera/status", tags=["sensores"])
def api_camera_status():
    return {"available": camera.available, "stabilize": camera.stabilize_enabled}


# Pendiente:
# @app.websocket("/ws/lidar")    -> puntos del RPLIDAR C1 en vivo


# ===========================================================================
# Servir el frontend (debe ir al final para no tapar las rutas /api)
# ===========================================================================
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
