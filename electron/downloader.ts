import fs from 'fs';
import path from 'path';
import axios, { CancelTokenSource } from 'axios';

/** TorBox CDN domains — the ONLY domains this downloader will accept. */
const TORBOX_CDN_DOMAINS = [
  'dl.torbox.app',
  'cdn.torbox.app',
  'torbox.app',
  'media.torbox.app',
  'tb-cdn.io',    // TorBox CDN edge nodes
  'tb-cdn.cx',    // TorBox CDN edge nodes (alt)
];

/** Real-Debrid CDN domains — RD generates download URLs via /unrestrict/link.
 *  These URLs are always on RD's infrastructure.  Subdomains include
 *  *.download.real-debrid.com, *.rd.nu, and CDN partner domains.
 *  See https://api.real-debrid.com/ → /unrestrict/link → "download" field. */
const REALDEBRID_CDN_DOMAINS = [
  'real-debrid.com',
  'rd.nu',
];

const ALL_CDN_DOMAINS = [...TORBOX_CDN_DOMAINS, ...REALDEBRID_CDN_DOMAINS];

function isDebridCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ALL_CDN_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export { isDebridCDN };

export interface DownloadProgress {
  bytes_done: number;
  progress_percent: number;
  speed: number;
  total_bytes: number;
}

export class Downloader {
  private cancelSource: CancelTokenSource | null = null;

  constructor(
    private url: string,
    private destPath: string,
    private expectedSize: number = 0
  ) {
    // HARD GUARD: refuse to download from anything other than debrid CDNs.
    // This app is debrid-only — it NEVER downloads via torrents/seeds/P2P.
    if (!isDebridCDN(url)) {
      throw new Error(
        `Security: Download rejected. URL ${url} is not a recognized debrid CDN domain. ` +
        `This app only downloads via debrid services (TorBox / Real-Debrid) — never via torrents/seeds/P2P.`
      );
    }
  }

  /** Abort an in-progress download. Safe to call at any time. */
  abort(): void {
    if (this.cancelSource) {
      this.cancelSource.cancel('Download cancelled by user');
      this.cancelSource = null;
    }
  }

  async start(onProgress?: (p: DownloadProgress) => void): Promise<{ success: boolean; error?: string; bytes_downloaded: number }> {
    this.cancelSource = axios.CancelToken.source();

    return new Promise(async (resolve) => {
      try {
        const response = await axios({
          method: 'GET',
          url: this.url,
          responseType: 'stream',
          timeout: 60000,
          cancelToken: this.cancelSource!.token,
        });

        const totalLength = parseInt(String(response.headers['content-length']) || '0', 10) || this.expectedSize;
        let bytesDownloaded = 0;
        let lastUpdate = Date.now();
        let lastBytes = 0;
        let speed = 0;

        const writer = fs.createWriteStream(this.destPath);

        response.data.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length;

          const now = Date.now();
          if (now - lastUpdate > 1000) {
            speed = (bytesDownloaded - lastBytes) / ((now - lastUpdate) / 1000);
            lastUpdate = now;
            lastBytes = bytesDownloaded;

            if (onProgress) {
              const progress_percent = totalLength ? (bytesDownloaded / totalLength) * 100 : 0;
              onProgress({
                bytes_done: bytesDownloaded,
                progress_percent,
                speed,
                total_bytes: totalLength,
              });
            }
          }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
          writer.close();
          this.cancelSource = null;
          resolve({ success: true, bytes_downloaded: bytesDownloaded });
        });

        writer.on('error', (err) => {
          fs.unlink(this.destPath, () => {});
          this.cancelSource = null;
          resolve({ success: false, error: err.message, bytes_downloaded: 0 });
        });
      } catch (err: any) {
        // Clean up partial file on cancellation
        try { fs.unlinkSync(this.destPath); } catch (_) {}
        this.cancelSource = null;

        if (axios.isCancel(err)) {
          resolve({ success: false, error: 'Cancelled', bytes_downloaded: 0 });
        } else {
          resolve({ success: false, error: err.message, bytes_downloaded: 0 });
        }
      }
    });
  }
}
