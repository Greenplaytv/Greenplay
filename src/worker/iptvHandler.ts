import type {
  AuthSessionInfo,
  CategoryItem,
  EpisodeItem,
  GlobalSearchResponse,
  HomeCatalogResponse,
  HomeSectionResponse,
  MediaItem,
  MediaType,
  PaginatedCatalogResponse,
  PlaybackSourceResponse,
  SeasonGroup,
  SeriesDetail,
} from '../types/catalog';

export interface WorkerEnv {
  SESSION_SECRET?: string;
  DEFAULT_LIVE_PLAYLIST_URL?: string;
}

interface SessionTokenPayload {
  mode: 'xtream' | 'm3u';
  serverUrl?: string;
  username?: string;
  password?: string;
  m3uUrl?: string;
  info: AuthSessionInfo;
  exp: number;
}

interface StreamTokenPayload {
  url: string;
  exp: number;
}

type StreamFormatType = 'hls' | 'mp4' | 'mkv' | 'ts' | 'unsupported';

interface RawCatalogItem {
  id: string;
  type: MediaType;
  title: string;
  description: string;
  rawPoster: string;
  rawBanner: string;
  genres: string[];
  categoryId: string;
  categoryName: string;
  year?: string;
  rating?: string;
  channelNumber?: number;
  containerExt?: string;
  rawStreamUrl?: string;
}

interface RawTypeCatalog {
  categories: CategoryItem[];
  items: RawCatalogItem[];
  fetchedAt: number;
}

const SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours
const STREAM_TOKEN_TTL_SEC = 4 * 60 * 60; // 4 hours
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const XTREAM_TIMEOUT_MS = 25000; // 25 seconds for larger provider responses
const MAX_M3U_BYTES = 25 * 1024 * 1024; // 25MB cap

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Ephemeral fallback secret per isolate if SESSION_SECRET env var is not yet configured
let isolateFallbackSecretBytes: Uint8Array | null = null;
const memoryCatalogCache = new Map<string, {data: unknown; expiresAt: number}>();
const inflightRequests = new Map<string, Promise<unknown>>();

function getFallbackSecretBytes(): Uint8Array {
  if (!isolateFallbackSecretBytes) {
    isolateFallbackSecretBytes = crypto.getRandomValues(new Uint8Array(32));
  }
  return isolateFallbackSecretBytes;
}

async function getAesKey(env: WorkerEnv): Promise<CryptoKey> {
  const rawBytes = env.SESSION_SECRET
    ? textEncoder.encode(env.SESSION_SECRET)
    : getFallbackSecretBytes();
  const keyDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(rawBytes));
  return crypto.subtle.importKey('raw', keyDigest, {name: 'AES-GCM'}, false, [
    'encrypt',
    'decrypt',
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptToken(payload: object, env: WorkerEnv): Promise<string> {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(encrypted)}`;
}

async function decryptToken<T extends {exp?: number}>(
  token: string,
  env: WorkerEnv,
): Promise<T | null> {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  try {
    const iv = base64UrlDecode(token.slice(0, dotIdx));
    const ciphertext = base64UrlDecode(token.slice(dotIdx + 1));
    if (iv.length !== 12 || ciphertext.length < 16) return null;
    const key = await getAesKey(env);
    const decrypted = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: new Uint8Array(iv)},
      key,
      new Uint8Array(ciphertext),
    );
    const parsed = JSON.parse(textDecoder.decode(decrypted)) as T;
    if (parsed.exp && Math.floor(Date.now() / 1000) > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// --- Edge & Memory Caching ---

function getEdgeCache(): Cache | undefined {
  const cfCaches = (globalThis as unknown as {caches?: {default?: Cache}}).caches;
  return cfCaches?.default;
}

async function getCachedJson<T>(cacheKey: string): Promise<T | null> {
  const mem = memoryCatalogCache.get(cacheKey);
  if (mem && mem.expiresAt > Date.now()) {
    return mem.data as T;
  }
  if (mem) {
    memoryCatalogCache.delete(cacheKey);
  }

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const hit = await edgeCache.match(new Request(`https://cache.greenplay.internal/${cacheKey}`));
      if (hit) {
        const data = (await hit.json()) as T;
        memoryCatalogCache.set(cacheKey, {data, expiresAt: Date.now() + CACHE_TTL_MS});
        return data;
      }
    } catch {
      // Ignore cache read failures
    }
  }
  return null;
}

async function setCachedJson(cacheKey: string, data: unknown): Promise<void> {
  memoryCatalogCache.set(cacheKey, {data, expiresAt: Date.now() + CACHE_TTL_MS});
  if (memoryCatalogCache.size > 150) {
    const oldestKey = memoryCatalogCache.keys().next().value;
    if (oldestKey) memoryCatalogCache.delete(oldestKey);
  }

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const req = new Request(`https://cache.greenplay.internal/${cacheKey}`);
      const res = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`,
        },
      });
      await edgeCache.put(req, res);
    } catch {
      // Ignore cache write errors
    }
  }
}

// --- SSRF Protection & Safe Fetch ---

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isRestrictedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  // Block numeric/hex/octal obfuscated single-integer IPs
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }

  // IPv4 literal check
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPrivateOrReservedIpv4(host);
  }

  // IPv6 literal checks
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
      return true;
    }
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice(7);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) {
        return isPrivateOrReservedIpv4(mapped);
      }
      return true;
    }
  }

  return false;
}

function normalizeServerInput(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/^["']+|["']+$/g, '');
  if (!trimmed) return '';
  if (!trimmed.includes('://') && !/^(javascript|data|vbscript|file|ftp|mailto):/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function buildXtreamBaseOrigin(parsedUrl: URL): string {
  let cleanPath = parsedUrl.pathname.replace(/\/+$/, '');
  cleanPath = cleanPath.replace(/\/(player_api|panel_api|get|xmltv)\.php$/i, '');
  cleanPath = cleanPath.replace(/\/+$/, '');
  return `${parsedUrl.protocol}//${parsedUrl.host}${cleanPath === '/' ? '' : cleanPath}`;
}

export async function validateExternalUrl(rawUrl: string): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new Error('URL inválida ou muito longa.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Formato de URL inválido. Informe um domínio ou URL com http:// ou https://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas protocolos HTTP e HTTPS são permitidos.');
  }

  if (isRestrictedHost(parsed.hostname)) {
    throw new Error('Endereços de rede privada ou local não são permitidos.');
  }

  return parsed;
}

class UpstreamFetchError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'UpstreamFetchError';
    this.statusCode = statusCode;
  }
}

function classifyFetchFailure(err: unknown, contextLabel: string): UpstreamFetchError {
  if (err instanceof UpstreamFetchError) {
    return err;
  }
  const msg = err instanceof Error ? err.message : '';
  const name = err instanceof Error ? err.name : '';

  if (
    /inválid|permitidos|muito longa|privada ou local/i.test(msg)
  ) {
    return new UpstreamFetchError(msg, 400);
  }

  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timeout|timed out|aborted/i.test(msg)
  ) {
    return new UpstreamFetchError(
      `Falha de conexão: o servidor ${contextLabel} demorou para responder (tempo esgotado).`,
      504,
    );
  }

  if (/redirecionamentos/i.test(msg)) {
    return new UpstreamFetchError(
      `Falha de conexão: excesso de redirecionamentos no servidor ${contextLabel}.`,
      502,
    );
  }

  return new UpstreamFetchError(
    `Falha de conexão com o servidor ${contextLabel}. Verifique o endereço DNS, protocolo (http/https) e porta.`,
    502,
  );
}

async function safeFetch(
  targetUrl: string,
  options: {timeoutMs?: number; headers?: Record<string, string>; maxRedirects?: number} = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 4;
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateExternalUrl(currentUrl);
    const res = await fetch(validated.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return res;
      }
      await res.body?.cancel().catch(() => {});
      currentUrl = new URL(location, validated).toString();
      continue;
    }
    return res;
  }

  throw new Error('Muitos redirecionamentos no servidor IPTV.');
}

