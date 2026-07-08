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
from lidar import lidar

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


@app.post("/api/vision/{layer}", tags=["sensores"])
def api_vision(layer: str):
    """Alterna una capa de vision sobre la camara: 'color' | 'person'."""
    if camera.vision is None:
        return {"disponible": False}
    if layer == "color":
        camera.set_vision(colors=not camera.vision.colors_on)
    elif layer == "person":
        camera.set_vision(people=not camera.vision.people_on)
    return camera.vision_status()


@app.get("/api/vision/status", tags=["sensores"])
def api_vision_status():
    """Estado de las capas de vision + conteos (personas / colores detectados)."""
    return camera.vision_status()


# ===========================================================================
# LIDAR (RPLIDAR C1: escaneo 2D, objetos, distancia, tamano, velocidad)
# ===========================================================================
@app.websocket("/ws/lidar")
async def ws_lidar(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_text(json.dumps(lidar.latest()))
            await asyncio.sleep(0.1)   # ~10 Hz
    except WebSocketDisconnect:
        pass


@app.post("/api/lidar/capture", tags=["sensores"])
def api_lidar_capture():
    """Guarda una instantanea del escaneo actual (puntos + objetos)."""
    return lidar.capture()


@app.get("/api/lidar/status", tags=["sensores"])
def api_lidar_status():
    """Info del sensor: modelo, firmware, salud, tasa de escaneo, specs."""
    return lidar.status()


# ===========================================================================
# Consola serial del ESP32 (modo desarrollador)
# ===========================================================================
@app.websocket("/ws/console")
async def ws_console(ws: WebSocket):
    await ws.accept()
    last = 0
    try:
        while True:
            rows = robot.log_since(last)
            if rows:
                last = rows[-1][0]
                await ws.send_text(json.dumps({"lines": [l for _, l in rows]}))
            await asyncio.sleep(0.15)
    except WebSocketDisconnect:
        pass


# ===========================================================================
# Servir el frontend (debe ir al final para no tapar las rutas /api)
# ===========================================================================
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
