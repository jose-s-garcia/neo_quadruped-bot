# NEO - CUADRÚPEDO EDUCATIVO · Centro de Comando

Dashboard web para controlar el robot cuadrúpedo NEO, como **herramienta educativa**
para tres niveles: **Inicial**, **Secundaria** y **Superior**.

Corre en el **Jetson Orin Nano**; los comandos viajan por **serial (USB) al ESP32**.

## Stack

- **Backend:** FastAPI (Python) — API REST + WebSocket de telemetría, sirve el frontend.
- **Frontend:** JS vanilla (ES modules) + CSS propio (tema futurista minimalista).
- **Bloques tipo Scratch:** Blockly (por integrar).
- **Joystick:** nippleJS · **Cámara:** IMX477 (MJPEG) · **LIDAR:** RPLIDAR C1 (WebSocket).

## Estructura

```
NEO_dashboard/
├── backend/
│   ├── main.py          # FastAPI: rutas /api/*, WebSocket /ws/telemetry
│   ├── robot.py         # Puente serial al ESP32 (clase Robot)
│   └── requirements.txt
└── frontend/
    ├── index.html       # Shell del dashboard (topbar + sidebar + contenido)
    ├── css/style.css     # Tema futurista minimalista
    └── js/
        ├── api.js        # Cliente de la API
        └── app.js        # Router + telemetría + render de módulos
```

## Módulos por nivel

### Inicial (causa-efecto, juego, secuencias)
| Módulo | Qué hace | Sensores |
|--------|----------|----------|
| Maneja al robot | Joystick/flechas + ver cámara | Cámara |
| Bloques | Editor Scratch-like (adelante, girar, esperar, repetir) | — |
| Trucos | Animaciones pre-armadas | — |

### Secundaria (sensores, geometría, algoritmos)
| Módulo | Qué hace | Sensores |
|--------|----------|----------|
| Bloques + sensores | Blockly con bucles/condicionales y bloques de sensor | LIDAR |
| Radar LIDAR | Escaneo 2D en vivo, obstáculos | LIDAR |
| Geometría IK | Ángulos coxa/fémur/tibia en vivo → trigonometría | — |

### Superior (robótica real)
| Módulo | Qué hace | Sensores |
|--------|----------|----------|
| Visión | OpenCV: tracking de color / detección de objetos | Cámara |
| SLAM | Mapa 2D + navegación | LIDAR |
| API | Controlar el robot por código (docs en `/docs`) | — |

## Correr en el Jetson

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
# puerto serial distinto:  python -m uvicorn main:app --host 0.0.0.0 --port 8000  (robot.py toma /dev/ttyUSB0)
```
Abrir desde cualquier dispositivo en la misma WiFi: `http://<IP_DEL_JETSON>:8000`
Docs interactivas de la API: `http://<IP_DEL_JETSON>:8000/docs`

## Probar en Windows (sin robot)

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn main:app --host 0.0.0.0 --port 8000
```
El serial fallará (no hay `/dev/ttyUSB0`) pero el dashboard carga igual. Abrir `http://localhost:8000`.

## Estado

- [x] Esqueleto backend + frontend + control (dashboard, manejo, telemetría)
- [ ] Cámara (driver Arducam + stream)
- [ ] LIDAR (radar 2D)
- [ ] Blockly (bloques)
- [ ] Geometría IK / Visión / SLAM
