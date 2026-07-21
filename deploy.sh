#!/bin/bash
# Auto-deploy: si hay commits nuevos en GitHub (main), los baja, reinstala
# dependencias si hicieron falta, y reinicia el servidor. Pensado para que
# cambios subidos desde OTRA sesion de Claude (ej. desde el celular, sin
# acceso SSH al servidor) se apliquen solos, sin que nadie tenga que
# conectarse a mano.
set -e
cd /root/fichero-automatico

git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" == "$REMOTE" ]; then
  exit 0
fi

echo "$(date -Iseconds) Deploy: $LOCAL -> $REMOTE"
git pull origin main
npm install --production
pm2 restart fichero-automatico
echo "$(date -Iseconds) Deploy listo."
