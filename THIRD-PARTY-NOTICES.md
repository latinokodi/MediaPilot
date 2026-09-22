# Avisos de terceros

MediaPilot usa e incluye componentes de terceros. Esta lista no sustituye a las
licencias originales: **revisa los encabezados de cada archivo** (autor, licencia
y proyecto de origen) antes de redistribuir.

## `electron/qbit-plugins/`

Framework de plugins de búsqueda del ecosistema qBittorrent
(`novaprinter.py`, `helpers.py`, `qbit-runner.py`) junto con los motores de
`engines/`, derivados en su mayoría de [Jackett](https://github.com/Jackett/Jackett)
(MIT) y de los plugins de búsqueda de la comunidad qBittorrent. Cada motor lleva
en su cabecera el crédito y la licencia de su autor original.

## Dependencias npm

React, Electron, better-sqlite3, Tailwind CSS, Radix UI, Vite, Vitest,
electron-builder, electron-updater y demás — ver `package.json` y
`package-lock.json`. Cada paquete conserva su propia licencia.

## Datos de catálogo

Los metadatos de películas y series provienen de **TMDB**. Este producto usa la
API de TMDB pero no está avalado ni certificado por TMDB.

Los subtítulos se resuelven vía el addon público de OpenSubtitles para Stremio.
