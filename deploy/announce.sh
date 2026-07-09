#!/usr/bin/env bash
# =============================================================================
#  Suena cuando el dashboard ya esta SIRVIENDO, para saber que el servicio
#  arranco bien. El servicio lo llama en segundo plano (ExecStartPost), asi que
#  NO retrasa el arranque. Todo va con "|| true": si no hay audio, no pasa nada.
#
#  Audio del Jetson: el Orin Nano no trae jack 3.5mm -> usa un altavoz USB o
#  audio por HDMI. Si el sonido sale por la tarjeta equivocada, fuerza una con:
#     AUDIO_DEV=plughw:1,0   (mira 'aplay -l' para el numero de tu tarjeta)
# =============================================================================
DIR="$(cd "$(dirname "$0")" && pwd)"
WAV="$DIR/ready.wav"
DEV="${AUDIO_DEV:-}"
URL="http://127.0.0.1:8000/api/state"

# Espera (max ~20s) a que el servidor responda, para que el sonido signifique
# "ya esta funcionando" y no solo "el proceso arranco".
for _ in $(seq 1 40); do
  curl -s -o /dev/null "$URL" && break
  sleep 0.5
done

play() {
  local f="$1"
  if command -v aplay  >/dev/null 2>&1; then aplay ${DEV:+-D "$DEV"} -q "$f" && return 0; fi
  if command -v paplay >/dev/null 2>&1; then paplay "$f" && return 0; fi
  if command -v ffplay >/dev/null 2>&1; then ffplay -nodisp -autoexit -loglevel quiet "$f" && return 0; fi
  return 1
}

[ -f "$WAV" ] && play "$WAV" || true

# Saludo por voz al arrancar (si espeak-ng esta instalado). Descomenta para usarlo:
# if command -v espeak-ng >/dev/null 2>&1; then
#   espeak-ng -v es -s 150 "NEO en linea" 2>/dev/null || true
# fi
exit 0
