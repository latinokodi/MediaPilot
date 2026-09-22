import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';

/** Open-source client ID provided by Real-Debrid for public apps.
 *  Scopes: unrestrict, torrents, downloads, user.
 *  https://api.real-debrid.com/ → "Opensource Apps"  */
export const RD_OPENSOURCE_CLIENT_ID = 'X245A4XAIBGVM';

const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
const REST_BASE = 'https://api.real-debrid.com/rest/1.0';

export class RealDebridAPI {
  private client: AxiosInstance;

  constructor(public token?: string) {
    this.client = axios.create({
      baseURL: REST_BASE,
      headers: {
        'User-Agent': 'TorDownloader/2.0',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 30000,
    });
  }

  // ── OAuth device-code flow (opensource apps) ──────────

  /** Step 1: Get a device_code + user_code. */
  static async getDeviceCode(clientId: string = RD_OPENSOURCE_CLIENT_ID): Promise<any> {
    try {
      const res = await axios({
        method: 'GET',
        url: `${OAUTH_BASE}/device/code`,
        params: { client_id: clientId, new_credentials: 'yes' },
        timeout: 15000,
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  /** Step 2 (poll): Exchange device_code for per-user client_id + client_secret. */
  static async getCredentials(clientId: string, deviceCode: string): Promise<any> {
    try {
      const res = await axios({
        method: 'GET',
        url: `${OAUTH_BASE}/device/credentials`,
        params: { client_id: clientId, code: deviceCode },
        timeout: 15000,
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 403 || status === 400) {
        // User hasn't authorized yet — not an error, just pending
        return { success: false, pending: true, error: err.response?.data?.error || 'Authorization pending' };
      }
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  /** Step 3: Exchange credentials + device_code for access_token + refresh_token. */
  static async getToken(
    clientId: string,
    clientSecret: string,
    deviceCode: string,
  ): Promise<any> {
    try {
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('code', deviceCode);
      params.append('grant_type', 'http://oauth.net/grant_type/device/1.0');

      const res = await axios({
        method: 'POST',
        url: `${OAUTH_BASE}/token`,
        data: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  /** Refresh an expired access_token using the stored refresh_token. */
  static async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<any> {
    try {
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('code', refreshToken);
      params.append('grant_type', 'http://oauth.net/grant_type/device/1.0');

      const res = await axios({
        method: 'POST',
        url: `${OAUTH_BASE}/token`,
        data: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  // ── Torrent utilities ─────────────────────────────────

  static torrentIdentity(data: any): { id: string; hash: string } {
    const id = String(data?.id || '').trim();
    const hash = String(data?.hash || '').trim().toLowerCase();
    return { id, hash };
  }

  static normalizeProgress(value: any, status: string = ''): number {
    const statusLower = status.toLowerCase();
    if (statusLower === 'downloaded' || statusLower === 'finished') return 100;
    let raw = Number(value || 0);
    if (isNaN(raw)) raw = 0;
    if (raw <= 1 && raw > 0) raw *= 100;
    return Math.max(0, Math.min(100, Math.floor(raw)));
  }

  static normalizeTorrent(data: any): any {
    const normalized = { ...data };
    normalized.progress = RealDebridAPI.normalizeProgress(normalized.progress, normalized.status);
    return normalized;
  }

  // ── REST helpers ──────────────────────────────────────

  private async request(config: AxiosRequestConfig): Promise<any> {
    try {
      const response = await this.client.request(config);
      return { success: true, data: response.data };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const e = error as AxiosError<any>;
        if (e.code === 'ECONNABORTED') {
          return { success: false, error: 'Timeout', detail: 'Request to Real-Debrid timed out.' };
        }
        if (e.response?.status === 401 || e.response?.status === 403) {
          return { success: false, error: 'AuthError', detail: 'Real-Debrid token is invalid or expired.' };
        }
        if (e.response?.data) {
          const rdError = typeof e.response.data === 'object' ? e.response.data : null;
          const detail = rdError?.error || rdError?.error_details || e.message;
          return { success: false, error: 'RequestError', detail };
        }
        return { success: false, error: 'RequestError', detail: e.message };
      }
      return { success: false, error: 'UnknownError', detail: String(error) };
    }
  }

  // ── REST endpoints ────────────────────────────────────

  async getUserInfo(): Promise<any> {
    return this.request({ method: 'GET', url: '/user' });
  }

  async getTraffic(): Promise<any> {
    return this.request({ method: 'GET', url: '/traffic' });
  }

  async addMagnet(magnet: string): Promise<any> {
    const data = new URLSearchParams();
    data.append('magnet', magnet);

    return this.request({
      method: 'POST',
      url: '/torrents/addMagnet',
      data,
      timeout: 60000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async addTorrentFile(fileBuffer: Buffer, fileName: string = 'file.torrent'): Promise<any> {
    const FormDataLib = require('form-data');
    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: 'application/x-bittorrent',
    });

    return this.request({
      method: 'PUT',
      url: '/torrents/addTorrent',
      data: form,
      timeout: 60000,
      headers: { ...form.getHeaders() },
    });
  }

  async addTorrentFromUrl(torrentUrl: string): Promise<any> {
    const response = await axios({
      method: 'GET',
      url: torrentUrl,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'TorDownloader/2.0' },
    });

    const buffer = Buffer.from(response.data);
    const contentDisposition = response.headers['content-disposition'] || '';
    const urlPath = new URL(torrentUrl).pathname;
    let fileName = 'file.torrent';

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
    const res = await this.request({ method: 'GET', url: '/torrents' });
    if (res.success && Array.isArray(res.data)) {
      res.data = res.data.map((item: any) => RealDebridAPI.normalizeTorrent(item));
    }
    return res;
  }

  async getTorrentInfo(torrentId: string): Promise<any> {
    const res = await this.request({ method: 'GET', url: `/torrents/info/${torrentId}` });
    if (res.success && res.data) {
      res.data = RealDebridAPI.normalizeTorrent(res.data);
    }
    return res;
  }

  async unrestrictLink(downloadUrl: string): Promise<any> {
    const data = new URLSearchParams();
    data.append('link', downloadUrl);

    return this.request({
      method: 'POST',
      url: '/unrestrict/link',
      data,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async deleteTorrent(torrentId: string): Promise<any> {
    return this.request({ method: 'DELETE', url: `/torrents/delete/${torrentId}` });
  }

  async selectFiles(torrentId: string, fileIds: string[]): Promise<any> {
    const data = new URLSearchParams();
    data.append('files', fileIds.join(','));

    return this.request({
      method: 'POST',
      url: `/torrents/selectFiles/${torrentId}`,
      data,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}
