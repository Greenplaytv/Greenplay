import type {
  AuthSessionInfo,
  CategoryItem,
  GlobalSearchResponse,
  HomeCatalogResponse,
  HomeSectionResponse,
  MediaItem,
  MediaType,
  PaginatedCatalogResponse,
  PlaybackSourceResponse,
  SeriesDetail,
  SessionCheckResponse,
} from '../types/catalog';

type InMemoryAuthCredentials =
  | {mode: 'xtream'; serverUrl: string; username: string; password: string}
  | {mode: 'm3u'; m3uUrl: string};

// Session token & renewal credentials are held strictly in JS memory (never localStorage or sessionStorage)
let inMemoryBearerToken: string | null = null;
let inMemoryAuthCredentials: InMemoryAuthCredentials | null = null;
let authEpoch = 0;

const CLIENT_CACHE_TTL_MS = 3 * 60 * 1000;
const clientResponseCache = new Map<string, {data: unknown; expiresAt: number}>();
const inflightGetRequests = new Map<string, Promise<unknown>>();
let inflightRefreshPromise: Promise<boolean> | null = null;
let sessionExpiredListener: ((message: string) => void) | null = null;

export function setSessionExpiredListener(cb: ((message: string) => void) | null) {
  sessionExpiredListener = cb;
}

export function setAuthToken(token: string | null) {
  if (inMemoryBearerToken !== token) {
    authEpoch += 1;
    clientResponseCache.clear();
    inflightGetRequests.clear();
    inflightRefreshPromise = null;
  }
  inMemoryBearerToken = token;
  if (!token) {
    inMemoryAuthCredentials = null;
  }
}

export function hasAuthToken(): boolean {
  return Boolean(inMemoryBearerToken);
}

