# Modelo de detección de objetos (YOLOv4-tiny)

La capa **🧠 Objetos (IA)** del módulo de Visión usa la red neuronal
**YOLOv4-tiny** entrenada con COCO (80 clases: persona, teléfono, botella,
laptop, silla, perro, taza…). Detecta **varios objetos a la vez** con su
porcentaje de confianza.

Sin estos archivos, la capa cae automáticamente a HOG (solo personas, mucho
menos preciso).

## Instalación (en el Jetson, una sola vez)

```bash
cd ~/Documents/NEO_QUADRUPED/neo_quadruped-bot/backend/models

# configuración de la red (~12 KB)
wget https://raw.githubusercontent.com/AlexeyAB/darknet/master/cfg/yolov4-tiny.cfg

# pesos entrenados (~23 MB)
wget https://github.com/AlexeyAB/darknet/releases/download/darknet_yolo_v4_pre/yolov4-tiny.weights
```

Reinicia el servidor. Debe aparecer en el log:

```
[vision] YOLOv4-tiny cargado (80 clases COCO)
```

## Rendimiento

- La red corre **cada 3 cuadros** a 320×320 para no frenar el video.
- Si el build de OpenCV trae CUDA se usa la GPU automáticamente; si no, CPU
  (el Orin Nano la mueve bien igual).
