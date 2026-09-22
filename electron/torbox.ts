import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';

export class TorboxAPI {
  private readonly baseUrl = 'https://api.torbox.app/v1/api';
  private client: AxiosInstance;

  constructor(public token?: string) {
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'User-Agent': 'TorboxDownloader/2.0',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 30000, // 30 seconds default
    });
  }

  static torrentIdentity(data: any): { id: string; hash: string } {
    const id = String(data?.id || data?.torrent_id || '').trim();
    const hash = String(data?.hash || '').trim().toLowerCase();
    return { id, hash };
  }

  static normalizeProgress(value: any, state: string = ''): number {
    const stateLower = state.toLowerCase();
    if (['completed', 'cached', 'finished'].includes(stateLower)) {
      return 100;
    }
    let raw = Number(value || 0);
    if (isNaN(raw)) raw = 0;
    if (raw <= 1 && raw > 0) raw *= 100;
    return Math.max(0, Math.min(100, Math.floor(raw)));
  }

  static normalizeTorrent(data: any): any {
    const normalized = { ...data };
    const state =
      normalized.download_state ||
      normalized.download_status ||
      (normalized.download_finished || normalized.download_present ? 'completed' : 'unknown');
    
    normalized.download_state = state;
    normalized.progress = TorboxAPI.normalizeProgress(normalized.progress, String(state));
    return normalized;
  }

  private async request(config: AxiosRequestConfig): Promise<any> {
    try {
      const response = await this.client.request(config);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const e = error as AxiosError<any>;
        if (e.code === 'ECONNABORTED') {
          return { success: false, error: 'Timeout', detail: 'The request to TorBox timed out.' };
        }
        if (e.response && e.response.data) {
          return e.response.data; // TorBox usually returns JSON even on errors
        }
        return { success: false, error: 'RequestError', detail: e.message };
      }
      return { success: false, error: 'UnknownError', detail: String(error) };
    }
  }

  async getDeviceCode(): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/user/auth/device/start',
      params: { app: 'TorboxDownloader' },
    });
  }

  async getToken(deviceCode: string): Promise<any> {
    return this.request({
      method: 'POST',
      url: '/user/auth/device/token',
      data: { device_code: deviceCode },
    });
  }

  async getUserInfo(): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/user/me',
    });
  }

  async addMagnet(magnet: string): Promise<any> {
    const data = new URLSearchParams();
    data.append('magnet', magnet);
    data.append('seed', '0');       // 0 = never seed — debrid-only, no P2P from this app
    data.append('allow_zip', 'false');

    return this.request({
      method: 'POST',
      url: '/torrents/createtorrent',
      data,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  }

  /** Upload a .torrent file as a Buffer (multipart/form-data) */
  async addTorrentFile(fileBuffer: Buffer, fileName: string = 'file.torrent'): Promise<any> {
    // Build a multipart body manually — Node.js FormData can be problematic with axios.
    // Use the form-data npm package for reliable multipart uploads in Node.js.
    const FormDataLib = require('form-data');
    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: 'application/x-bittorrent',
    });
    form.append('seed', '0');       // 0 = never seed — debrid-only, no P2P from this app
    form.append('allow_zip', 'false');

    return this.request({
      method: 'POST',
      url: '/torrents/createtorrent',
      data: form,
      timeout: 60000,
      headers: {
        ...form.getHeaders(),
      },
    });
  }

  /** Download a .torrent file from a URL and upload to TorBox */
  async addTorrentFromUrl(torrentUrl: string): Promise<any> {
    // Download the .torrent file from the external URL
    const response = await axios({
      method: 'GET',
      url: torrentUrl,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'TorboxDownloader/2.0',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentDisposition = response.headers['content-disposition'] || '';
    const urlPath = new URL(torrentUrl).pathname;
    let fileName = 'file.torrent';

    // Extract filename from Content-Disposition or URL path
    const cdMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (cdMatch) {
      fileName = cdMatch[1].replace(/['"]/g, '').trim();
    } else {
      const urlParts = urlPath.split('/');
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.endsWith('.torrent')) {
        fileName = decodeURIComponent(lastPart);
      }
    }

    return this.addTorrentFile(buffer, fileName);
  }

  async getTorrents(): Promise<any> {
    const data = await this.request({
      method: 'GET',
      url: '/torrents/mylist',
      params: { bypass_cache: 'true' },
    });
    if (data && Array.isArray(data.data)) {
      data.data = data.data.map((item: any) => TorboxAPI.normalizeTorrent(item));
    }
    return data;
  }

  async getTorrentInfo(torrentId: string): Promise<any> {
    const data = await this.request({
      method: 'GET',
      url: '/torrents/mylist',
      params: { id: torrentId },
    });
    if (data && Array.isArray(data.data)) {
      data.data = data.data.map((item: any) => TorboxAPI.normalizeTorrent(item));
    } else if (data && typeof data.data === 'object' && data.data !== null) {
      data.data = TorboxAPI.normalizeTorrent(data.data);
    }
    return data;
  }

  async getDownloadLink(torrentId: string, fileId: string): Promise<any> {
    return this.request({
      method: 'GET',
      url: '/torrents/requestdl',
      params: { torrent_id: torrentId, file_id: fileId, token: this.token },
    });
  }

  /**
   * ¿Estos infohashes están ya en la caché de TorBox? Con `list_files` viene
   * además la lista de archivos de cada torrent, que es lo que permite
   * descartar releases falsos (sólo .zipx/.exe/.url) ANTES de añadirlos.
   * Acepta varios hashes separados por coma en una sola llamada.
   */
  async checkCached(hashes: string[]): Promise<any> {
    const list = (hashes || []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean)
    if (list.length === 0) return { success: true, data: [] }
    return this.request({
      method: 'GET',
      url: '/torrents/checkcached',
      params: { hash: list.join(','), format: 'list', list_files: 'true' },
    });
  }

  /**
   * Guarantee a boolean `success` field on any TorBox payload.
   * TorBox (FastAPI) answers a malformed request with a bare `{detail:[...]}`
   * validation body and NO `success` key, which silently defeats callers doing
   * `String(result.success) === 'true'` and made deletes fail as no-ops.
   */
  static normalizeApiResult(result: any): any {
    if (!result || typeof result !== 'object') {
      return { success: false, error: 'InvalidResponse', detail: String(result) };
    }
    if (typeof result.success !== 'undefined') return result;
    const detail = (result as any).detail;
    const msg = Array.isArray(detail)
      ? detail.map((d: any) => d?.msg || JSON.stringify(d)).join('; ')
      : typeof detail === 'string'
        ? detail
        : JSON.stringify(detail ?? result);
    return { success: false, error: 'ValidationError', detail: msg, raw: result };
  }

  async controlTorrent(torrentId: string, operation: string): Promise<any> {
    // TorBox expects a JSON body here; the old urlencoded form is rejected with
    // a 422 validation error. Operation is lower-cased because callers pass
    // both 'Delete' and 'delete'.
    const raw = String(torrentId ?? '').trim();
    const numericId = Number(raw);
    const result = await this.request({
      method: 'POST',
      url: '/torrents/controltorrent',
      data: {
        torrent_id: Number.isFinite(numericId) && raw !== '' ? numericId : raw,
        operation: String(operation ?? '').trim().toLowerCase(),
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return TorboxAPI.normalizeApiResult(result);
  }
}