// --- Stream Format, URL Redaction & Image Proxy Helpers ---

function redactUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    const segments = parsed.pathname.split('/');
    if (
      segments.length >= 5 &&
      (segments[1] === 'live' || segments[1] === 'movie' || segments[1] === 'series')
    ) {
      segments[2] = '***';
      segments[3] = '***';
      parsed.pathname = segments.join('/');
    }
    for (const key of ['username', 'password', 'user', 'pass', 'token', 'st']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return '[url-redacted]';
  }
}

function detectStreamFormat(extOrUrl: string): StreamFormatType {
  const clean = extOrUrl.split('?')[0].split('#')[0].trim().toLowerCase();
  const extMatch = clean.match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : clean.replace(/[^a-z0-9]/g, '');

  if (ext === 'm3u8' || clean.includes('.m3u8')) return 'hls';
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === 'webm') return 'mp4';
  if (ext === 'mkv') return 'mkv';
  if (ext === 'ts') return 'ts';
  if (
    ext === 'avi' ||
    ext === 'flv' ||
    ext === 'wmv' ||
    ext === 'mpg' ||
    ext === 'mpeg' ||
    ext === 'vob' ||
    ext === 'divx'
  ) {
    return 'unsupported';
  }
  return 'mp4';
}

async function createImageProxyUrl(imageUrl: string, env: WorkerEnv): Promise<string> {
  if (!imageUrl || !imageUrl.trim()) return '';
  const trimmed = imageUrl.trim();
  if (trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (!trimmed.startsWith('http://')) {
    return '';
  }
  const payload: StreamTokenPayload = {
    url: trimmed,
    exp: Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_SEC,
  };
  const signed = await encryptToken(payload, env);
  return `/api/iptv/image?st=${encodeURIComponent(signed)}`;
}

async function materializeMediaItem(
  raw: RawCatalogItem,
  env: WorkerEnv,
  includeDirectStream = false,
): Promise<MediaItem> {
  const poster = await createImageProxyUrl(raw.rawPoster, env);
  const banner = raw.rawBanner
    ? (await createImageProxyUrl(raw.rawBanner, env)) || poster
    : poster;

  const item: MediaItem = {
    id: raw.id,
    type: raw.type,
    title: raw.title,
    description: raw.description,
    poster,
    banner,
    genres: raw.genres.length ? raw.genres : [raw.categoryName || 'Catálogo'],
    categoryId: raw.categoryId,
    categoryName: raw.categoryName,
    year: raw.year,
    rating: raw.rating,
    channelNumber: raw.channelNumber,
  };

  if (includeDirectStream && raw.rawStreamUrl) {
    item.streamUrl = raw.rawStreamUrl;
    item.streamFormat = detectStreamFormat(raw.rawStreamUrl);
  } else if (raw.containerExt) {
    item.streamFormat = detectStreamFormat(raw.containerExt);
  }

  return item;
}

async function materializeMediaItems(
  rawItems: RawCatalogItem[],
  env: WorkerEnv,
  includeDirectStream = false,
): Promise<MediaItem[]> {
  return Promise.all(rawItems.map((raw) => materializeMediaItem(raw, env, includeDirectStream)));
}

function deduplicateTask<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }
  const promise = fn().finally(() => {
    inflightRequests.delete(key);
  });
  inflightRequests.set(key, promise);
  return promise;
}

// --- M3U Parser ---

function extractAttr(line: string, attr: string): string {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = line.match(re);
  return m ? m[1].trim() : '';
}

function inferM3UType(groupTitle: string, url: string, title: string): MediaType {
  const lowerUrl = url.toLowerCase();
  const lowerGroup = groupTitle.toLowerCase();
  const lowerTitle = title.toLowerCase();

  if (
    lowerUrl.includes('/series/') ||
    /s\d{1,2}\s*e\d{1,2}/i.test(lowerTitle) ||
    lowerGroup.includes('série') ||
    lowerGroup.includes('serie')
  ) {
    return 'series';
  }
  if (
    lowerUrl.includes('/movie/') ||
    /\.(mp4|mkv|avi|mov)(\?|$)/i.test(lowerUrl) ||
    lowerGroup.includes('filme') ||
    lowerGroup.includes('movie') ||
    lowerGroup.includes('vod')
  ) {
    return 'movie';
  }
  return 'live';
}

function slugGroupId(type: MediaType, groupName: string): string {
  const encoded = base64UrlEncode(textEncoder.encode(groupName)).slice(0, 24);
  return `m3u-${type}-${encoded}`;
}

function parseM3UPlaylistRaw(content: string): Record<MediaType, RawTypeCatalog> {
  const lines = content.split(/\r?\n/);
  const liveCategoriesMap = new Map<string, CategoryItem>();
  const movieCategoriesMap = new Map<string, CategoryItem>();
  const seriesCategoriesMap = new Map<string, CategoryItem>();

  const liveItems: RawCatalogItem[] = [];
  const movieItems: RawCatalogItem[] = [];
  const seriesItems: RawCatalogItem[] = [];

  let currentMeta: {
    name: string;
    logo: string;
    group: string;
  } | null = null;

  let index = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const commaIdx = line.lastIndexOf(',');
      const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const tvgName = extractAttr(line, 'tvg-name');
      const logo = extractAttr(line, 'tvg-logo');
      const group = extractAttr(line, 'group-title') || 'Geral';
      currentMeta = {
        name: displayName || tvgName || `Canal ${index + 1}`,
        logo,
        group,
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (currentMeta && (line.startsWith('http://') || line.startsWith('https://'))) {
      index += 1;
      const type = inferM3UType(currentMeta.group, line, currentMeta.name);
      const catId = slugGroupId(type, currentMeta.group);
      const itemId = `m3u-${index}`;

      const rawItem: RawCatalogItem = {
        id: itemId,
        type,
        title: currentMeta.name,
        description:
          type === 'live'
            ? `Transmissão ao vivo na categoria ${currentMeta.group}.`
            : `Conteúdo da lista conectada na categoria ${currentMeta.group}.`,
        rawPoster: currentMeta.logo,
        rawBanner: currentMeta.logo,
        genres: [currentMeta.group],
        categoryId: catId,
        categoryName: currentMeta.group,
        channelNumber: type === 'live' ? liveItems.length + 1 : undefined,
        rawStreamUrl: line,
      };

      if (type === 'live') {
        if (!liveCategoriesMap.has(catId)) {
          liveCategoriesMap.set(catId, {id: catId, name: currentMeta.group, type: 'live'});
        }
        liveItems.push(rawItem);
      } else if (type === 'movie') {
        if (!movieCategoriesMap.has(catId)) {
          movieCategoriesMap.set(catId, {id: catId, name: currentMeta.group, type: 'movie'});
        }
        movieItems.push(rawItem);
      } else {
        if (!seriesCategoriesMap.has(catId)) {
          seriesCategoriesMap.set(catId, {id: catId, name: currentMeta.group, type: 'series'});
        }
        seriesItems.push(rawItem);
      }
      currentMeta = null;
    }
  }

  const now = Date.now();
  return {
    live: {categories: [...liveCategoriesMap.values()], items: liveItems, fetchedAt: now},
    movie: {categories: [...movieCategoriesMap.values()], items: movieItems, fetchedAt: now},
    series: {categories: [...seriesCategoriesMap.values()], items: seriesItems, fetchedAt: now},
  };
}

// --- Xtream Codes Helpers ---

