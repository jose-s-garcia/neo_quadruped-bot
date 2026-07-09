# Arranque automático del dashboard NEO en el Jetson

Hace que el dashboard se levante **solo al encender** el Jetson, headless (sin
iniciar sesión, sin pantalla), y se **reinicie solo** si se cae.

## Instalar (una sola vez)

```bash
cd ~/Documents/NEO_QUADRUPED/neo_quadruped-bot/deploy
bash install_autostart.sh
sudo reboot          # para que aplique el grupo 'dialout' (acceso al serial)
```

El instalador **detecta solo** los puertos del ESP32 y del LIDAR por `by-id`,
rellena la plantilla del servicio y lo habilita. Al terminar te dice la URL
(`http://<IP-del-Jetson>:8000`).

## Comandos útiles

```bash
sudo systemctl status neo-dashboard     # ¿está corriendo?
journalctl -u neo-dashboard -f          # logs en vivo (los mismos que veías en la terminal)
sudo systemctl restart neo-dashboard    # reiniciar tras un git pull
sudo systemctl stop neo-dashboard       # parar
sudo systemctl disable neo-dashboard    # que NO arranque al encender
```

## Actualizar el código

Cuando **tú** quieras desplegar la última versión (no en cada arranque):

```bash
bash ~/Documents/NEO_QUADRUPED/neo_quadruped-bot/deploy/update.sh
```

Hace `git pull --ff-only` + reinicia el servicio.

### ¿Y hacer `git pull` solo, en cada arranque?

**No lo recomiendo por defecto** en un robot de tesis:

- Si el Jetson enciende **sin internet** (p. ej. el día de la defensa), un pull
  puede colgarse/fallar y retrasar o impedir que arranque el dashboard.
- Pierdes **determinismo**: quieres correr el código probado, no lo que haya en
  `main` en ese momento.
- Un working tree sucio o un cambio que necesite `pip install` puede romper el
  arranque.

Si aun así lo quieres, en `neo-dashboard.service` hay una línea `ExecStartPre`
**comentada** y blindada (`-` ignora fallos, `timeout 25` evita cuelgues,
`--ff-only` evita conflictos). Descoméntala y corre:

```bash
sudo systemctl daemon-reload
```

## ¿Con entorno virtual (venv)?

```bash
PYTHON=/ruta/al/venv/bin/python bash install_autostart.sh
```

## Sonido de arranque y voz (TTS)

Al levantarse el servicio suena un **chime** (cuando el dashboard ya responde),
para saber que arrancó bien. Lo reproduce `announce.sh` en segundo plano.

Para que NEO **hable** (botón "NEO habla" en el Dashboard, y saludo opcional al
arrancar) instala el motor de voz:

```bash
sudo apt install espeak-ng
```

Audio del Jetson: el Orin Nano **no trae jack 3.5mm**, usa un **altavoz USB** o
audio por **HDMI**. Comprueba y elige la tarjeta:

```bash
aplay -l                       # lista las tarjetas de audio
aplay deploy/ready.wav         # prueba el chime
```

Si el sonido sale por la tarjeta equivocada, fíjala con la variable `AUDIO_DEV`
(número de tarjeta de `aplay -l`) en el servicio:

```bash
sudo systemctl edit neo-dashboard
# pega, ajustando el numero:
#   [Service]
#   Environment=AUDIO_DEV=plughw:1,0
sudo systemctl restart neo-dashboard
```

¿Voz más natural? Se puede cambiar espeak-ng por **Piper** (TTS neural offline,
con voces en español). Pídemelo y lo integro.

## ¿Hay que quitar la clave del usuario?

**No.** El servicio corre **sin que nadie inicie sesión**, así que el arranque ya
es automático **con la clave puesta**. Quitar la clave solo debilita la seguridad
del robot (expone un servidor web en la WiFi). Si lo que molesta es teclear la
clave al entrar por SSH, usa **llaves SSH** (login sin clave, pero seguro):

```bash
# en TU PC (una vez):
ssh-keygen -t ed25519            # si no tienes llave
ssh-copy-id uvmjetson@<IP>       # copia tu llave publica al Jetson
# a partir de ahora entras sin teclear la clave, y la cuenta sigue protegida
```
