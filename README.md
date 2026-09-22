<p align="center">
  <img src="build/icon.ico" width="96" alt="MediaPilot" />
</p>

<h1 align="center">MediaPilot</h1>
<p align="center"><strong>Descargador automático de películas y series — TorBox / Real-Debrid + proveedores latino, con la biblioteca ordenada como la espera Jellyfin</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/versi%C3%B3n-1.0.16-darkgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/licencia-MIT-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/escenarios-117-blue?style=flat-square" />
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
- **TorBox + Real-Debrid**: OAuth, selección de archivos en RD y estado del débrid en la interfaz.
- **Discover**: catálogo TMDB con estrenos y búsqueda automática en proveedores latino.
- **Subtítulos** en español e inglés, con el nombre que Jellyfin entiende (`<video>.<lang>.srt`).
- **Interfaz en español latinoamericano e inglés** (cambio inmediato) y tema oscuro.
- **Modo servidor web**, además de Electron: sirve la misma interfaz para una máquina sin
  escritorio (ver «Modo servidor web» abajo).
- **Especificación ejecutable**: el comportamiento está contratado en Gherkin y verificado por
  escenarios (`npm run spec`, 117 escenarios). Ver [`spec/`](spec/).

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

Para arrancar la aplicación ya montada, sin escribir comandos:

**Windows → doble clic en `start.bat`.** El lanzador hace todo el trabajo:

1. comprueba que Node.js esté instalado (si falta, te dice de dónde bajarlo);
2. la primera vez instala las dependencias (`npm install`);
3. compila la aplicación si todavía no lo está (`npm run build`);
4. avisa si faltan los motores de búsqueda y con qué comando generarlos;
5. arranca MediaPilot.

Deja la ventana abierta mientras usas la app: si algo falla, el mensaje se queda ahí a la vista.
Si actualizas el código, borra la carpeta `dist` para que vuelva a compilar.

**Linux y macOS → `./start.sh`.** Hace exactamente lo mismo:

```bash
chmod +x start.sh     # solo la primera vez
./start.sh
```

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
- TMDB API Key (gratis en themoviedb.org) para el catálogo
- TorBox / Real-Debrid (OAuth)
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