async function renewSessionToken(expectedEpoch: number): Promise<boolean> {
  if (!inMemoryAuthCredentials || expectedEpoch !== authEpoch) {
    return false;
  }
  if (inflightRefreshPromise) {
    return inflightRefreshPromise;
  }

  const creds = inMemoryAuthCredentials;
  inflightRefreshPromise = (async () => {
    try {
      const endpoint = creds.mode === 'xtream' ? '/api/auth/xtream' : '/api/auth/m3u';
      const body =
        creds.mode === 'xtream'
          ? {serverUrl: creds.serverUrl, username: creds.username, password: creds.password}
          : {m3uUrl: creds.m3uUrl};

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'GreenPlay-SPA',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return false;
      }
      const data = (await res.json().catch(() => null)) as {token?: string} | null;
      if (!data?.token || expectedEpoch !== authEpoch) {
        return false;
      }

      // Refresh token silently without clearing cached catalog entries
      inMemoryBearerToken = data.token;
      console.info('[GreenPlay Auth] Sessão renovada automaticamente');
      return true;
    } catch {
      return false;
    } finally {
      inflightRefreshPromise = null;
    }
  })();

  return inflightRefreshPromise;
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: {cacheTtlMs?: number} = {},
): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const epochAtCall = authEpoch;
  const cacheKey = `${epochAtCall}:${path}`;

  if (method === 'GET' && options.cacheTtlMs) {
    const cached = clientResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as T;
    }
    if (cached) {
      clientResponseCache.delete(cacheKey);
    }
  }

  if (method === 'GET') {
    const pending = inflightGetRequests.get(cacheKey) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }
  }

  const executeAttempt = async (allowRenewRetries: number): Promise<T> => {
    const startedAt = performance.now();
    const headers = new Headers(init.headers);
    headers.set('X-Requested-With', 'GreenPlay-SPA');
    if (inMemoryBearerToken) {
      headers.set('Authorization', `Bearer ${inMemoryBearerToken}`);
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let res: Response;
    try {
      res = await fetch(path, {
        ...init,
        credentials: 'same-origin',
        headers,
      });
    } catch {
      throw new Error(
        'Falha de conexão ao comunicar com o servidor. Verifique sua internet e tente novamente.',
      );
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const cleanEndpoint = path.split('?')[0];
    console.info('[GreenPlay API]', {endpoint: cleanEndpoint, status: res.status, durationMs});

    const data = (await res.json().catch(() => ({}))) as T & {
      error?: string;
      expired?: boolean;
    };

    if (res.status === 401 && data?.expired) {
      const msg =
        data.error || 'A validade desta lista IPTV expirou. Conecte uma nova lista.';
      setAuthToken(null);
      sessionExpiredListener?.(msg);
      throw new Error(msg);
    }

    // If a Worker isolate restarted/switched without shared SESSION_SECRET, renew seamlessly once
    if (
      res.status === 401 &&
      allowRenewRetries > 0 &&
      !path.startsWith('/api/auth/') &&
      inMemoryAuthCredentials &&
      epochAtCall === authEpoch
    ) {
      const renewed = await renewSessionToken(epochAtCall);
      if (renewed && epochAtCall === authEpoch) {
        return executeAttempt(allowRenewRetries - 1);
      }
    }

    if (!res.ok) {
      if (data?.error) {
        throw new Error(data.error);
      }
      if (res.status === 404) {
        throw new Error('Servidor ou rota da API não encontrada (HTTP 404).');
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Credenciais inválidas ou acesso não autorizado (HTTP ${res.status}).`);
      }
      if (res.status >= 500) {
        throw new Error(`Servidor indisponível no momento (HTTP ${res.status}).`);
      }
      throw new Error(`Erro na requisição (HTTP ${res.status}).`);
    }

    if (method === 'GET' && options.cacheTtlMs && epochAtCall === authEpoch) {
      clientResponseCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + options.cacheTtlMs,
      });
      if (clientResponseCache.size > 120) {
        const oldestKey = clientResponseCache.keys().next().value;
        if (oldestKey) clientResponseCache.delete(oldestKey);
      }
    }

    return data;
  };

  if (method === 'GET') {
    const promise = executeAttempt(2).finally(() => {
      inflightGetRequests.delete(cacheKey);
    });
    inflightGetRequests.set(cacheKey, promise);
    return promise;
  }

  return executeAttempt(2);
}

export async function loginXtream(params: {
  serverUrl: string;
  username: string;
  password: string;
}): Promise<{token: string; session: AuthSessionInfo}> {
  const result = await apiFetch<{token: string; session: AuthSessionInfo}>('/api/auth/xtream', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  setAuthToken(result.token);
  inMemoryAuthCredentials = {
    mode: 'xtream',
    serverUrl: params.serverUrl,
    username: params.username,
    password: params.password,
  };
  return result;
}

export async function loginM3U(params: {
  m3uUrl: string;
}): Promise<{token: string; session: AuthSessionInfo}> {
  const result = await apiFetch<{token: string; session: AuthSessionInfo}>('/api/auth/m3u', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  setAuthToken(result.token);
  inMemoryAuthCredentials = {
    mode: 'm3u',
    m3uUrl: params.m3uUrl,
  };
  return result;
}

export async function checkSavedSession(): Promise<SessionCheckResponse> {
  return apiFetch<SessionCheckResponse>('/api/auth/session', {
    method: 'GET',
    cache: 'no-store',
  });
}

export async function logoutIptv(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', {method: 'POST'});
  } catch {
    // Always clear client state even if offline
  } finally {
    setAuthToken(null);
  }
}

export async function fetchHomeCatalog(): Promise<HomeCatalogResponse> {
  return apiFetch<HomeCatalogResponse>('/api/iptv/home', {}, {cacheTtlMs: CLIENT_CACHE_TTL_MS});
}

export async function fetchHomeSection(type: MediaType): Promise<HomeSectionResponse> {
  return apiFetch<HomeSectionResponse>(
    `/api/iptv/home-section?type=${encodeURIComponent(type)}`,
    {},
    {cacheTtlMs: CLIENT_CACHE_TTL_MS},
  );
}

export async function fetchPlaybackSource(
  type: MediaType,
  id: string,
): Promise<PlaybackSourceResponse> {
  return apiFetch<PlaybackSourceResponse>(
    `/api/iptv/play?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
  );
}

export async function fetchCatalogPage(params: {
  type: MediaType;
  categoryId?: string;
  q?: string;
  genre?: string;
  year?: string;
  sort?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedCatalogResponse> {
  const search = new URLSearchParams();
  search.set('type', params.type);
  if (params.categoryId) search.set('categoryId', params.categoryId);
  if (params.q) search.set('q', params.q);
  if (params.genre) search.set('genre', params.genre);
  if (params.year) search.set('year', params.year);
  if (params.sort) search.set('sort', params.sort);
  if (params.page) search.set('page', String(params.page));
  if (params.limit) search.set('limit', String(params.limit));
  return apiFetch<PaginatedCatalogResponse>(
    `/api/iptv/catalog?${search.toString()}`,
    {},
    {cacheTtlMs: CLIENT_CACHE_TTL_MS},
  );
}

export async function fetchItemDetail(
  type: MediaType,
  id: string,
): Promise<{item: MediaItem | SeriesDetail; related: MediaItem[]}> {
  return apiFetch<{item: MediaItem | SeriesDetail; related: MediaItem[]}>(
    `/api/iptv/item/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    {},
    {cacheTtlMs: CLIENT_CACHE_TTL_MS},
  );
}

export async function searchGlobalCatalog(q: string): Promise<GlobalSearchResponse> {
  return apiFetch<GlobalSearchResponse>(
    `/api/iptv/search?q=${encodeURIComponent(q)}`,
    {},
    {cacheTtlMs: 60 * 1000},
  );
}

export async function fetchOwnerLivePlaylist(): Promise<{
  configured: boolean;
  categories: CategoryItem[];
  channels: MediaItem[];
  error?: string;
}> {
  return apiFetch('/api/iptv/owner-live', {}, {cacheTtlMs: CLIENT_CACHE_TTL_MS});
}