function formatDurationMinutes(value: unknown): {label?: string; seconds?: number} {
  if (!value) return {};
  const str = String(value).trim();
  if (!str) return {};

  if (/^\d+:\d{2}(:\d{2})?$/.test(str)) {
    const parts = str.split(':').map(Number);
    let totalSec = 0;
    if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
    if (totalSec <= 0) return {};
    const mins = Math.round(totalSec / 60);
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return {
      seconds: totalSec,
      label: hrs > 0 ? `${hrs}h ${rem}m` : `${mins} min`,
    };
  }

  const num = Number(str);
  if (!Number.isNaN(num) && num > 0) {
    const totalSec = num > 600 ? num : num * 60;
    const mins = Math.round(totalSec / 60);
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return {
      seconds: totalSec,
      label: hrs > 0 ? `${hrs}h ${rem}m` : `${mins} min`,
    };
  }
  return {};
}

function extractYear(raw: unknown): string | undefined {
  if (!raw) return undefined;
  const match = String(raw).match(/(19\d{2}|20\d{2})/);
  return match ? match[1] : undefined;
}

async function xtreamCall<T>(
  session: SessionTokenPayload,
  action: string,
  extraParams: Record<string, string> = {},
): Promise<T> {
  if (!session.serverUrl || !session.username || !session.password) {
    throw new Error('Sessão Xtream Codes inválida.');
  }
  const startedAt = Date.now();
  const url = new URL(`${session.serverUrl}/player_api.php`);
  url.searchParams.set('username', session.username);
  url.searchParams.set('password', session.password);
  if (action) url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, v);
  }
  const res = await safeFetch(url.toString(), {timeoutMs: XTREAM_TIMEOUT_MS});
  const durationMs = Date.now() - startedAt;
  if (!res.ok) {
    console.warn('[GreenPlay API] xtream error', {
      action,
      categoryId: extraParams.category_id || 'all',
      status: res.status,
      durationMs,
    });
    throw new Error(`O servidor IPTV respondeu com erro (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as T;
  console.info('[GreenPlay API] xtream', {
    action,
    categoryId: extraParams.category_id || 'all',
    durationMs,
  });
  return json;
}

async function getSessionScopeHash(session: SessionTokenPayload): Promise<string> {
  const identity =
    session.mode === 'm3u'
      ? `m3u:${session.m3uUrl || ''}`
      : `xtream:${session.serverUrl || ''}:${session.username || ''}`;
  return sha256Hex(identity);
}

function mapXtreamRawList(
  rawList: Array<Record<string, unknown>>,
  type: MediaType,
  catNameById: Map<string, string>,
): RawCatalogItem[] {
  return rawList.map((raw, idx) => {
    const id = String(
      type === 'series' ? (raw.series_id ?? raw.id ?? idx) : (raw.stream_id ?? raw.id ?? idx),
    );
    const categoryId = String(raw.category_id ?? '');
    const categoryName = catNameById.get(categoryId) || 'Catálogo';
    const title = String(raw.name || raw.title || `Item ${idx + 1}`).trim();
    const rawPoster = String(raw.stream_icon || raw.cover || '').trim();
    const backdropList = Array.isArray(raw.backdrop_path) ? raw.backdrop_path : [];
    const rawBanner = backdropList[0] ? String(backdropList[0]).trim() : rawPoster;
    const genres = raw.genre
      ? String(raw.genre)
          .split(/[,/|]/)
          .map((g) => g.trim())
          .filter(Boolean)
      : [categoryName];
    const year = extractYear(raw.releaseDate || raw.year || raw.added || title);
    const ratingVal = raw.rating ? String(raw.rating).trim() : undefined;
    const containerExt =
      type === 'live'
        ? 'm3u8'
        : raw.container_extension
          ? String(raw.container_extension).toLowerCase().replace(/[^a-z0-9]/g, '')
          : undefined;

    return {
      id,
      type,
      title,
      description: String(raw.plot || raw.description || '').trim(),
      rawPoster,
      rawBanner,
      genres: genres.length ? genres : [categoryName],
      categoryId,
      categoryName,
      year,
      rating: ratingVal && ratingVal !== '0' ? ratingVal : undefined,
      channelNumber: type === 'live' ? Number(raw.num || idx + 1) : undefined,
      containerExt,
    };
  });
}

async function ensureM3UCatalog(
  session: SessionTokenPayload,
  type: MediaType,
): Promise<RawTypeCatalog> {
  const scopeHash = await getSessionScopeHash(session);
  const cacheKey = `m3u-${scopeHash}-${type}`;
  const cached = await getCachedJson<RawTypeCatalog>(cacheKey);
  if (cached) return cached;

  return deduplicateTask(`task-m3u-${scopeHash}`, async () => {
    const again = await getCachedJson<RawTypeCatalog>(cacheKey);
    if (again) return again;

    if (!session.m3uUrl) {
      return {categories: [], items: [], fetchedAt: Date.now()};
    }
    const startedAt = Date.now();
    const res = await safeFetch(session.m3uUrl, {timeoutMs: 25000});
    if (!res.ok) {
      throw new Error(`Não foi possível acessar a lista M3U (HTTP ${res.status}).`);
    }
    const text = await res.text();
    const parsed = parseM3UPlaylistRaw(text);
    console.info('[GreenPlay API] m3u', {
      durationMs: Date.now() - startedAt,
      live: parsed.live.items.length,
      movie: parsed.movie.items.length,
      series: parsed.series.items.length,
    });
    await Promise.all([
      setCachedJson(`m3u-${scopeHash}-live`, parsed.live),
      setCachedJson(`m3u-${scopeHash}-movie`, parsed.movie),
      setCachedJson(`m3u-${scopeHash}-series`, parsed.series),
    ]);
    return parsed[type];
  });
}

async function loadCategoriesForType(
  session: SessionTokenPayload,
  type: MediaType,
): Promise<CategoryItem[]> {
  if (session.mode === 'm3u') {
    const m3u = await ensureM3UCatalog(session, type);
    return m3u.categories;
  }

  const scopeHash = await getSessionScopeHash(session);
  const cacheKey = `cats-${scopeHash}-${type}`;
  const cached = await getCachedJson<CategoryItem[]>(cacheKey);
  if (cached) return cached;

  return deduplicateTask(cacheKey, async () => {
    const again = await getCachedJson<CategoryItem[]>(cacheKey);
    if (again) return again;

    const catAction =
      type === 'live'
        ? 'get_live_categories'
        : type === 'movie'
          ? 'get_vod_categories'
          : 'get_series_categories';

    const rawCats = await xtreamCall<Array<{category_id: string | number; category_name: string}>>(
      session,
      catAction,
    );

    const categories: CategoryItem[] = Array.isArray(rawCats)
      ? rawCats.map((c) => ({
          id: String(c.category_id),
          name: String(c.category_name || 'Sem categoria').trim(),
          type,
        }))
      : [];

    await setCachedJson(cacheKey, categories);
    return categories;
  });
}

async function loadCategoryItems(
  session: SessionTokenPayload,
  type: MediaType,
  categoryId: string,
  categories: CategoryItem[],
): Promise<RawCatalogItem[]> {
  if (session.mode === 'm3u') {
    const m3u = await ensureM3UCatalog(session, type);
    return categoryId === 'all'
      ? m3u.items
      : m3u.items.filter((i) => i.categoryId === categoryId);
  }

  const scopeHash = await getSessionScopeHash(session);
  const cacheKey = `catitems-${scopeHash}-${type}-${categoryId}`;
  const cached = await getCachedJson<RawCatalogItem[]>(cacheKey);
  if (cached) return cached;

  return deduplicateTask(cacheKey, async () => {
    const again = await getCachedJson<RawCatalogItem[]>(cacheKey);
    if (again) return again;

    const streamAction =
      type === 'live'
        ? 'get_live_streams'
        : type === 'movie'
          ? 'get_vod_streams'
          : 'get_series';

    const catNameById = new Map(categories.map((c) => [c.id, c.name]));
    const rawItems = await xtreamCall<Array<Record<string, unknown>>>(session, streamAction, {
      category_id: categoryId,
    });
    const rawList = Array.isArray(rawItems) ? rawItems : [];
    const mapped = mapXtreamRawList(rawList, type, catNameById);
    await setCachedJson(cacheKey, mapped);
    return mapped;
  });
}

async function loadAllRawItemsForType(
  session: SessionTokenPayload,
  type: MediaType,
): Promise<RawTypeCatalog> {
  if (session.mode === 'm3u') {
    return ensureM3UCatalog(session, type);
  }

  const scopeHash = await getSessionScopeHash(session);
  const cacheKey = `allitems-${scopeHash}-${type}`;
  const cached = await getCachedJson<RawTypeCatalog>(cacheKey);
  if (cached) return cached;

  return deduplicateTask(cacheKey, async () => {
    const again = await getCachedJson<RawTypeCatalog>(cacheKey);
    if (again) return again;

    const streamAction =
      type === 'live'
        ? 'get_live_streams'
        : type === 'movie'
          ? 'get_vod_streams'
          : 'get_series';

    const [categories, rawItems] = await Promise.all([
      loadCategoriesForType(session, type).catch(() => [] as CategoryItem[]),
      xtreamCall<Array<Record<string, unknown>>>(session, streamAction),
    ]);

    const catNameById = new Map(categories.map((c) => [c.id, c.name]));
    const rawList = Array.isArray(rawItems) ? rawItems : [];
    const items = mapXtreamRawList(rawList, type, catNameById);

    const result: RawTypeCatalog = {categories, items, fetchedAt: Date.now()};
    await setCachedJson(cacheKey, result);
    return result;
  });
}

async function buildHomeSectionData(
  session: SessionTokenPayload,
  type: MediaType,
  env: WorkerEnv,
): Promise<HomeSectionResponse> {
  const startedAt = Date.now();
  if (session.mode === 'm3u') {
    const m3u = await ensureM3UCatalog(session, type);
    const items = await materializeMediaItems(m3u.items.slice(0, 18), env);
    const recentlyAdded =
      type === 'live'
        ? []
        : await materializeMediaItems(m3u.items.slice(-8).reverse(), env);
    return {
      type,
      categories: m3u.categories.slice(0, 24),
      items,
      recentlyAdded,
    };
  }

  const scopeHash = await getSessionScopeHash(session);
  const fullCached = await getCachedJson<RawTypeCatalog>(`allitems-${scopeHash}-${type}`);
  if (fullCached) {
    const items = await materializeMediaItems(fullCached.items.slice(0, 18), env);
    const recentlyAdded =
      type === 'live'
        ? []
        : await materializeMediaItems(fullCached.items.slice(-8).reverse(), env);
    return {
      type,
      categories: fullCached.categories.slice(0, 24),
      items,
      recentlyAdded,
    };
  }

  const categories = await loadCategoriesForType(session, type);
  let collected: RawCatalogItem[] = [];

  if (categories.length > 0) {
    // Load only the first 1-3 categories so the home feed opens fast without pulling 30k items
    const candidateCats = categories.slice(0, 3);
    for (const cat of candidateCats) {
      try {
        const catItems = await loadCategoryItems(session, type, cat.id, categories);
        if (catItems.length > 0) {
          collected = collected.concat(catItems);
        }
        if (collected.length >= 24) break;
      } catch {
        // If one category fails, continue with remaining categories
      }
    }
  } else {
    const full = await loadAllRawItemsForType(session, type);
    collected = full.items;
  }

  const [items, recentlyAdded] = await Promise.all([
    materializeMediaItems(collected.slice(0, 18), env),
    type === 'live'
      ? Promise.resolve([] as MediaItem[])
      : materializeMediaItems(collected.slice(-8).reverse(), env),
  ]);

  console.info('[GreenPlay API] home-section', {
    type,
    categories: categories.length,
    returned: items.length,
    durationMs: Date.now() - startedAt,
  });

  return {
    type,
    categories: categories.slice(0, 24),
    items,
    recentlyAdded,
  };
}

function buildDirectXtreamUrl(
  session: SessionTokenPayload,
  type: MediaType,
  id: string,
  ext?: string,
): {streamUrl: string; streamFormat: StreamFormatType} {
  const cleanUser = encodeURIComponent(session.username || '');
  const cleanPass = encodeURIComponent(session.password || '');
  const cleanId = encodeURIComponent(id);

  if (type === 'live') {
    const streamUrl = `${session.serverUrl}/live/${cleanUser}/${cleanPass}/${cleanId}.m3u8`;
    return {streamUrl, streamFormat: 'hls'};
  }

  const normalizedExt =
    (ext || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const segment = type === 'series' ? 'series' : 'movie';
  const streamUrl = `${session.serverUrl}/${segment}/${cleanUser}/${cleanPass}/${cleanId}.${normalizedExt}`;
  return {
    streamUrl,
    streamFormat: detectStreamFormat(normalizedExt),
  };
}

async function resolvePlaybackSource(
  session: SessionTokenPayload,
  type: MediaType,
  id: string,
): Promise<PlaybackSourceResponse> {
  if (session.mode === 'm3u') {
    const catalog = await ensureM3UCatalog(session, type);
    const found = catalog.items.find((item) => item.id === id);
    if (!found?.rawStreamUrl) {
      throw new Error('Fonte de reprodução não encontrada na lista M3U.');
    }
    const streamFormat = detectStreamFormat(found.rawStreamUrl);
    console.info('[GreenPlay Playback]', {
      mode: 'm3u',
      type,
      id,
      format: streamFormat,
      url: redactUrlForLog(found.rawStreamUrl),
    });
    return {streamUrl: found.rawStreamUrl, streamFormat};
  }

  if (!session.serverUrl || !session.username || !session.password) {
    throw new Error('Sessão Xtream Codes inválida.');
  }

  if (type === 'live') {
    const resolved = buildDirectXtreamUrl(session, 'live', id, 'm3u8');
    console.info('[GreenPlay Playback]', {
      mode: 'xtream',
      type,
      id,
      format: resolved.streamFormat,
      url: redactUrlForLog(resolved.streamUrl),
    });
    return resolved;
  }

  if (type === 'movie') {
    let streamId = id;
    let ext = 'mp4';
    try {
      const vodInfo = await xtreamCall<{movie_data?: Record<string, unknown>}>(
        session,
        'get_vod_info',
        {vod_id: id},
      );
      if (vodInfo?.movie_data) {
        if (vodInfo.movie_data.stream_id) {
          streamId = String(vodInfo.movie_data.stream_id);
        }
        if (vodInfo.movie_data.container_extension) {
          ext = String(vodInfo.movie_data.container_extension);
        }
      }
    } catch {
      // Fallback to default mp4 with requested id if get_vod_info is temporarily unavailable
    }
    const resolved = buildDirectXtreamUrl(session, 'movie', streamId, ext);
    console.info('[GreenPlay Playback]', {
      mode: 'xtream',
      type,
      id: streamId,
      format: resolved.streamFormat,
      url: redactUrlForLog(resolved.streamUrl),
    });
    return resolved;
  }

  const resolved = buildDirectXtreamUrl(session, 'series', id, 'mp4');
  console.info('[GreenPlay Playback]', {
    mode: 'xtream',
    type,
    id,
    format: resolved.streamFormat,
    url: redactUrlForLog(resolved.streamUrl),
  });
  return resolved;
}

// --- Response Helpers ---

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function resolveSession(
  request: Request,
  env: WorkerEnv,
): Promise<SessionTokenPayload | null> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return decryptToken<SessionTokenPayload>(token, env);
}

// --- Main Fetch Router ---

export async function handleApiRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  try {
    // Health check
    if (pathname === '/api/health' && method === 'GET') {
      return jsonResponse({status: 'ok'});
    }

    // Xtream Codes Auth
    if (pathname === '/api/auth/xtream' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        serverUrl?: string;
        username?: string;
        password?: string;
      };
      if (!body.serverUrl || !body.username || !body.password) {
        return jsonResponse({error: 'Informe a URL do servidor, usuário e senha.'}, 400);
      }

      const normalizedInput = normalizeServerInput(body.serverUrl);
      const parsedUrl = await validateExternalUrl(normalizedInput);
      const baseOrigin = buildXtreamBaseOrigin(parsedUrl);

      const authUrl = new URL(`${baseOrigin}/player_api.php`);
      authUrl.searchParams.set('username', body.username.trim());
      authUrl.searchParams.set('password', body.password);

      let upstreamRes: Response;
      try {
        upstreamRes = await safeFetch(authUrl.toString(), {timeoutMs: 12000});
      } catch (err) {
        const classified = classifyFetchFailure(err, 'IPTV');
        return jsonResponse({error: classified.message}, classified.statusCode);
      }

      if (upstreamRes.status === 404 || upstreamRes.status === 405 || upstreamRes.status === 410) {
        return jsonResponse(
          {
            error: `Servidor ou rota da API Xtream (/player_api.php) não encontrada (HTTP ${upstreamRes.status}). Verifique o DNS, o protocolo (http/https) e a porta, ou tente conectar pela aba "URL M3U Completa".`,
          },
          404,
        );
      }

      if (upstreamRes.status >= 500 || upstreamRes.status === 429) {
        return jsonResponse(
          {
            error: `Servidor IPTV indisponível no momento (HTTP ${upstreamRes.status}). Tente novamente em alguns instantes.`,
          },
          503,
        );
      }

      const rawBody = await upstreamRes.text().catch(() => '');

      type XtreamAuthPayload = {
        user_info?: {
          auth?: number | string;
          status?: string;
          exp_date?: string | null;
          max_connections?: string | number;
          active_cons?: string | number;
          username?: string;
        };
      };

      let data: XtreamAuthPayload | null = null;
      try {
        data = JSON.parse(rawBody) as XtreamAuthPayload;
      } catch {
        data = null;
      }

      if (upstreamRes.status === 401) {
        return jsonResponse(
          {error: 'Credenciais inválidas. Usuário ou senha IPTV incorretos (HTTP 401).'},
          401,
        );
      }

      if (upstreamRes.status === 403) {
        if (data?.user_info && String(data.user_info.auth) !== '1') {
          return jsonResponse(
            {error: 'Credenciais inválidas. Usuário ou senha IPTV incorretos.'},
            401,
          );
        }
        return jsonResponse(
          {
            error:
              'Acesso bloqueado pelo servidor IPTV (HTTP 403). Verifique suas credenciais ou se o provedor permite conexões externas.',
          },
          403,
        );
      }

      if (!upstreamRes.ok) {
        return jsonResponse(
          {error: `Falha ao validar no servidor IPTV (HTTP ${upstreamRes.status}).`},
          upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502,
        );
      }

      if (!data || typeof data !== 'object') {
        return jsonResponse(
          {
            error:
              'Servidor encontrado, mas não retornou uma resposta Xtream Codes válida na rota /player_api.php.',
          },
          422,
        );
      }

      const userInfo = data?.user_info;
      if (!userInfo || Array.isArray(userInfo) || String(userInfo.auth) !== '1') {
        return jsonResponse(
          {error: 'Credenciais inválidas. Usuário ou senha IPTV incorretos.'},
          401,
        );
      }

      const status = String(userInfo.status || 'Active');
      if (status.toLowerCase() !== 'active') {
        return jsonResponse(
          {error: `Conta IPTV com status "${status}". Verifique a validade com seu provedor.`},
          403,
        );
      }

      let expiresAt: string | undefined;
      if (userInfo.exp_date && /^\d+$/.test(String(userInfo.exp_date))) {
        const ts = Number(userInfo.exp_date) * 1000;
        if (ts > 0) {
          expiresAt = new Date(ts).toLocaleDateString('pt-BR');
        }
      }

      const info: AuthSessionInfo = {
        authenticated: true,
        mode: 'xtream',
        accountLabel: String(userInfo.username || body.username.trim()),
        serverHost: parsedUrl.host,
        status: 'Ativa',
        expiresAt,
        maxConnections: userInfo.max_connections ? String(userInfo.max_connections) : undefined,
        activeConnections: userInfo.active_cons ? String(userInfo.active_cons) : undefined,
        capabilities: {live: true, movies: true, series: true},
      };

      const tokenPayload: SessionTokenPayload = {
        mode: 'xtream',
        serverUrl: baseOrigin,
        username: body.username.trim(),
        password: body.password,
        info,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
      };
      const token = await encryptToken(tokenPayload, env);
      return jsonResponse({token, session: info});
    }

    // M3U URL Auth
    if (pathname === '/api/auth/m3u' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {m3uUrl?: string};
      if (!body.m3uUrl || !body.m3uUrl.trim()) {
        return jsonResponse({error: 'Informe a URL completa da lista M3U.'}, 400);
      }

      const parsed = await validateExternalUrl(normalizeServerInput(body.m3uUrl));
      let upstreamRes: Response;
      try {
        upstreamRes = await safeFetch(parsed.toString(), {timeoutMs: 20000});
      } catch (err) {
        const classified = classifyFetchFailure(err, 'da lista M3U');
        return jsonResponse({error: classified.message}, classified.statusCode);
      }

      if (upstreamRes.status === 404 || upstreamRes.status === 410) {
        return jsonResponse(
          {
            error: `Lista M3U não encontrada no endereço informado (HTTP ${upstreamRes.status}). Verifique a URL e os parâmetros.`,
          },
          404,
        );
      }
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        return jsonResponse(
          {
            error: `Credenciais inválidas ou acesso não autorizado à lista M3U (HTTP ${upstreamRes.status}).`,
          },
          upstreamRes.status,
        );
      }
      if (upstreamRes.status >= 500 || upstreamRes.status === 429) {
        return jsonResponse(
          {
            error: `Servidor da lista M3U indisponível no momento (HTTP ${upstreamRes.status}). Tente novamente em instantes.`,
          },
          503,
        );
      }
      if (!upstreamRes.ok) {
        return jsonResponse(
          {error: `Não foi possível acessar a lista M3U (HTTP ${upstreamRes.status}).`},
          502,
        );
      }

      const contentLength = Number(upstreamRes.headers.get('content-length') || 0);
      if (contentLength > MAX_M3U_BYTES) {
        return jsonResponse({error: 'A lista M3U excede o limite de tamanho suportado.'}, 413);
      }

      const text = await upstreamRes.text();
      if (textEncoder.encode(text).length > MAX_M3U_BYTES) {
        return jsonResponse({error: 'A lista M3U excede o limite de tamanho suportado.'}, 413);
      }
      if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
        return jsonResponse(
          {error: 'O link informado não contém uma playlist M3U válida.'},
          400,
        );
      }

      const parsedCatalog = parseM3UPlaylistRaw(text);
      const totalCount =
        parsedCatalog.live.items.length +
        parsedCatalog.movie.items.length +
        parsedCatalog.series.items.length;

      if (totalCount === 0) {
        return jsonResponse(
          {error: 'Nenhum canal ou conteúdo válido encontrado na lista M3U.'},
          400,
        );
      }

      const info: AuthSessionInfo = {
        authenticated: true,
        mode: 'm3u',
        accountLabel: `Lista M3U (${parsed.hostname})`,
        serverHost: parsed.host,
        status: 'Conectada',
        capabilities: {
          live: parsedCatalog.live.items.length > 0,
          movies: parsedCatalog.movie.items.length > 0,
          series: parsedCatalog.series.items.length > 0,
        },
      };

      const tokenPayload: SessionTokenPayload = {
        mode: 'm3u',
        m3uUrl: parsed.toString(),
        info,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
      };
      const scopeHash = await getSessionScopeHash(tokenPayload);
      await Promise.all([
        setCachedJson(`m3u-${scopeHash}-live`, parsedCatalog.live),
        setCachedJson(`m3u-${scopeHash}-movie`, parsedCatalog.movie),
        setCachedJson(`m3u-${scopeHash}-series`, parsedCatalog.series),
      ]);

      const token = await encryptToken(tokenPayload, env);
      return jsonResponse({token, session: info});
    }

    if (pathname === '/api/auth/session' && method === 'GET') {
      const session = await resolveSession(request, env);
      if (!session) return jsonResponse({authenticated: false});
      return jsonResponse(session.info);
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      return jsonResponse({ok: true});
    }

    // Owner-configured optional Live TV playlist
    if (pathname === '/api/iptv/owner-live' && method === 'GET') {
      const ownerUrl = env.DEFAULT_LIVE_PLAYLIST_URL?.trim();
      if (!ownerUrl) {
        return jsonResponse({configured: false, categories: [], channels: []});
      }
      try {
        const validated = await validateExternalUrl(ownerUrl);
        const upstreamRes = await safeFetch(validated.toString(), {timeoutMs: 15000});
        if (!upstreamRes.ok) {
          return jsonResponse({configured: true, error: 'Falha ao carregar playlist configurada.'}, 502);
        }
        const text = await upstreamRes.text();
        const parsed = parseM3UPlaylistRaw(text);
        const channels = await materializeMediaItems(parsed.live.items, env, true);
        return jsonResponse({
          configured: true,
          categories: parsed.live.categories,
          channels,
        });
      } catch {
        return jsonResponse({configured: true, error: 'Erro ao conectar à playlist ao vivo.'}, 502);
      }
    }

    // Direct playback avoids relaying full video streams through Cloudflare Workers
    if (pathname === '/api/iptv/stream' && method === 'GET') {
      return jsonResponse(
        {
          error:
            'Retransmissão de vídeo via Worker desativada. Utilize a URL direta autorizada pelo provedor.',
        },
        410,
      );
    }

    // Image proxy for HTTP provider covers (small static thumbnails cached for 24h)
    if (pathname === '/api/iptv/image' && method === 'GET') {
      const st = url.searchParams.get('st') || '';
      const payload = await decryptToken<StreamTokenPayload>(st, env);
      if (!payload?.url) {
        return new Response(null, {status: 404});
      }
      try {
        const upstreamRes = await safeFetch(payload.url, {timeoutMs: 8000});
        if (!upstreamRes.ok || !upstreamRes.body) {
          return new Response(null, {status: 404});
        }
        const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) {
          return new Response(null, {status: 400});
        }
        return new Response(upstreamRes.body, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch {
        return new Response(null, {status: 404});
      }
    }

    // Authenticated Catalog Routes
    const session = await resolveSession(request, env);
    if (!session) {
      return jsonResponse(
        {error: 'Sessão não autenticada ou expirada. Conecte sua lista IPTV.'},
        401,
      );
    }

    // Progressive single-type Home section (renders movies/series/live as soon as ready)
    if (pathname === '/api/iptv/home-section' && method === 'GET') {
      const rawType = url.searchParams.get('type') || 'movie';
      if (rawType !== 'movie' && rawType !== 'series' && rawType !== 'live') {
        return jsonResponse({error: 'Tipo de seção inválido.'}, 400);
      }
      const section = await buildHomeSectionData(session, rawType, env);
      return jsonResponse(section);
    }

    // Combined Home feed (uses fast per-category loading under the hood)
    if (pathname === '/api/iptv/home' && method === 'GET') {
      const [moviesRes, seriesRes, liveRes] = await Promise.allSettled([
        buildHomeSectionData(session, 'movie', env),
        buildHomeSectionData(session, 'series', env),
        buildHomeSectionData(session, 'live', env),
      ]);

      const moviesCat =
        moviesRes.status === 'fulfilled'
          ? moviesRes.value
          : {type: 'movie' as const, categories: [], items: [], recentlyAdded: []};
      const seriesCat =
        seriesRes.status === 'fulfilled'
          ? seriesRes.value
          : {type: 'series' as const, categories: [], items: [], recentlyAdded: []};
      const liveCat =
        liveRes.status === 'fulfilled'
          ? liveRes.value
          : {type: 'live' as const, categories: [], items: [], recentlyAdded: []};

      const featured = moviesCat.items[0] || seriesCat.items[0] || liveCat.items[0] || null;
      const recentlyAdded = [
        ...moviesCat.recentlyAdded.slice(0, 8),
        ...seriesCat.recentlyAdded.slice(0, 8),
      ].slice(0, 16);

      const response: HomeCatalogResponse = {
        featured,
        liveChannels: liveCat.items,
        popularMovies: moviesCat.items,
        popularSeries: seriesCat.items,
        recentlyAdded,
        categories: {
          movies: moviesCat.categories,
          series: seriesCat.categories,
          live: liveCat.categories,
        },
      };
      return jsonResponse(response);
    }

    // On-demand Direct Playback Resolver (avoids exposing credentials in bulk catalogs)
    if (pathname === '/api/iptv/play' && method === 'GET') {
      const rawType = url.searchParams.get('type') || 'movie';
      const id = (url.searchParams.get('id') || '').trim();
      if ((rawType !== 'movie' && rawType !== 'series' && rawType !== 'live') || !id) {
        return jsonResponse({error: 'Parâmetros de reprodução inválidos.'}, 400);
      }
      const resolved = await resolvePlaybackSource(session, rawType, id);
      return jsonResponse(resolved);
    }

    // Paginated & Category-scoped Catalog
    if (pathname === '/api/iptv/catalog' && method === 'GET') {
      const startedAt = Date.now();
      const rawType = url.searchParams.get('type') || 'movie';
      if (rawType !== 'movie' && rawType !== 'series' && rawType !== 'live') {
        return jsonResponse({error: 'Tipo de catálogo inválido.'}, 400);
      }

      const categoryId = url.searchParams.get('categoryId') || 'all';
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const genre = (url.searchParams.get('genre') || 'all').trim().toLowerCase();
      const year = (url.searchParams.get('year') || 'all').trim();
      const sort = url.searchParams.get('sort') || 'default';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = Math.min(80, Math.max(12, Number(url.searchParams.get('limit')) || 36));

      const categories = await loadCategoriesForType(session, rawType);
      const scopeHash = await getSessionScopeHash(session);

      let sourceItems: RawCatalogItem[] = [];
      let hasMoreCategories = false;

      if (session.mode === 'm3u') {
        const full = await ensureM3UCatalog(session, rawType);
        sourceItems =
          categoryId === 'all'
            ? full.items
            : full.items.filter((i) => i.categoryId === categoryId);
      } else if (categoryId !== 'all') {
        // Fast single-category fetch via Xtream category_id
        sourceItems = await loadCategoryItems(session, rawType, categoryId, categories);
      } else {
        const cachedFull = await getCachedJson<RawTypeCatalog>(`allitems-${scopeHash}-${rawType}`);
        if (cachedFull) {
          sourceItems = cachedFull.items;
        } else if (!q && genre === 'all' && year === 'all' && sort === 'default' && categories.length > 0) {
          // Progressive category-by-category loading: never fetch thousands of items on page 1
          // Also cap uncached upstream category calls per Worker invocation to stay well below Cloudflare's subrequest limit
          const targetNeeded = page * limit + 1;
          const progCacheKey = `prog-${scopeHash}-${rawType}`;
          const cachedProg = await getCachedJson<{nextCatIdx: number; items: RawCatalogItem[]}>(progCacheKey);
          let catIdx = cachedProg ? cachedProg.nextCatIdx : 0;
          sourceItems = cachedProg ? [...cachedProg.items] : [];
          let uncachedFetches = 0;
          const MAX_UNCACHED_FETCHES = 6;

          while (
            catIdx < categories.length &&
            sourceItems.length < targetNeeded &&
            uncachedFetches < MAX_UNCACHED_FETCHES
          ) {
            const batch = categories.slice(catIdx, catIdx + 2);
            const results = await Promise.allSettled(
              batch.map(async (c) => {
                const catCacheKey = `catitems-${scopeHash}-${rawType}-${c.id}`;
                const alreadyCached = await getCachedJson<RawCatalogItem[]>(catCacheKey);
                if (!alreadyCached) {
                  uncachedFetches += 1;
                }
                return loadCategoryItems(session, rawType, c.id, categories);
              }),
            );
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value.length > 0) {
                sourceItems = sourceItems.concat(r.value);
              }
            }
            catIdx += batch.length;
          }

          if (catIdx > (cachedProg?.nextCatIdx || 0)) {
            await setCachedJson(progCacheKey, {nextCatIdx: catIdx, items: sourceItems});
          }

          if (sourceItems.length < targetNeeded && catIdx < categories.length) {
            // If many tiny categories still weren't enough, fall back to a single-subrequest full fetch
            const full = await loadAllRawItemsForType(session, rawType);
            sourceItems = full.items;
            hasMoreCategories = false;
          } else {
            hasMoreCategories = catIdx < categories.length;
          }
        } else {
          const full = await loadAllRawItemsForType(session, rawType);
          sourceItems = full.items;
        }
      }

      const yearsSet = new Set<string>();
      const genresSet = new Set<string>();
      for (const item of sourceItems) {
        if (item.year) yearsSet.add(item.year);
        for (const g of item.genres) genresSet.add(g);
      }

      let filtered = sourceItems;
      if (genre !== 'all') {
        filtered = filtered.filter((item) =>
          item.genres.some((g) => g.toLowerCase() === genre),
        );
      }
      if (year !== 'all') {
        filtered = filtered.filter((item) => item.year === year);
      }
      if (q) {
        filtered = filtered.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.genres.some((g) => g.toLowerCase().includes(q)),
        );
      }

      if (sort === 'title_asc') {
        filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
      } else if (sort === 'title_desc') {
        filtered = [...filtered].sort((a, b) => b.title.localeCompare(a.title, 'pt-BR'));
      } else if (sort === 'year_desc') {
        filtered = [...filtered].sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
      } else if (sort === 'recent') {
        filtered = [...filtered].reverse();
      }

      const total = filtered.length;
      const computedPages = Math.max(1, Math.ceil(total / limit));
      const totalPages = hasMoreCategories ? Math.max(page + 1, computedPages) : computedPages;
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * limit;
      const rawPaged = filtered.slice(start, start + limit);
      const paged = await materializeMediaItems(rawPaged, env);

      console.info('[GreenPlay API] catalog', {
        type: rawType,
        categoryId,
        page: safePage,
        returned: paged.length,
        durationMs: Date.now() - startedAt,
      });

      const response: PaginatedCatalogResponse = {
        items: paged,
        total,
        page: safePage,
        totalPages,
        hasMore: hasMoreCategories || safePage < totalPages,
        categories,
        years: [...yearsSet].sort((a, b) => Number(b) - Number(a)),
        genres: [...genresSet].slice(0, 40),
      };
      return jsonResponse(response);
    }

    // Item Detail (/api/iptv/item/:type/:id)
    const itemMatch = pathname.match(/^\/api\/iptv\/item\/([^/]+)\/([^/]+)$/);
    if (itemMatch && method === 'GET') {
      const startedAt = Date.now();
      const type = decodeURIComponent(itemMatch[1]);
      const id = decodeURIComponent(itemMatch[2]);
      if (type !== 'movie' && type !== 'series' && type !== 'live') {
        return jsonResponse({error: 'Tipo inválido.'}, 400);
      }

      const scopeHash = await getSessionScopeHash(session);

      // Try locating item in already-cached categories or full cache before downloading entire catalog
      let baseRaw: RawCatalogItem | undefined;
      let poolForRelated: RawCatalogItem[] = [];

      if (session.mode === 'm3u') {
        const m3u = await ensureM3UCatalog(session, type);
        baseRaw = m3u.items.find((i) => i.id === id);
        poolForRelated = m3u.items;
      } else {
        const cachedFull = await getCachedJson<RawTypeCatalog>(`allitems-${scopeHash}-${type}`);
        if (cachedFull) {
          baseRaw = cachedFull.items.find((i) => i.id === id);
          poolForRelated = cachedFull.items;
        } else {
          // Search cached per-category entries for this user first
          const prefix = `catitems-${scopeHash}-${type}-`;
          for (const [k, v] of memoryCatalogCache.entries()) {
            if (k.startsWith(prefix) && v.expiresAt > Date.now()) {
              const catArr = v.data as RawCatalogItem[];
              const hit = catArr.find((i) => i.id === id);
              if (hit) {
                baseRaw = hit;
                poolForRelated = catArr;
                break;
              }
            }
          }
        }
      }

      const relatedRaw = baseRaw
        ? poolForRelated
            .filter((i) => i.id !== id && i.categoryId === baseRaw!.categoryId)
            .slice(0, 12)
        : [];
      const related = await materializeMediaItems(relatedRaw, env);

      if (type === 'movie') {
        if (session.mode === 'xtream') {
          const detailKey = `mov-${scopeHash}-${id}`;
          const cached = await getCachedJson<MediaItem>(detailKey);
          if (cached) {
            return jsonResponse({item: cached, related});
          }
          try {
            const vodInfo = await xtreamCall<{
              info?: Record<string, unknown>;
              movie_data?: Record<string, unknown>;
            }>(session, 'get_vod_info', {vod_id: id});

            const info = vodInfo?.info || {};
            const movieData = vodInfo?.movie_data || {};
            const dur = formatDurationMinutes(info.duration || info.duration_secs);
            const backdropList = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
            const bannerRaw = backdropList[0]
              ? String(backdropList[0])
              : String(info.movie_image || baseRaw?.rawBanner || '');
            const posterRaw = String(info.movie_image || baseRaw?.rawPoster || '');
            const poster = await createImageProxyUrl(posterRaw, env);
            const banner = (await createImageProxyUrl(bannerRaw, env)) || poster;

            const streamId = String(movieData.stream_id || id);
            const ext = String(
              movieData.container_extension || baseRaw?.containerExt || 'mp4',
            );
            const direct =
              session.serverUrl && session.username && session.password
                ? buildDirectXtreamUrl(session, 'movie', streamId, ext)
                : undefined;

            const enriched: MediaItem = {
              id,
              type: 'movie',
              title: String(movieData.name || info.name || baseRaw?.title || `Filme ${id}`).trim(),
              description: String(
                info.plot || info.description || baseRaw?.description || '',
              ).trim(),
              poster,
              banner,
              year: extractYear(info.releasedate || info.releaseDate) || baseRaw?.year,
              duration: dur.label,
              durationSeconds: dur.seconds,
              genres: info.genre
                ? String(info.genre)
                    .split(/[,/|]/)
                    .map((g) => g.trim())
                    .filter(Boolean)
                : baseRaw?.genres || ['Filme'],
              categoryId: String(movieData.category_id || baseRaw?.categoryId || ''),
              categoryName: baseRaw?.categoryName,
              rating: info.rating ? String(info.rating) : baseRaw?.rating,
              streamUrl: direct?.streamUrl,
              streamFormat: direct?.streamFormat,
            };

            if (direct) {
              console.info('[GreenPlay Playback]', {
                type: 'movie',
                id: streamId,
                format: direct.streamFormat,
                url: redactUrlForLog(direct.streamUrl),
                durationMs: Date.now() - startedAt,
              });
            }

            await setCachedJson(detailKey, enriched);
            return jsonResponse({item: enriched, related});
          } catch {
            // Fall back to baseRaw + direct stream URL if available
          }
        }

        if (!baseRaw) {
          return jsonResponse({error: 'Conteúdo não encontrado na sua lista.'}, 404);
        }
        const materialized = await materializeMediaItem(baseRaw, env, session.mode === 'm3u');
        if (session.mode === 'xtream' && !materialized.streamUrl) {
          const direct = buildDirectXtreamUrl(
            session,
            'movie',
            baseRaw.id,
            baseRaw.containerExt || 'mp4',
          );
          materialized.streamUrl = direct.streamUrl;
          materialized.streamFormat = direct.streamFormat;
        }
        return jsonResponse({item: materialized, related});
      }

      if (type === 'series') {
        if (session.mode === 'xtream') {
          const detailKey = `ser-${scopeHash}-${id}`;
          const cached = await getCachedJson<SeriesDetail>(detailKey);
          if (cached) {
            return jsonResponse({item: cached, related});
          }
          try {
            const seriesData = await xtreamCall<{
              info?: Record<string, unknown>;
              episodes?: Record<string, Array<Record<string, unknown>>>;
              seasons?: Array<Record<string, unknown>>;
            }>(session, 'get_series_info', {series_id: id});

            const info = seriesData?.info || {};
            const rawEpisodesBySeason = seriesData?.episodes || {};
            const seasonMetaList = Array.isArray(seriesData?.seasons) ? seriesData.seasons : [];

            const seasons: SeasonGroup[] = await Promise.all(
              Object.entries(rawEpisodesBySeason).map(async ([seasonKey, eps]) => {
                const seasonNum = Number(seasonKey) || 1;
                const sMeta = seasonMetaList.find((s) => Number(s.season_number) === seasonNum);
                const episodes: EpisodeItem[] = await Promise.all(
                  (Array.isArray(eps) ? eps : []).map(async (ep, epIdx) => {
                    const epId = ep.id ? String(ep.id) : '';
                    const epNum = Number(ep.episode_num || epIdx + 1);
                    const ext = String(ep.container_extension || 'mp4');
                    const epInfo = (ep.info as Record<string, unknown>) || {};
                    const dur = formatDurationMinutes(epInfo.duration || epInfo.duration_secs);

                    let streamUrl: string | undefined;
                    let streamFormat: StreamFormatType = detectStreamFormat(ext);
                    if (epId && session.serverUrl && session.username && session.password) {
                      const direct = buildDirectXtreamUrl(session, 'series', epId, ext);
                      streamUrl = direct.streamUrl;
                      streamFormat = direct.streamFormat;
                    }

                    return {
                      id: epId || `${id}-${seasonNum}-${epIdx + 1}`,
                      seriesId: id,
                      seasonNumber: seasonNum,
                      episodeNumber: epNum,
                      title: String(ep.title || `Episódio ${epNum}`).trim(),
                      description: String(epInfo.plot || '').trim(),
                      duration: dur.label,
                      durationSeconds: dur.seconds,
                      thumbnail: await createImageProxyUrl(
                        String(epInfo.movie_image || info.cover || ''),
                        env,
                      ),
                      streamUrl,
                      streamFormat,
                    };
                  }),
                );

                episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
                return {
                  seasonNumber: seasonNum,
                  name: String(sMeta?.name || `Temporada ${seasonNum}`),
                  episodes,
                };
              }),
            );
            seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

            const backdropList = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
            const bannerRaw = backdropList[0]
              ? String(backdropList[0])
              : String(info.cover || baseRaw?.rawBanner || '');
            const poster = await createImageProxyUrl(
              String(info.cover || baseRaw?.rawPoster || ''),
              env,
            );
            const banner = (await createImageProxyUrl(bannerRaw, env)) || poster;

            const detail: SeriesDetail = {
              id,
              type: 'series',
              title: String(info.name || baseRaw?.title || `Série ${id}`).trim(),
              description: String(info.plot || baseRaw?.description || '').trim(),
              poster,
              banner,
              year: extractYear(info.releaseDate) || baseRaw?.year,
              genres: info.genre
                ? String(info.genre)
                    .split(/[,/|]/)
                    .map((g) => g.trim())
                    .filter(Boolean)
                : baseRaw?.genres || ['Série'],
              categoryId: String(info.category_id || baseRaw?.categoryId || ''),
              categoryName: baseRaw?.categoryName,
              rating: info.rating ? String(info.rating) : baseRaw?.rating,
              seasons,
            };

            console.info('[GreenPlay API] series-detail', {
              seriesId: id,
              seasons: seasons.length,
              durationMs: Date.now() - startedAt,
            });

            await setCachedJson(detailKey, detail);
            return jsonResponse({item: detail, related});
          } catch {
            // Fall through
          }
        }

        if (!baseRaw) {
          return jsonResponse({error: 'Série não encontrada na sua lista.'}, 404);
        }
        const materialized = await materializeMediaItem(baseRaw, env, session.mode === 'm3u');
        const fallbackDetail: SeriesDetail = {
          ...materialized,
          seasons: materialized.streamUrl
            ? [
                {
                  seasonNumber: 1,
                  name: 'Temporada 1',
                  episodes: [
                    {
                      id: `${materialized.id}-ep1`,
                      seriesId: materialized.id,
                      seasonNumber: 1,
                      episodeNumber: 1,
                      title: materialized.title,
                      description: materialized.description,
                      streamUrl: materialized.streamUrl,
                      streamFormat: materialized.streamFormat,
                    },
                  ],
                },
              ]
            : [],
        };
        return jsonResponse({item: fallbackDetail, related});
      }

      if (!baseRaw) {
        return jsonResponse({error: 'Conteúdo não encontrado na sua lista.'}, 404);
      }
      const materialized = await materializeMediaItem(baseRaw, env, true);
      return jsonResponse({item: materialized, related});
    }

    // Global Search
    if (pathname === '/api/iptv/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) {
        return jsonResponse({movies: [], series: [], live: [], episodes: []} satisfies GlobalSearchResponse);
      }

      const scopeHash = await getSessionScopeHash(session);
      const [moviesRes, seriesRes, liveRes] = await Promise.allSettled([
        loadAllRawItemsForType(session, 'movie'),
        loadAllRawItemsForType(session, 'series'),
        loadAllRawItemsForType(session, 'live'),
      ]);

      const rawMovies =
        moviesRes.status === 'fulfilled'
          ? moviesRes.value.items.filter((i) => i.title.toLowerCase().includes(q)).slice(0, 18)
          : [];
      const rawSeries =
        seriesRes.status === 'fulfilled'
          ? seriesRes.value.items.filter((i) => i.title.toLowerCase().includes(q)).slice(0, 18)
          : [];
      const rawLive =
        liveRes.status === 'fulfilled'
          ? liveRes.value.items.filter((i) => i.title.toLowerCase().includes(q)).slice(0, 18)
          : [];

      const [movies, series, live] = await Promise.all([
        materializeMediaItems(rawMovies, env),
        materializeMediaItems(rawSeries, env),
        materializeMediaItems(rawLive, env),
      ]);

      // Search cached series details scoped strictly to the current user's scopeHash
      const episodes: GlobalSearchResponse['episodes'] = [];
      const serPrefix = `ser-${scopeHash}-`;
      for (const [cacheKey, entry] of memoryCatalogCache.entries()) {
        if (!cacheKey.startsWith(serPrefix) || entry.expiresAt <= Date.now()) continue;
        const candidate = entry.data as Partial<SeriesDetail> | undefined;
        if (candidate && Array.isArray(candidate.seasons) && candidate.title) {
          for (const season of candidate.seasons) {
            for (const ep of season.episodes) {
              if (ep.title.toLowerCase().includes(q)) {
                episodes.push({
                  ...ep,
                  seriesTitle: candidate.title,
                  seriesPoster: candidate.poster || '',
                });
              }
            }
          }
        }
      }

      return jsonResponse({
        movies,
        series,
        live,
        episodes: episodes.slice(0, 18),
      } satisfies GlobalSearchResponse);
    }

    return jsonResponse({error: 'Rota interna da API não encontrada.'}, 404);
  } catch (err) {
    const classified = classifyFetchFailure(err, 'IPTV');
    return jsonResponse({error: classified.message}, classified.statusCode);
  }
}
