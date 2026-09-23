#!/usr/bin/env bash
# Lanzador de MediaPilot para Linux/macOS: comprueba las dependencias, instala
# lo que falte (con permiso), prepara la app y la arranca.
#
#   ./start.sh            arranca la app (en una máquina sin escritorio, el
#                         servidor web; con escritorio, Electron)
#   ./start.sh --check    solo comprueba las dependencias
#   ./start.sh --yes      instala lo que falte sin preguntar
set -uo pipefail
cd "$(dirname "$0")"

SOLO_COMPROBAR=0
SIN_PREGUNTAR=0
for arg in "$@"; do
  case "$arg" in
    --check) SOLO_COMPROBAR=1 ;;
    --yes|-y) SIN_PREGUNTAR=1 ;;
  esac
done

echo
echo "  MediaPilot"
echo "  =========="
echo
[ "$SOLO_COMPROBAR" = 1 ] && echo "  Modo comprobación: solo revisa las dependencias." && echo

FALTAN=()

hay() { command -v "$1" >/dev/null 2>&1; }

# ── Gestor de paquetes, para saber qué decir o ejecutar ──────────────────────
GESTOR=""
for g in apt-get dnf pacman zypper brew; do
  if hay "$g"; then GESTOR="$g"; break; fi
done

comando_para() {
  case "$GESTOR" in
    apt-get) echo "sudo apt-get install -y $1" ;;
    dnf)     echo "sudo dnf install -y $1" ;;
    pacman)  echo "sudo pacman -S --needed --noconfirm $1" ;;
    zypper)  echo "sudo zypper install -y $1" ;;
    brew)    echo "brew install $1" ;;
    *)       echo "" ;;
  esac
}

paquete_para() {
  case "$1" in
    node) case "$GESTOR" in apt-get) echo "nodejs npm" ;; *) echo "nodejs npm" ;; esac ;;
    python*) echo "python3 python3-pip" ;;
    ffmpeg) echo "ffmpeg" ;;
  esac
}

# ── 1/4 · Node.js ────────────────────────────────────────────────────────────
echo "  [1/4] Node.js"
if hay node; then
  echo "        instalado: $(node --version)"
else
  echo "        no está instalado."
  FALTAN+=("node")
fi

# ── 2/4 · Python ─────────────────────────────────────────────────────────────
echo "  [2/4] Python"
PY=""
if hay python3; then PY="python3"; elif hay python; then PY="python"; fi
if [ -n "$PY" ]; then
  echo "        instalado: $($PY --version 2>&1)"
else
  echo "        no está instalado."
  FALTAN+=("python3")
fi

# ── 3/4 · FFmpeg (opcional) ──────────────────────────────────────────────────
echo "  [3/4] FFmpeg (opcional)"
if hay ffmpeg; then
  echo "        instalado."
else
  echo "        no está instalado. Se usa para ordenar las pistas de audio y para"
  echo "        comprobar la duración antes de descargar."
  FALTAN+=("ffmpeg")
fi

# ── Instalación de lo que falte ──────────────────────────────────────────────
if [ ${#FALTAN[@]} -gt 0 ]; then
  echo
  echo "  Falta: ${FALTAN[*]}"
  if [ -n "$GESTOR" ]; then
    PAQUETES=""
    for f in "${FALTAN[@]}"; do PAQUETES="$PAQUETES $(paquete_para "$f")"; done
    ORDEN="$(comando_para "$(echo $PAQUETES | xargs)")"
    echo "  Se instalaría con: $ORDEN"
    INSTALAR=0
    if [ "$SIN_PREGUNTAR" = 1 ]; then
      INSTALAR=1
    elif [ -t 0 ]; then
      read -r -p "  ¿Instalarlo ahora? [s/N] " resp
      case "$resp" in [sSyY]) INSTALAR=1 ;; esac
    fi
    if [ "$INSTALAR" = 1 ]; then
      echo
      eval "$ORDEN"
      hash -r
      for f in "${FALTAN[@]}"; do haya=0; hay "$f" && haya=1; done
    fi
  else
    echo "  No reconozco el gestor de paquetes: instálalos a mano con los enlaces de"
    echo "  https://github.com/latinokodi/MediaPilot#requisitos"
  fi
  # lo imprescindible es Node y Python: sin ellos no se puede seguir
  if ! hay node || { ! hay python3 && ! hay python; }; then
    echo
    echo "  [!] Sin Node.js y Python no se puede preparar la aplicación."
    exit 1
  fi
fi

# ── 4/4 · La aplicación ──────────────────────────────────────────────────────
echo
echo "  [4/4] MediaPilot"
if [ "$SOLO_COMPROBAR" = 1 ]; then
  echo "        Todo listo. Ejecuta ./start.sh para arrancar la aplicación."
  echo
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "        instalando dependencias (solo la primera vez, tarda unos minutos)..."
  npm install || { echo "  [!] Falló npm install."; exit 1; }
else
  echo "        dependencias: ya instaladas."
fi

if [ ! -f dist/index.html ]; then
  echo "        compilando..."
  npm run build || { echo "  [!] Falló la compilación."; exit 1; }
else
  echo "        compilado. Si actualizaste el código, borra dist/ para recompilar."
fi

# Sin escritorio (servidor, SSH) la app va en modo servidor web; con escritorio,
# en Electron. En el servidor web el puerto se cambia con TDP_PORT.
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "        sin escritorio detectado: modo servidor web en http://127.0.0.1:${TDP_PORT:-9650}"
  echo
  # npm run server compila la interfaz y el servidor antes de arrancarlo
  exec npm run server
fi

echo "        arrancando..."
echo
exec npm start
