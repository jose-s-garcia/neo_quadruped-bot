#!/usr/bin/env bash
# =============================================================================
#  Despliega la ultima version: git pull + reinicio del servicio.
#  Correlo cuando TU quieras actualizar (no en cada arranque):
#     bash ~/Documents/NEO_QUADRUPED/neo_quadruped-bot/deploy/update.sh
# =============================================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"     # raiz del repo (contiene backend/ frontend/ deploy/)

echo "==> git pull --ff-only  ($REPO)"
git -C "$REPO" pull --ff-only

echo "==> reiniciando el servicio"
sudo systemctl restart neo-dashboard

sudo systemctl --no-pager --lines=0 status neo-dashboard || true
echo "==> listo. Logs en vivo:  journalctl -u neo-dashboard -f"
