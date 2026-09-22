import { TorboxAPI } from './torbox';
import { RealDebridAPI } from './realdebrid';
import { getSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId, releaseStalledPreflights } from './db';
import { appendDownloadedFile, finalizeReplacement, markGrabFailed, getGrabByTorboxId, findWatchlistItem } from './watchlist';
import { episodeFromFileName, registerDownloadedEpisodes, normalizeAudioOrder, resolveFolderOwner } from './postprocess';
import { tmdbDetail } from './tmdb';
import { addBadRelease } from './db';
import { isStaleTorrent } from './debrid-status';
import { Downloader, DownloadProgress, isDebridCDN } from './downloader';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { eventBus } from './event-bus';
import { computeDestination, safeSegment, seriesNameMatches, getAltTitlesCached } from './media-layout';

let workerInterval: NodeJS.Timeout | null = null;
const activeLocalDownloads = new Map<string, boolean>();
const activeDownloaders = new Map<string, Downloader>();
/** Última vez que se avisó "en espera" por descarga (evita spam cada 10 s). */
const lastWaitLog = new Map<string, number>();

/**
 * Aviso de "en espera por el tope de concurrencia", como mucho una vez por
 * minuto y descarga: el worker pasa por cada fila cada 10 s y sin esto el
 * registro se llenaba del mismo mensaje.
 */
function logWaiting(tid: string, name: string, tag: string, active: number, max: number): void {
  const last = lastWaitLog.get(tid) || 0;
  if (Date.now() - last < 60_000) return;
  lastWaitLog.set(tid, Date.now());
  console.debug(`[${tag}] "${name}" en espera — ${active}/${max} descargas en curso`);
}

/** Cancel an in-progress local download by its TorBox ID. Returns true if something was aborted. */
export function cancelLocalDownload(tid: string): boolean {
  const dl = activeDownloaders.get(tid);
  if (dl) {
    dl.abort();
    activeDownloaders.delete(tid);
    activeLocalDownloads.delete(tid);
    return true;
  }
  // Mark as cancelled even if Downloader not created yet (queued)
  if (activeLocalDownloads.has(tid)) {
    activeLocalDownloads.delete(tid);
    return true;
  }
  return false;
}

function getSafePathPart(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|\.+$/g, '');
  return cleaned || 'Unknown';
}

function getSafeRelativePath(value: string, fallback: string): string {
  const rawParts = (value || fallback).split(/[/\\]+/);
  const parts = rawParts.map(getSafePathPart).filter(p => p && p !== '.' && p !== '..');
  return parts.length > 0 ? path.join(...parts) : getSafePathPart(fallback);
}

function getFileSize(fileInfo: any): number {
  for (const key of ['size', 'bytes', 'filesize']) {
    const val = parseInt(fileInfo[key], 10);
    if (!isNaN(val)) return val;
  }
  return 0;
}

