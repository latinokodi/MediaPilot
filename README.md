<p align="center">
  <img src="build/icon.png" width="110" alt="MediaPilot" />
</p>

<h1 align="center">MediaPilot</h1>
<p align="center"><strong>Descargador automático de películas y series — TorBox / Real-Debrid + proveedores latino, con la biblioteca ordenada como la espera Jellyfin</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/versi%C3%B3n-1.0.19-darkgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/licencia-MIT-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/escenarios-131-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/plataforma-Windows%20%7C%20Linux-lightgrey?style=flat-square" />
</p>

---

## Qué es

MediaPilot vigila tus series y películas y las descarga solo: busca en fuentes latino primero,
filtra la basura, manda el torrent al servicio débrid (TorBox o Real-Debrid), baja el archivo, le
pone los subtítulos y lo deja en la carpeta con el nombre exacto que Jellyfin espera.

No es un buscador de torrents con una lista de resultados: es un **monitor con criterio**. Sabe
qué episodios le faltan, en qué orden bajarlos, cuándo un release es falso, cuándo el débrid está
en cooldown y cuándo conviene esperar a que salga el audio latino en vez de conformarse con el
inglés.

## Cómo funciona el ciclo

1. **Seguimiento** — añades una película o serie desde el catálogo de TMDB (o desde el buscador).
2. **Comprobación cada 30 min**, más una cola continua para lo ya emitido: un episodio que ya
   salió no espera al siguiente tick.
3. **Búsqueda** — varias fuentes en español latino y, según el perfil de idioma de cada título,
   metabúsqueda en inglés.
4. **Filtros** — calidad mínima 1080p, descarte de nombres que no son la serie que buscas, lista
   negra de releases que ya fallaron.
5. **Preflight de duración** — compara la duración del archivo con la real de TMDB antes de
   bajarlo: así no te trae el episodio de otra serie homónima.
6. **Débrid** — adopta lo que TorBox / Real-Debrid ya tiene cacheado y detecta el cooldown.
7. **Descarga y post-proceso** — pistas de audio en orden, subtítulos spa/en, y a la biblioteca.
8. **Biblioteca** — `<películas>/<Título (Año)>/` y `<series>/<Título (Año)>/Season NN/`.
   Con reparación de carpetas fantasma y reconciliación con el débrid.

## Características

- **Perfil de idioma por título**: *latino primero* (con fallback a inglés), *solo latino* o
  *inglés primero*, más un idioma por defecto para los títulos nuevos.
- **Backfill en orden**: rellena las temporadas ya emitidas, de la más antigua a la más nueva.
- **Metabúsqueda integrada**: 23 motores, sin Docker y sin Jackett obligatorio. Si tienes un
  Jackett local lo detecta solo, y en ese caso es él quien se encarga de Cloudflare.
- **TorBox + Real-Debrid**: vinculación desde la interfaz (Real-Debrid por OAuth), selección de
  archivos en RD y estado del débrid en la pantalla de Panel.
- **Discover**: catálogo de TMDB para explorar películas y series, con búsqueda automática en
  fuentes latino.
- **Subtítulos** en español e inglés, con el nombre que Jellyfin entiende (`<video>.<lang>.srt`).
- **Interfaz en español latinoamericano e inglés**, con cambio inmediato desde la barra lateral.
- **Modo servidor web**, además de Electron: sirve la misma interfaz para una máquina sin
  escritorio (ver «Modo servidor web» abajo).
- **Especificación ejecutable**: el comportamiento está contratado en Gherkin y verificado por
  escenarios (`npm run spec`, 131 escenarios). Ver [`spec/`](spec/).

## Requisitos

**Para usar la app instalada (Windows): nada.** El instalador trae todo lo necesario.

**Para el post-proceso completo** (ordenar las pistas de audio) **y el preflight de duración**, que
la app toma del sistema:

- **FFmpeg** — <https://ffmpeg.org/download.html> · Windows: `winget install Gyan.FFmpeg` ·
  Debian/Ubuntu: `sudo apt install ffmpeg` · macOS: `brew install ffmpeg`

**Para ejecutar desde el código o compilar el instalador**, además:

- **Git** — <https://git-scm.com/downloads> (con interfaz gráfica: <https://desktop.github.com>)
- **Node.js LTS**, incluye npm — <https://nodejs.org>
- **Python 3.11 o superior** — solo para compilar los motores de búsqueda: <https://www.python.org/downloads>
- **PyInstaller y cloudscraper** — <https://pyinstaller.org/en/stable/> ·
  `pip install pyinstaller cloudscraper`
- **Clave de TMDB** (gratuita y obligatoria para buscar y seguir títulos) —
  <https://www.themoviedb.org/settings/api>

Todo junto en Windows (PowerShell):

```powershell
winget install Git.Git OpenJS.NodeJS.LTS Python.Python.3.12 Gyan.FFmpeg
```

Todo junto en Debian/Ubuntu:

```bash
sudo apt update && sudo apt install -y git nodejs npm python3 python3-pip ffmpeg
pip install --user pyinstaller cloudscraper
```

## Instalación

### Opción 1 · Instalador (Windows)

