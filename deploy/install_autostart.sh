#!/usr/bin/env bash
# =============================================================================
#  Instala el dashboard NEO como servicio systemd -> arranca SOLO al encender
#  el Jetson, sin que nadie inicie sesion. NO hace falta quitar la clave.
#
#  Uso:
#     cd .../neo_quadruped-bot/kangal_dashboard/deploy
#     bash install_autostart.sh
#     sudo reboot        # para que aplique el grupo 'dialout' (acceso al serial)
#
#  Con entorno virtual (venv):
#     PYTHON=/ruta/al/venv/bin/python bash install_autostart.sh
# =============================================================================
set -e

SVC=neo-dashboard.service
DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$DIR/../backend" && pwd)"
PYTHON="${PYTHON:-$(command -v python3)}"

# --- Detecta los puertos serie por 'by-id' (estables) ------------------------
# ESP32 = Silicon Labs CP2102 (sin N)   |   RPLIDAR C1 = CP2102N
BYID=/dev/serial/by-id
ROBOT_PORT=""; LIDAR_PORT=""
if [ -d "$BYID" ]; then
  r=$(ls "$BYID" 2>/dev/null | grep -i 'CP2102_'  | head -1 || true)
  l=$(ls "$BYID" 2>/dev/null | grep -i 'CP2102N'  | head -1 || true)
  [ -n "$r" ] && ROBOT_PORT="$BYID/$r"
  [ -n "$l" ] && LIDAR_PORT="$BYID/$l"
fi
[ -z "$ROBOT_PORT" ] && ROBOT_PORT=/dev/ttyUSB0
[ -z "$LIDAR_PORT" ] && LIDAR_PORT=/dev/ttyUSB1

echo "  Usuario      : $USER"
echo "  Backend      : $BACKEND"
echo "  Python       : $PYTHON"
echo "  ESP32 (ROBOT): $ROBOT_PORT"
echo "  LIDAR        : $LIDAR_PORT"
echo

# --- Sonido de arranque: genera el chime WAV ---------------------------------
python3 "$DIR/make_chime.py" "$DIR/ready.wav" || echo "  (aviso: no se pudo generar el chime)"
chmod +x "$DIR/announce.sh" || true

# --- Rellena la plantilla y la instala ---------------------------------------
tmp=$(mktemp)
sed -e "s#__USER__#$USER#g" \
    -e "s#__BACKEND__#$BACKEND#g" \
    -e "s#__PYTHON__#$PYTHON#g" \
    -e "s#__DEPLOY__#$DIR#g" \
    -e "s#__ROBOT_PORT__#$ROBOT_PORT#g" \
    -e "s#__LIDAR_PORT__#$LIDAR_PORT#g" \
    "$DIR/$SVC" > "$tmp"

sudo cp "$tmp" "/etc/systemd/system/$SVC"
rm -f "$tmp"

# Acceso al puerto serie (dialout) y al audio (audio) sin sudo -> aplica tras reiniciar
sudo usermod -aG dialout,audio "$USER"

sudo systemctl daemon-reload
sudo systemctl enable "$SVC"
sudo systemctl restart "$SVC"

echo
echo "  Servicio instalado y arrancando. Estado:"
sudo systemctl --no-pager --lines=0 status "$SVC" || true
IP=$(hostname -I | awk '{print $1}')
echo
echo "  ---------------------------------------------------------------"
echo "  Dashboard:  http://$IP:8000"
echo "  Logs:       journalctl -u $SVC -f"
echo "  Reinicia el Jetson una vez para que aplique el acceso al serial."
echo "  ---------------------------------------------------------------"