function formatETA(remainingBytes: number, speed: number): string {
  if (speed <= 0 || remainingBytes <= 0) return ''
  const seconds = Math.ceil(remainingBytes / speed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * Un release puede ser de OTRA serie con el mismo nombre (p. ej. la serie
 * "Dark" 2017 colándose en una búsqueda de "Demo7" 2024). Se comprueba
 * ANTES de nada que el nombre del release corresponda al título objetivo; si
 * no, se borra, se marca el grab como fallido (para que el monitor reintente)
 * y el release entra en la lista negra.
 *
 * Antes también se comparaba la DURACIÓN del archivo con el runtime de TMDB:
 * se quitó a petición del usuario (overkill) — descargaba el archivo entero
 * para luego borrarlo y, aun así, una homónima con duración parecida
 * (Dark 2017 = 56 min vs Demo7 = 59) lo pasaba. El nombre es la señal
 * fiable y barata.
 *
 * Devuelve el mensaje de error si hay que abortar la descarga, o null si OK.
 */
export async function verifyDownloadedGrab(torboxId: string, videoPaths: string[]): Promise<string | null> {
  if (videoPaths.length === 0) return null
  const row = getGrabByTorboxId(torboxId)
  if (!row || row.kind !== 'episode' || !row.season || !row.episode || !row.tmdb_id) return null

  // El nombre del release delata la serie. Los latinos usan títulos
  // localizados (se buscan por IMDB id), así que ahí no se juzga.
  if (row.language !== 'latino' && row.title) {
    let candidates: Array<string | undefined> = []
    let altTitles: string[] = []
    try {
      const item = findWatchlistItem(row.tmdb_id, row.media_type);
      const detail = await tmdbDetail(row.tmdb_id, row.media_type);
      candidates = [detail?.original_title, item?.title, detail?.title];
      altTitles = await getAltTitlesCached(row.tmdb_id, row.media_type === 'movie' ? 'movie' : 'series');
    } catch { /* sin datos: no se puede juzgar */ }
    if (candidates.some(Boolean) && !seriesNameMatches(row.title, candidates, altTitles)) {
      const expected = candidates.filter(Boolean)[0]
      const reason = `Es de otra serie: "${row.title}" no corresponde a "${expected}"`
      console.warn(`[Worker] ✗ ${reason}`)
      deleteWrongDownload(videoPaths)
      if (row.info_hash || row.title) addBadRelease(row.info_hash || '', reason, row.title || '')
      return reason
    }
  }

  return null
}

/** Borra el video descargado equivocado y sus subtítulos (no dejar basura). */
function deleteWrongDownload(videoPaths: string[]): void {
  for (const p of videoPaths) {
    try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
    const stem = p.replace(/\.[^./\\]+$/, '')
    const dir = path.dirname(p)
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (/\.(srt|vtt|ass|ssa|sub)$/i.test(entry) && entry.startsWith(path.basename(stem) + '.')) {
          try { fs.rmSync(path.join(dir, entry), { force: true }) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

function safeMkdirSync(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (e: any) {
      // Ignore EPERM for root drives, or EEXIST if it was created concurrently
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') {
        throw e;
      }
    }
  }
}

export function startWorker(mainWindow: BrowserWindow | null) {
  if (workerInterval) clearInterval(workerInterval)
  console.log('[Worker] Starting background worker (10s interval)')

  // ── Resume interrupted downloads on startup ──────────
  try {
    // Filas que se quedaron en 'preflight' (validación previa interrumpida por
    // un reinicio del servicio): se liberan para que la descarga continúe.
    const freed = releaseStalledPreflights()
    if (freed > 0) console.log(`[Worker] ${freed} descarga(s) liberadas de la validación previa`)
    const allDownloads = getDownloads()
    const completedStates = ['completed', 'cached', 'finished']
    for (const dl of allDownloads) {
      const cloudDone = completedStates.includes((dl.status || '').toLowerCase())
      const localState = (dl.local_status || '').toLowerCase()
      const wasInterrupted = localState.startsWith('downloading') || localState === 'pending'
      if (cloudDone && wasInterrupted) {
        console.log(`[Worker] Resuming interrupted download: ${dl.name}`)
        updateDownload(dl.torbox_id, { local_status: 'pending' })
      }
    }
  } catch (err) {
    console.error('[Worker] Resume scan failed:', err)
  }

  workerInterval = setInterval(async () => {
    try {
      const settings = getSettings();
      if (!settings) return;

      // ── Poll TorBox ──────────────────────────
      if (settings.torbox_token) {
        await pollTorBox(settings, mainWindow);
        // Filas atascadas en el debrid (spec B16): liberar la plaza por sí sola.
        await reapStaleTorrents(settings).catch(() => {});
      }

      // ── Poll Real-Debrid ─────────────────────
      if (settings.realdebrid_token) {
        await pollRealDebrid(settings, mainWindow);
      }

      if (mainWindow) {
        eventBus.emit('downloads-updated');
      }
    } catch (err) {
      console.error('Worker polling loop failed', err);
    }
  }, 10000);
}

// ── TorBox polling ────────────────────────────────────

/**
 * Filas que llevan demasiado tiempo sin progreso en el debrid (swarm muerto):
 * se marcan como fallidas y se borra el torrent remoto para liberar la plaza.
 * Genérico para cualquier título; umbral configurable con
 * TDP_STALE_TORRENT_MIN (0 = desactivado).
 */
const STALE_TORRENT_MINUTES = Number(process.env.TDP_STALE_TORRENT_MIN || 120)

async function reapStaleTorrents(settings: any): Promise<void> {
  if (STALE_TORRENT_MINUTES <= 0) return
  const tb = new TorboxAPI(settings.torbox_token)
  for (const dl of getDownloads()) {
    const local = String(dl.local_status || '').toLowerCase()
    if (local.startsWith('downloading') || local === 'completed') continue
    const age = (Date.now() - new Date(dl.created_at || Date.now()).getTime()) / 60_000
    if (!isStaleTorrent(String(dl.status || ''), age, STALE_TORRENT_MINUTES)) continue
    console.log(`[Worker] torrent sin progreso (${dl.status}, ${Math.round(age)} min) — se libera la plaza y se reintentará: ${String(dl.name || '').slice(0, 60)}`)
    try { await tb.controlTorrent(dl.torbox_id, 'delete') } catch { /* puede no existir ya */ }
    updateDownload(dl.torbox_id, { local_status: `failed: torrent sin progreso en el debrid (${dl.status})` })
    try { markGrabFailed(dl.torbox_id, `torrent sin progreso (${dl.status})`) } catch { /* nada */ }
  }
}

async function pollTorBox(settings: any, mainWindow: BrowserWindow | null) {
  const tb = new TorboxAPI(settings.torbox_token);
  const res = await tb.getTorrents();

  if (res.success && res.data) {
    for (const rawDlData of res.data) {
      const dlData = TorboxAPI.normalizeTorrent(rawDlData);
      const { id: tid } = TorboxAPI.torrentIdentity(dlData);
      const name = dlData.name || 'Unknown';
      const state = dlData.download_state || 'unknown';
      const progress = TorboxAPI.normalizeProgress(dlData.progress, state);

      if (!tid) continue;

      let record = getDownloadByTorboxId(tid);
      if (!record) continue;

      // Transición de estado visible en los registros (sin spam de cada poll).
      const prevStatus = (record.status || '').toLowerCase();
      const prevProg = Number(record.progress) || 0;
      const st = state.toLowerCase();
      if (prevStatus && prevStatus !== st && st !== 'unknown') {
        console.log(`[TorBox] "${name}": ${prevStatus} → ${st} (${progress}%)`);
      } else if (progress > 0 && prevProg > 0 && progress - prevProg >= 5 && Math.floor(prevProg / 10) !== Math.floor(progress / 10)) {
        console.debug(`[TorBox] "${name}": ${progress}%`);
      }

      updateDownload(tid, {
        status: state,
        progress: progress,
        ...(record.name === 'Pending...' && name !== 'Unknown' ? { name } : {})
      });

      record = getDownloadByTorboxId(tid)!;

      const completedStates = ['completed', 'cached', 'finished'];

      // Tope de descargas simultáneas (settings.max_concurrent_downloads).
      // Sin esto el worker arrancaba TODAS las filas pendientes a la vez y la
      // conexión se repartía entre decenas de archivos.
      const maxConcurrent = Math.max(1, Number(settings.max_concurrent_downloads) || 3);

      if (completedStates.includes(state.toLowerCase()) && ['pending', 'queued'].includes(record.local_status)) {
        if (!activeLocalDownloads.has(tid)) {
          if (activeLocalDownloads.size >= maxConcurrent) {
            logWaiting(tid, name, 'Worker', activeLocalDownloads.size, maxConcurrent);
          } else {
          console.log(`[Worker] Queued TorBox download: ${name} (${tid})`)
          updateDownload(tid, { local_status: 'queued' });
          activeLocalDownloads.set(tid, true);
          runTorboxDownload(tid, dlData, settings, settings.torbox_token, mainWindow).catch(err => {
            console.error(`Local download failed for ${tid}:`, err);
            updateDownload(tid, { local_status: `failed: ${err.message}` });
            activeLocalDownloads.delete(tid);
            eventBus.emit('downloads-updated');
          });
          }
        }
      }

      if (settings.auto_remove_completed && completedStates.includes(state.toLowerCase()) && record.local_status === 'completed') {
        await tb.controlTorrent(dlData.id, 'Delete');
        deleteDownload(tid);
      }
    }
  }
}

// ── Real-Debrid polling ────────────────────────────────

async function pollRealDebrid(settings: any, mainWindow: BrowserWindow | null) {
  const rd = new RealDebridAPI(settings.realdebrid_token);
  const res = await rd.getTorrents();

  if (res.success && Array.isArray(res.data)) {
    for (const rawDlData of res.data) {
      const dlData = RealDebridAPI.normalizeTorrent(rawDlData);
      const { id: tid } = RealDebridAPI.torrentIdentity(dlData);
      const name = dlData.filename || dlData.name || 'Unknown';
      const state = dlData.status || 'unknown';
      const progress = RealDebridAPI.normalizeProgress(dlData.progress, state);

      if (!tid) continue;

      let record = getDownloadByTorboxId(tid);
      if (!record) continue;

      const prevStatus = (record.status || '').toLowerCase();
      const prevProg = Number(record.progress) || 0;

      updateDownload(tid, {
        status: state,
        progress: progress,
        ...(record.name === 'Pending...' && name !== 'Unknown' ? { name } : {})
      });

      record = getDownloadByTorboxId(tid)!;

      // RD's /torrents list often returns "magnet_conversion" for torrents that have
      // already progressed.  Call getTorrentInfo to get the real status.
      // The browser extension does exactly this: see mshll/real-debrid-manager.
      let effectiveState = state.toLowerCase();
      if (effectiveState === 'magnet_conversion') {
        try {
          const infoRes = await rd.getTorrentInfo(tid);
          if (infoRes.success && infoRes.data) {
            const realStatus = (infoRes.data.status || '').toLowerCase();
            if (realStatus && realStatus !== 'magnet_conversion') {
              console.log(`[RD] ${name}: magnet_conversion → real status = ${realStatus}`);
              effectiveState = realStatus;
              updateDownload(tid, { status: realStatus });
              if (infoRes.data.filename && record.name === 'Pending...') {
                updateDownload(tid, { name: infoRes.data.filename || name });
              }
              record = getDownloadByTorboxId(tid)!;
            }
          }
        } catch (err) {
          // getTorrentInfo may fail during early magnet conversion — that's OK
        }
      }

      // Transición de estado visible en los registros (sin spam de cada poll).
      if (prevStatus && prevStatus !== effectiveState && effectiveState !== 'unknown') {
        console.log(`[RD] "${name}": ${prevStatus} → ${effectiveState} (${progress}%)`);
      } else if (progress > 0 && prevProg > 0 && progress - prevProg >= 5 && Math.floor(prevProg / 10) !== Math.floor(progress / 10)) {
        console.debug(`[RD] "${name}": ${progress}%`);
      }

      // Auto-select all files when torrent is waiting for file selection
      if (effectiveState === 'waiting_files_selection') {
        try {
          const infoRes = await rd.getTorrentInfo(tid);
          if (infoRes.success && infoRes.data) {
            const files = infoRes.data.files || [];
            if (files.length > 0) {
              const fileIds = files.map((f: any) => String(f.id));
              await rd.selectFiles(tid, fileIds);
              console.log(`[RD] Auto-selected ${fileIds.length} files for ${name}`);
            }
          }
        } catch (err) {
          console.error(`[RD] Failed to select files for ${tid}:`, err);
        }
      }

      const completedStates = ['downloaded', 'finished'];
      const maxRdConcurrent = Math.max(1, Number(settings.max_concurrent_downloads) || 3);

      if (completedStates.includes(effectiveState) && ['pending', 'queued'].includes(record.local_status)) {
        if (!activeLocalDownloads.has(tid)) {
          if (activeLocalDownloads.size >= maxRdConcurrent) {
            logWaiting(tid, name, 'RD', activeLocalDownloads.size, maxRdConcurrent);
          } else {
          console.log(`[Worker] Queued RD download: ${name} (${tid})`)
          updateDownload(tid, { local_status: 'queued' });
          activeLocalDownloads.set(tid, true);
          runRealdebridDownload(tid, dlData, settings, settings.realdebrid_token, mainWindow).catch(err => {
            console.error(`RD download failed for ${tid}:`, err);
            updateDownload(tid, { local_status: `failed: ${err.message}` });
            activeLocalDownloads.delete(tid);
            eventBus.emit('downloads-updated');
          });
          }
        }
      }

      if (settings.auto_remove_completed && completedStates.includes(effectiveState) && record.local_status === 'completed') {
        await rd.deleteTorrent(dlData.id);
        deleteDownload(tid);
      }
    }
  }
}

async function runTorboxDownload(tid: string, dlData: any, settings: any, token: string, mainWindow: BrowserWindow | null) {
  try {
    const rec = getDownloadByTorboxId(tid);
    const type: 'movie' | 'series' | '' = rec?.type || '';
    let destFolder: string;
    if (rec?.dest_folder) {
      // Automation engine already decided the exact destination at grab time —
      // never re-derive it from the release name (names lie, folders don't).
      destFolder = rec.dest_folder;
    } else {
      const { root, folder } = await computeDestination(settings, dlData.name || tid, type);
      if (!root) throw new Error('Destination folder is not configured');
      destFolder = path.join(root, ...folder.split('/').map(safeSegment));
    }

    const tb = new TorboxAPI(token);
    safeMkdirSync(destFolder);

    let files = dlData.files || [];
    if (!files.length) {
      const infoRes = await tb.getTorrentInfo(tid);
      if (infoRes.success && infoRes.data) {
        if (Array.isArray(infoRes.data) && infoRes.data.length > 0) {
          files = infoRes.data[0].files || [];
        } else if (typeof infoRes.data === 'object') {
          files = infoRes.data.files || [];
        }
      }
    }

    files = files.filter((f: any) => f.id !== undefined && f.id !== null);
    const totalFiles = files.length;
    
    if (totalFiles === 0) {
      throw new Error('TorBox returned no downloadable files');
    }

    const totalBytes = files.reduce((acc: number, f: any) => acc + getFileSize(f), 0);
    let completedBytes = 0;
    let videosDownloaded = 0;
    const downloadedVideoPaths: string[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const fileInfo = files[idx];
      const fileId = fileInfo.id;
      const fileName = fileInfo.name || fileInfo.path || `file_${idx}`;

      // GUARD: skip non-video files (.exe/.vbs/.url/.nfo/.txt — malware en torrents falsos)
      const lowerName = fileName.toLowerCase();
      const isVideo = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i.test(lowerName);
      const isSub = /\.(srt|vtt|ass|ssa|sub)$/i.test(lowerName);
      if (!isVideo && !isSub) {
        console.log(`[Worker] Skip non-video file: ${fileName}`);
        continue;
      }

      // Flatten: place every file directly in the type folder (radarr/sonarr style).
      const filePath = path.join(destFolder, safeSegment(path.basename(fileName)));
      const expectedSize = getFileSize(fileInfo);

      const linkRes = await tb.getDownloadLink(tid, String(fileId));
      if (!linkRes.success || !linkRes.data) {
        throw new Error(`TorBox did not return a download link for ${fileName}`);
      }

      const downloadUrl = linkRes.data;

      // HARD GUARD: verify the URL is from a recognized debrid CDN.
      if (!isDebridCDN(downloadUrl)) {
        throw new Error(
          `Security: Download URL ${downloadUrl} is not from a recognized debrid CDN.`
        );
      }

      const downloader = new Downloader(downloadUrl, filePath, expectedSize);
      activeDownloaders.set(tid, downloader);

      updateDownload(tid, {
        local_status: `Downloading ${idx + 1}/${totalFiles}...`,
        local_progress: Math.floor((idx / totalFiles) * 100),
        local_path: destFolder,
      });
      console.log(`[Worker] TB "${dlData.name || tid}": descargando ${idx + 1}/${totalFiles} — ${fileName}${expectedSize > 0 ? ` (${fmtBytes(expectedSize)})` : ''}`)
      eventBus.emit('downloads-updated');

      let lastUpdate = 0;
      const onProg = (p: DownloadProgress) => {
        const now = Date.now();
        if (now - lastUpdate > 2000) {
          lastUpdate = now;
          let overall = 0;
          if (totalBytes > 0) {
            overall = Math.floor(((completedBytes + p.bytes_done) / totalBytes) * 100);
          } else {
            overall = Math.floor(((idx / totalFiles) * 100) + (p.progress_percent / totalFiles));
          }

          const remaining = totalBytes > 0 ? totalBytes - (completedBytes + p.bytes_done) : 0;
          const eta = formatETA(remaining, p.speed);

          updateDownload(tid, {
            local_status: `Downloading ${idx + 1}/${totalFiles} (${Math.floor(p.progress_percent)}%)`,
            local_progress: Math.max(0, Math.min(99, overall)),
            local_speed: Math.floor(p.speed),
            local_eta: eta,
            local_path: destFolder,
          });
          eventBus.emit('downloads-updated');
        }
      };

      const result = await downloader.start(onProg);
      if (!result.success) {
        throw new Error(`Failed to download ${fileName}: ${result.error}`);
      }
      console.log(`[Worker] TB ✓ ${fileName} (${fmtBytes(result.bytes_downloaded || expectedSize)})`)
      if (isVideo) { videosDownloaded += 1; downloadedVideoPaths.push(filePath) }
      appendDownloadedFile(tid, filePath)

      if (expectedSize > 0) {
        const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        if (actualSize !== expectedSize) {
          throw new Error(`Failed to verify ${fileName}: expected ${expectedSize} bytes, got ${actualSize}`);
        }
      }

      completedBytes += expectedSize || result.bytes_downloaded;
    }

    // Un torrent sin ningún archivo de video (p. ej. solo .zipx/.rar) NO es una
    // descarga válida: marcarla como completada perdía el episodio en silencio.
    if (videosDownloaded === 0) {
      const row = getGrabByTorboxId(tid)
      if (row && (row.info_hash || row.title)) addBadRelease(row.info_hash || '', 'torrent sin archivo de video', row.title || '')
      throw new Error('El torrent no contiene ningún archivo de video (¿empaquetado en .zipx/.rar?) — se reintentará')
    }

    // ¿Es realmente el episodio pedido? (evita releases de otra serie homónima)
    const mismatch = await verifyDownloadedGrab(tid, downloadedVideoPaths)
    if (mismatch) throw new Error(mismatch)

    updateDownload(tid, {
      local_status: 'completed',
      local_progress: 100,
      local_speed: 0,
      local_path: destFolder,
    });
    console.log(`[Worker] TorBox download complete: ${dlData.name || tid} → ${destFolder}`)

    // ── Subtítulos automáticos (spa + en) ──────────────
    await fetchSubtitlesForDownload(dlData.name || tid, type, destFolder, downloadedVideoPaths, tid);
    // ── Lo que antes había que hacer a mano con los packs (spec B13/B15) ──
    // 1) registrar cada episodio en el historial → el monitor ya sabe que está
    //    en disco y no lo vuelve a bajar (antes se re-descargaba el pack entero);
    // 2) dejar el audio en el orden preferido (inglés/español primero) cuando el
    //    release trae otro idioma por defecto (p. ej. packs ITA-ENG).
    try {
      const grabRow = getGrabByTorboxId(tid)
      const owner = resolveFolderOwner(grabRow?.tmdb_id, destFolder, type)
      if (owner) {
        const added = registerDownloadedEpisodes({
          tmdbId: owner.tmdb_id,
          mediaType: owner.media_type,
          torrentName: dlData.name || '',
          destFolder,
          files: downloadedVideoPaths,
          torboxId: tid,
        })
        if (added > 0) console.log(`[Worker] ${added} episodio(s) registrados en el historial (no se volverán a bajar)`)
      } else {
        console.debug(`[Worker] sin dueño en la watchlist para ${destFolder} — no se registran episodios`)
      }
    } catch (e: any) {
      console.warn(`[Worker] registro de episodios falló: ${e?.message || e}`)
    }
    try {
      const reordered = await normalizeAudioOrder(downloadedVideoPaths)
      if (reordered > 0) console.log(`[Worker] ${reordered} archivo(s) con el audio reordenado al idioma preferido`)
    } catch (e: any) {
      console.warn(`[Worker] reordenación de audio falló: ${e?.message || e}`)
    }
    // ── Reemplazo manual EN → latino (el worker borra el EN ya completado) ──
    try { finalizeReplacement(tid) } catch (e: any) { console.warn(`[Worker] finalizeReplacement failed: ${e.message}`) }
    
  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
    markGrabFailed(tid, err.message)
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    eventBus.emit('downloads-updated');
  }
}

// ── Subtítulos automáticos ─────────────────────────────

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|wmv)$/i;
const EP_RE = /[sS](\d{1,2})[eE](\d{1,2})/;

/**
 * imdb_id del título grabado, leído de la fila del grab (que lo trae del
 * watchlist) y, si falta, de TMDB. Cadena vacía si no se puede saber: entonces
 * subtitles.py cae a la heurística por título, como antes.
 */
async function knownImdbId(torboxId: string): Promise<string> {
  try {
    const row = getGrabByTorboxId(torboxId);
    if (!row || !row.tmdb_id) return '';
    const item = findWatchlistItem(row.tmdb_id, row.media_type);
    if (item && item.imdb_id) return item.imdb_id;
    const detail = await tmdbDetail(row.tmdb_id, row.media_type);
    return detail?.imdb_id || '';
  } catch {
    return '';
  }
}

/**
 * Tras completar una descarga, busca el/los video(s) en la carpeta destino
 * y descarga subtítulos (español + inglés) vía electron/subtitles.py.
 * Fire-and-forget: errores solo se loguean, nunca fallan la descarga.
 */
async function fetchSubtitlesForDownload(name: string, type: string, destFolder: string, onlyFiles?: string[], torboxId?: string) {
  try {
    const py = process.env.TDP_PYTHON || 'python3';
    const script = path.join(__dirname, '..', 'electron', 'subtitles.py');
    if (!fs.existsSync(script)) {
      console.log('[Subs] subtitles.py no encontrado, saltando descarga de subtítulos');
      return;
    }
    // Solo los videos que acaba de escribir esta descarga. Listar la carpeta
    // entera pedía los subtítulos del EPISODIO RECIÉN DESCARGADO para todos los
    // capítulos que ya estaban ahí (mismo nombre de archivo .srt duplicado en
    // cada uno) — la carpeta de temporada no puede ser la fuente de verdad.
    const justDownloaded = (onlyFiles || []).filter((p) => VIDEO_EXT_RE.test(p) && fs.existsSync(p));
    const videos = justDownloaded.length > 0
      ? justDownloaded.map((p) => path.basename(p))
      : fs.readdirSync(destFolder)
        .filter((f) => VIDEO_EXT_RE.test(f) && !f.startsWith('.'))
        .sort((a, b) => fs.statSync(path.join(destFolder, b)).size - fs.statSync(path.join(destFolder, a)).size);
    if (videos.length === 0) return;

    // Resolver imdb: usar el nombre del torrent (título base sin tags)
    const epMatch = name.match(EP_RE);
    const isSeries = type === 'series' || !!epMatch;
    // Título: quitar año, tags de calidad, SxxExx y release group
    let title = name
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(EP_RE, ' ')
      .replace(/[.\-_]+/g, ' ')
      .replace(/\b(1080p|720p|4k|2160p|web[-\s]?dl|bluray|webrip|hdr|x264|x265|h\.?265|hevc|h\.?264|aac|ac3|ddp5[.\s]?1|atmos|5[.\s]?1|7[.\s]?1|dual|latino|english|spanish|extended|unrated|repack|proper|nf|amzn|atvp|itunes|hmax|dsnp|uhd|remux|s\d{1,2}|complete|season|series|episode)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Quitar release group residual: último token TODO en mayúsculas (p.ej. ETHEL, KONTRAST, HEEL)
    const tokens = title.split(' ');
    while (tokens.length > 3) {
      const last = tokens[tokens.length - 1];
      if (/^[A-Z0-9]{2,}$/.test(last) && last !== last.toLowerCase()) {
        tokens.pop();
      } else {
        break;
      }
    }
    title = tokens.join(' ').trim();
    if (!title) title = name;

    // El imdb_id REAL (el que la app ya conoce por la fila del grab) manda
    // sobre la heurística del nombre: resolverlo por título fallaba con los
    // nombres de release ("Demo7 MeGusta UIndex org") y a veces acertaba
    // en OTRA serie homónima (subtítulos de la serie equivocada).
    const imdbId = torboxId ? await knownImdbId(torboxId) : ''

    for (const v of videos) {
      const videoPath = path.join(destFolder, v);
      const args = ['electron/subtitles.py', 'fetch', '--title', title, '--type', isSeries ? 'series' : 'movie', '--dest', videoPath];
      if (imdbId) args.push('--imdb', imdbId);
      // En packs, el nombre del TORRENT sólo trae la temporada ("Demo.S01.COMPLETE…"):
      // el episodio se saca del nombre del ARCHIVO. Sin esto, los packs se quedaban
      // con 0 subtítulos (había que bajarlos a mano, uno por uno).
      const fileEp = episodeFromFileName(v)
      const seasonArg = epMatch ? epMatch[1] : fileEp ? String(fileEp.season) : ''
      const episodeArg = epMatch ? epMatch[2] : fileEp ? String(fileEp.episode) : ''
      if (isSeries && seasonArg && episodeArg) {
        args.push('--season', seasonArg, '--episode', episodeArg);
      }
      await new Promise<void>((resolve) => {
        const proc = spawn(py, [script, ...args.slice(1)], { env: process.env as any });
        let out = '';
        proc.stdout?.on('data', (c: Buffer) => (out += c.toString()));
        proc.stderr?.on('data', (c: Buffer) => (out += c.toString()));
        proc.on('close', () => {
          console.log(`[Subs] ${v}: ${out.trim().split('\n').pop()}`);
          resolve();
        });
        proc.on('error', (e) => { console.log(`[Subs] error: ${e.message}`); resolve(); });
        setTimeout(() => { try { proc.kill('SIGTERM') } catch {} resolve() }, 60_000);
      });
    }
  } catch (e: any) {
    console.log(`[Subs] skip: ${e.message}`);
  }
}

// ── Real-Debrid local download ─────────────────────────

async function runRealdebridDownload(tid: string, dlData: any, settings: any, token: string, mainWindow: BrowserWindow | null) {
  try {
    const rec = getDownloadByTorboxId(tid);
    const type: 'movie' | 'series' | '' = rec?.type || '';
    let destFolder: string;
    if (rec?.dest_folder) {
      destFolder = rec.dest_folder;
    } else {
      const { root, folder } = await computeDestination(settings, dlData.filename || dlData.name || tid, type);
      if (!root) throw new Error('Destination folder is not configured');
      destFolder = path.join(root, ...folder.split('/').map(safeSegment));
    }

    const rd = new RealDebridAPI(token);
    safeMkdirSync(destFolder);

    // Get torrent info to obtain the links array
    const infoRes = await rd.getTorrentInfo(tid);
    if (!infoRes.success || !infoRes.data) {
      throw new Error('Failed to get torrent info from Real-Debrid');
    }

    const torrentInfo = infoRes.data;
    const links: string[] = torrentInfo.links || [];
    const totalBytes = torrentInfo.bytes || torrentInfo.original_bytes || 0;

    if (links.length === 0) {
      throw new Error('Real-Debrid returned no download links for this torrent');
    }

    const totalLinks = links.length;
    let completedBytes = 0;
    const downloadedVideoPaths: string[] = [];

    for (let idx = 0; idx < links.length; idx++) {
      const link = links[idx];

      // Unrestrict the link to get a direct download URL + filename
      const unrestrictRes = await rd.unrestrictLink(link);
      if (!unrestrictRes.success || !unrestrictRes.data) {
        // Skip dead/expired hoster links — don't fail the whole torrent
        console.warn(`[RD] Skipping link ${idx + 1}/${totalLinks}: unrestrict failed (${unrestrictRes.error || 'unknown'})`);
        continue;
      }

      const { download: directUrl, filename, filesize } = unrestrictRes.data;
      if (!directUrl) {
        throw new Error(`No download URL returned for link ${idx + 1}/${totalLinks}`);
      }

      const expectedSize = filesize || 0;

      // Use filename from unrestricted response, fall back to index
      const safeName = getSafeRelativePath(filename || `part_${idx + 1}`, `part_${idx + 1}`);
      const filePath = path.join(destFolder, safeName);

      safeMkdirSync(path.dirname(filePath));

      // HARD GUARD
      if (!isDebridCDN(directUrl)) {
        throw new Error(
          `Security: Download URL ${directUrl} is not from a recognized debrid CDN.`
        );
      }

      const downloader = new Downloader(directUrl, filePath, expectedSize);
      activeDownloaders.set(tid, downloader);

      updateDownload(tid, {
        local_status: `Downloading ${idx + 1}/${totalLinks}...`,
        local_progress: Math.floor((idx / totalLinks) * 100),
        local_path: destFolder,
      });
      console.log(`[Worker] RD "${dlData.filename || dlData.name || tid}": descargando ${idx + 1}/${totalLinks} — ${safeName}${expectedSize > 0 ? ` (${fmtBytes(expectedSize)})` : ''}`)
      eventBus.emit('downloads-updated');

      let lastUpdate = 0;
      const onProg = (p: DownloadProgress) => {
        const now = Date.now();
        if (now - lastUpdate > 1000) {
          lastUpdate = now;
          let overall = 0;
          if (totalBytes > 0) {
            overall = Math.floor(((completedBytes + p.bytes_done) / totalBytes) * 100);
          } else {
            overall = Math.floor(((idx / totalLinks) * 100) + (p.progress_percent / totalLinks));
          }

          const remaining = totalBytes > 0 ? totalBytes - (completedBytes + p.bytes_done) : 0;
          const eta = formatETA(remaining, p.speed);

          updateDownload(tid, {
            local_status: `Downloading ${idx + 1}/${totalLinks} (${Math.floor(p.progress_percent)}%)`,
            local_progress: Math.max(0, Math.min(99, overall)),
            local_speed: Math.floor(p.speed),
            local_eta: eta,
            local_path: destFolder,
          });
          eventBus.emit('downloads-updated');
        }
      };

      const result = await downloader.start(onProg);
      if (!result.success) {
        throw new Error(`Failed to download part ${idx + 1}: ${result.error}`);
      }
      console.log(`[Worker] RD ✓ ${safeName} (${fmtBytes(result.bytes_downloaded || expectedSize)})`)
      if (VIDEO_EXT_RE.test(safeName)) downloadedVideoPaths.push(filePath)
      appendDownloadedFile(tid, filePath)

      completedBytes += expectedSize || result.bytes_downloaded;
    }

    // If no links were successfully downloaded, report the failure
    if (completedBytes === 0 && links.length > 0) {
      throw new Error(`All ${links.length} link(s) failed to unrestrict or download`);
    }

    // ¿Es realmente el episodio pedido? (evita releases de otra serie homónima)
    const mismatch = await verifyDownloadedGrab(tid, downloadedVideoPaths)
    if (mismatch) throw new Error(mismatch)

    updateDownload(tid, {
      local_status: 'completed',
      local_progress: 100,
      local_speed: 0,
      local_path: destFolder,
    });
    console.log(`[Worker] RD download complete: ${dlData.filename || tid} → ${destFolder}`)

    // ── Subtítulos automáticos (spa + en) ──────────────
    await fetchSubtitlesForDownload(dlData.filename || dlData.name || tid, type, destFolder, downloadedVideoPaths, tid);
    // ── Reemplazo manual EN → latino (el worker borra el EN ya completado) ──
    try { finalizeReplacement(tid) } catch (e: any) { console.warn(`[Worker] finalizeReplacement failed: ${e.message}`) }

  } catch (err: any) {
    updateDownload(tid, {
      local_status: `failed: ${err.message}`,
      local_speed: 0,
    });
    markGrabFailed(tid, err.message)
  } finally {
    activeLocalDownloads.delete(tid);
    activeDownloaders.delete(tid);
    eventBus.emit('downloads-updated');
  }
}