Descarga el instalador desde [Releases](https://github.com/latinokodi/MediaPilot/releases) y
ejecútalo. No necesita Python, Java ni Docker.

### Opción 2 · Desde el código (Windows, Linux y macOS)

```bash
git clone https://github.com/latinokodi/MediaPilot.git
cd MediaPilot
npm install
npm run electron:dev     # modo desarrollo, con recarga en caliente
```

**Windows → doble clic en `start.bat`.** Comprueba las dependencias y **instala las que falten**:

1. **Node.js** y **Python** — imprescindibles: si no están, los instala con `winget` (y si no hay
   `winget`, te da el enlace para hacerlo a mano).
2. **FFmpeg** — opcional: te pregunta si quieres instalarlo. Sin él la app funciona, pero se queda
   sin post-proceso de audio.
3. Las dependencias del proyecto (`npm install`) y la compilación, sólo si aún no están.
4. Arranca la aplicación.

¿Sólo quieres saber si el equipo está listo, sin arrancar nada? `start.bat check`

**Linux y macOS → `./start.sh`.** Hace lo mismo, usando el gestor de paquetes que tengas
(apt, dnf, pacman, zypper o brew):

```bash
chmod +x start.sh     # sólo la primera vez
./start.sh --check    # comprueba las dependencias
./start.sh            # arranca la aplicación
```

En una máquina sin escritorio (un servidor por SSH) arranca directamente el **modo servidor web**.

### Modo servidor web (Linux sin escritorio)

```bash
npm run server     # compila y sirve la interfaz en http://127.0.0.1:9650
```

Usa la misma base de datos y los mismos motores que la versión de escritorio. El puerto se
cambia con `TDP_PORT`.

Los motores de búsqueda en Python se compilan a ejecutables con PyInstaller
(`pip install pyinstaller cloudscraper` y luego `npm run pyinstaller`); el instalador completo se
genera con `npm run dist`.

## Configuración

Todo se configura en **Configuración** dentro de la app:

- Carpeta de películas y carpeta de series (las dos rutas que lee Jellyfin)
- **TMDB API Key** (gratis en themoviedb.org → tu cuenta → Configuración → API): **obligatoria** para
  buscar y seguir títulos; sin ella la búsqueda de Seguimiento no devuelve nada
- TorBox (API key) y Real-Debrid (OAuth)
- Perfil de idioma por defecto para títulos nuevos
- Jackett (opcional: URL y API key, o detección automática de una instalación local)
- Jellyfin (URL y API key) para refrescar la biblioteca al terminar una descarga

[`.env.example`](.env.example) documenta las variables de entorno equivalentes, por si prefieres
un despliegue sin interfaz.

## Especificación ejecutable (BDD → TDD)

El comportamiento del pipeline no está descrito solo en prosa: está **contratado** en
[`spec/mediapilot-grab-pipeline.md`](spec/mediapilot-grab-pipeline.md) (decisiones B1…B20) y
traducido a escenarios Gherkin en `spec/features/*.feature`, cada uno apoyado en lógica pura en
TypeScript y comprobado además contra la base de datos real.

```bash
npm run spec     # 117 escenarios
npm test         # Vitest
```

Los escenarios son la red de seguridad: cualquier cambio de comportamiento —o el arreglo de un
fallo real— entra primero por ahí. Cada `B…` del contrato cita el caso que lo motivó, no una
teoría.

## Estructura

```
electron/                 proceso principal (monitor, grabber, débrid, biblioteca, post-proceso)
electron/qbit-plugins/    motores de búsqueda (Python, empaquetados con PyInstaller)
src/                      interfaz React + TypeScript + Tailwind
spec/                     contrato + escenarios Gherkin ejecutables
.github/workflows/        compilación del instalador y publicación de releases
```

## Notas

- El directorio de datos es `~/.tordownloader-pro/` y la base se llama `tordownloader.db`: nombres
  heredados del proyecto original que se mantienen por compatibilidad con las instalaciones
  existentes (se pueden cambiar con la variable `TDP_DATA_DIR`).
- Los `.exe` de los motores de búsqueda no están en el repositorio: son artefactos de compilación
  (`npm run pyinstaller`) y el workflow de CI los genera.
- En Linux puede correr como servidor web sin Electron: `npm run server` (puerto `TDP_PORT`,
  por defecto 9650).

## Créditos

- Metadatos de catálogo: **TMDB** (este producto usa la API de TMDB, pero no está avalado ni
  certificado por TMDB).
- Subtítulos: addon público de OpenSubtitles para Stremio.
- Motores de búsqueda: ecosistema de plugins de qBittorrent / Jackett — ver
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Descargo de responsabilidad

MediaPilot es una herramienta de búsqueda y gestión de descargas. **No aloja, almacena ni
distribuye contenido protegido por derechos de autor**: solo consulta motores y APIs públicas de
terceros y gestiona lo que el usuario decide descargar. Cada usuario es responsable del
cumplimiento de las leyes de su jurisdicción.

## Licencia

MIT © 2025-2026 [latinokodi](https://github.com/latinokodi)

---

## English

MediaPilot is a self-hosted movie/TV **auto-downloader** for Windows and Linux. It monitors a
TMDB-based watchlist, searches Latin-American Spanish sources first (with English fallback),
filters junk releases, runs a runtime preflight against TMDB, hands the torrent to a debrid
service (TorBox / Real-Debrid), downloads it, fetches subtitles and files everything into the
exact `Title (Year)/Season NN/` layout Jellyfin expects. Its behaviour is contracted as
executable Gherkin scenarios (`spec/`, 117 scenarios, `npm run spec`). MIT licensed.
