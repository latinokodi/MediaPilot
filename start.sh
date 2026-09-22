#!/usr/bin/env bash
# Lanzador de MediaPilot para Linux/macOS: instala lo que falte, compila y arranca la app.
# Para una máquina sin escritorio usa el modo servidor web:  npm run server
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  MediaPilot"
echo "  =========="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] No se encontró Node.js. Instálalo (versión LTS) desde https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  [1/4] Instalando dependencias (solo la primera vez, tarda un poco)..."
  npm install
else
  echo "  [1/4] Dependencias: ya instaladas."
fi

if [ ! -f dist/index.html ]; then
  echo "  [2/4] Compilando MediaPilot..."
  npm run build
else
  echo "  [2/4] Compilado. Si actualizaste el código, borra dist/ para recompilar."
fi

if [ ! -f electron/qbit-runner.exe ]; then
  echo "  [3/4] Aviso: faltan los motores de búsqueda (electron/qbit-runner.exe)."
  echo "        La app arranca, pero la búsqueda no dará resultados hasta que los generes"
  echo "        con:  npm run pyinstaller   (requiere Python y pyinstaller)"
else
  echo "  [3/4] Motores de búsqueda: listos."
fi

echo "  [4/4] Arrancando..."
echo
exec npm start
