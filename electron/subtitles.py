#!/usr/bin/env python3
"""
subtitles.py — descarga subtítulos (español/inglés) para TorDownloader PRO.

Fuente: OpenSubtitles v3 vía protocolo Stremio (sin API key)
        https://opensubtitles-v3.strem.io/

Modos:
  scan                         — escanea la librería y descarga subs faltantes
  fetch --imdb ttXXXX [--season N --episode N] --dest /ruta/video.mkv
                               — descarga subs junto a un archivo dado (worker)
  fetch --title "Título" --year 2022 --type movie|series [--season N --episode N] --dest /ruta/video.mkv
                               — resuelve imdb por título (IMDB suggestion) y descarga

Idiomas objetivo: spa (español) y en (inglés). Los subs se guardan como
<base-del-video>.<lang>.srt  (formato Jellyfin).
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

SUBTITLE_URL = 'https://opensubtitles-v3.strem.io/subtitles'
IMDB_SUGGESTION = 'https://v3.sg.media-imdb.com/suggestion/x'
# Raíz de la biblioteca: se usa sólo en modo --scan de una biblioteca ya existente.
MEDIA_ROOT = os.environ.get('MEDIAPILOT_MEDIA_ROOT') or os.path.expanduser('~/media')
VIDEO_EXT = ('.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv')
SUB_EXT = ('.srt', '.vtt', '.ass', '.ssa', '.sub')
LANGS = ('spa', 'en')  # español + inglés
UA = 'MediaPilot/2.0'
MAX_BYTES = 10 * 1024 * 1024
TIMEOUT = 15

EP_RE = re.compile(r'[sS](\d{1,2})[eE](\d{1,2})')


# ── HTTP ─────────────────────────────────────────────

def http_get(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_json(url, timeout=TIMEOUT):
    return json.loads(http_get(url, timeout))


# ── Resolución de imdb_id ─────────────────────────────

def resolve_imdb_by_title(title, year=None, media_type=None):
    """Busca en IMDB suggestion API. Devuelve imdb_id o None."""
    query = title
    if year:
        query += f' {year}'
    url = f'{IMDB_SUGGESTION}/{urllib.parse.quote(query)}.json'
    try:
        data = http_get_json(url, timeout=8)
    except Exception:
        return None
    for item in data.get('d', []):
        iid = item.get('id', '')
        if not re.match(r'^tt\d+$', iid):
            continue
        # tipo: feature (movie) vs TV series
        q = (item.get('q') or item.get('qid') or '').lower()
        if media_type == 'series' and 'series' not in q and 'tv' not in q:
            continue
        if media_type == 'movie' and 'series' in q:
            continue
        # año: si se pide, preferir coincidencia
        if year:
            iy = item.get('y')
            if iy and str(iy) == str(year):
                return iid
            if iy and abs(int(iy) - int(year)) <= 1:
                return iid
            continue
        return iid
    return None


# ── OpenSubtitles v3 (Stremio) ────────────────────────

def fetch_subtitles(imdb_id, media_type, season=None, episode=None, lang=None):
    """Consulta el endpoint Stremio. Devuelve lista de {lang, url, name}."""
    if media_type == 'series':
        resource = f'{imdb_id}:{season}:{episode}'
        rtype = 'series'
    else:
        resource = imdb_id
        rtype = 'movie'
    url = f'{SUBTITLE_URL}/{rtype}/{resource}.json'
    try:
        data = http_get_json(url, timeout=15)
    except Exception:
        return []
    subs = []
    for s in data.get('subtitles', []):
        s_url = s.get('url', '')
        s_lang = s.get('lang', '')
        if not s_url or not re.match(r'^https?://', s_url):
            continue
        if lang and s_lang != lang:
            continue
        subs.append({'lang': s_lang, 'url': s_url, 'name': s.get('name', '')})
    return subs


def download_subtitle(url, dest_path):
    """Descarga un sub con validaciones (tamaño, HTML). Devuelve True/False."""
    tmp = dest_path + '.part'
    try:
        data = http_get(url, timeout=15)
        if len(data) > MAX_BYTES:
            raise ValueError('subtítulo excede el límite de tamaño')
        if not data:
            raise ValueError('respuesta vacía')
        head = data[:512].lstrip().lower()
        if head.startswith((b'<!doctype html', b'<html', b'<head', b'<body')):
            raise ValueError('respuesta HTML (no un subtítulo)')
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, dest_path)
        return True
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        print(f'    ✗ descarga falló: {e}', file=sys.stderr)
        return False


def sub_ext_for(url):
    path = urllib.parse.urlparse(url).path.lower()
    ext = os.path.splitext(path)[1]
    return ext if ext in SUB_EXT else '.srt'


# ── Descarga dirigida (modo fetch, usado por el worker) ──

def download_for_video(imdb_id, media_type, video_path, season=None, episode=None,
                       prefer=('spa', 'en')):
    """Descarga subs (spa y en) junto al video, con nombre base Jellyfin.
    Mapeo de códigos: spl/spa→.spa (latino preferido), eng/en→.en"""
    base = os.path.splitext(video_path)[0]
    got = []
    for lang in prefer:
        # spl = Spanish Latin (mejor que spa cuando existe)
        api_langs = ('spl', 'spa') if lang == 'spa' else ('eng', 'en')
        candidates = []
        for al in api_langs:
            candidates = fetch_subtitles(imdb_id, media_type, season, episode, lang=al)
            if candidates:
                break
        if not candidates:
            continue
        # elegir: latino primero si hay varios
        cand = candidates[0]
        ext = sub_ext_for(cand['url'])
        dest = f'{base}.{lang}{ext}'
        if os.path.exists(dest):
            print(f'  = ya existe: {os.path.basename(dest)}')
            got.append(dest)
            continue
        print(f'  → {lang}: {len(candidates)} candidatos, descargando...')
        if download_subtitle(cand['url'], dest):
            got.append(dest)
    return got


# ── Escáner de librería (modo scan) ───────────────────

def video_lang_tags(video_path):
    """Subs existentes asociados al video: {lang: path}"""
    base = os.path.splitext(video_path)[0]
    d = os.path.dirname(video_path)
    found = {}
    for name in os.listdir(d):
        if name.startswith('.') or not name.lower().endswith(SUB_EXT):
            continue
        sb = os.path.splitext(name)[0]
        # base + .lang[.hi][.0]
        m = re.match(r'^' + re.escape(os.path.basename(base)) +
                     r'\.(es-mx|es|spa|spl|en|eng)(\.hi)?(\.\d+)?$', sb, re.IGNORECASE)
        if m:
            lang = m.group(1).lower()
            if lang == 'eng':
                lang = 'en'
            if lang == 'es-mx':
                lang = 'spa'
            found.setdefault(lang, os.path.join(d, name))
    return found


def scan():
    """Escanea la librería: videos sin sub spa o en → descarga."""
    missing = []
    for dirpath, dirnames, filenames in os.walk(MEDIA_ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for name in filenames:
            if name.startswith('.') or not name.lower().endswith(VIDEO_EXT):
                continue
            vpath = os.path.join(dirpath, name)
            tags = video_lang_tags(vpath)
            has_spa = 'spa' in tags
            has_en = 'en' in tags
            if has_spa and has_en:
                continue
            missing.append((vpath, not has_spa, not has_en))

    print(f'Videos sin sub completo: {len(missing)} (faltan spa: '
          f'{sum(1 for _, s, e in missing if s)}, faltan en: '
          f'{sum(1 for _, s, e in missing if e)})')
    done = 0
    failed = 0
    for vpath, need_spa, need_en in missing:
        dirpath = os.path.dirname(vpath)
        vname = os.path.basename(vpath)
        is_tv = 'tv' in dirpath.split(os.sep)
        ep = EP_RE.search(vname)
        print(f'\n{vname}')
        # resolver imdb: carpeta (serie) o archivo (película)
        folder = os.path.basename(dirpath)
        m_year = re.search(r'\((\d{4})\)', folder)
        year = m_year.group(1) if m_year else None
        if is_tv:
            # estructura: tv/<Serie> (<Año>)/Season N/ — la serie es el padre
            parent = os.path.basename(os.path.dirname(dirpath))
            if parent.lower().startswith('season'):
                folder = parent  # fallback: no debería pasar
            else:
                folder = parent
            m_year = re.search(r'\((\d{4})\)', folder)
            year = m_year.group(1) if m_year else None
            title = re.sub(r'\s*\(\d{4}\)\s*$', '', folder)
            media_type = 'series'
            season = ep.group(1) if ep else None
            episode = ep.group(2) if ep else None
        else:
            # película: quitar año y tags de calidad del nombre del archivo
            title = re.sub(r'\s*\(\d{4}\)\s*$', '', folder)
            media_type = 'movie'
            season = episode = None
        imdb_id = resolve_imdb_by_title(title, year, media_type)
        if not imdb_id:
            print(f'  ✗ no se pudo resolver imdb para "{title}"')
            failed += 1
            continue
        print(f'  imdb: {imdb_id} ({title})')
        prefer = []
        if need_spa:
            prefer.append('spa')
        if need_en:
            prefer.append('en')
        got = download_for_video(imdb_id, media_type, vpath,
                                 season=season, episode=episode, prefer=prefer)
        if got:
            done += 1
        else:
            failed += 1

    print(f'\nListo: {done} con subs descargados, {failed} sin resolver/fallidos.')


# ── main ──────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Descarga subtítulos (spa/en)')
    sub = ap.add_subparsers(dest='mode', required=True)

    p_scan = sub.add_parser('scan', help='escanear librería y descargar faltantes')

    p_fetch = sub.add_parser('fetch', help='descargar subs para un video')
    p_fetch.add_argument('--imdb', help='imdb id (ttXXXX)')
    p_fetch.add_argument('--title', help='título (para resolver imdb)')
    p_fetch.add_argument('--year', help='año')
    p_fetch.add_argument('--type', dest='media_type', default='movie',
                         choices=['movie', 'series'])
    p_fetch.add_argument('--season')
    p_fetch.add_argument('--episode')
    p_fetch.add_argument('--dest', required=True, help='ruta del video')

    args = ap.parse_args()

    if args.mode == 'scan':
        scan()
        return

    imdb_id = args.imdb
    if not imdb_id and args.title:
        imdb_id = resolve_imdb_by_title(args.title, args.year, args.media_type)
        print(f'resuelto imdb: {imdb_id}')
    if not imdb_id:
        print('No se pudo resolver el imdb_id', file=sys.stderr)
        sys.exit(1)
    got = download_for_video(imdb_id, args.media_type, args.dest,
                             season=args.season, episode=args.episode)
    if got:
        print(f'OK: {len(got)} subtítulos descargados')
    else:
        print('No se encontraron subtítulos', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
