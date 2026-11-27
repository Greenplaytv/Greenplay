import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AccountModal} from './components/AccountModal';
import {BrandLogo} from './components/BrandLogo';
import {Header, type AppRoute} from './components/Header';
import {OfflineIndicator} from './components/OfflineIndicator';
import {ValidityCountdown} from './components/ValidityCountdown';
import {VideoPlayerModal} from './components/VideoPlayerModal';
import {getDemoHomeCatalog, getDemoItemDetail} from './data/demoCatalog';
import {useUserLibrary} from './hooks/useUserLibrary';
import {CatalogPage} from './pages/CatalogPage';
import {DetailPage} from './pages/DetailPage';
import {HomePage} from './pages/HomePage';
import {LiveTVPage} from './pages/LiveTVPage';
import {LoginPage} from './pages/LoginPage';
import {MyListPage} from './pages/MyListPage';
import {SearchPage} from './pages/SearchPage';
import {
  checkSavedSession,
  fetchHomeSection,
  fetchItemDetail,
  fetchPlaybackSource,
  logoutIptv,
  setSessionExpiredListener,
} from './services/iptvApi';
import type {
  AuthSessionInfo,
  ContinueWatchingEntry,
  EpisodeItem,
  HomeCatalogResponse,
  MediaItem,
  MediaType,
  PlayerTarget,
  SeriesDetail,
} from './types/catalog';

const DEMO_SESSION: AuthSessionInfo = {
  authenticated: false,
  mode: 'demo',
  accountLabel: 'Demonstração',
  capabilities: {live: false, movies: true, series: true},
};

const NAV_STORAGE_PREFIX = 'greenplay_nav_state:';
const SAFE_NAV_ROUTES: AppRoute[] = ['home', 'movies', 'series', 'live', 'mylist', 'detail'];

interface SavedNavState {
  route: AppRoute;
  catalogCategoryFilter: string;
  detailTarget: {type: 'movie' | 'series'; id: string} | null;
}

function getAccountScope(s: AuthSessionInfo | null): string {
  return s?.authenticated
    ? `${s.mode}:${s.serverHost || ''}:${s.accountLabel}`
    : 'demo';
}

function loadSavedNavState(scope: string): SavedNavState | null {
  try {
    const raw = localStorage.getItem(`${NAV_STORAGE_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedNavState>;
    if (!parsed.route || !SAFE_NAV_ROUTES.includes(parsed.route)) return null;
    if (
      parsed.route === 'detail' &&
      (!parsed.detailTarget ||
        (parsed.detailTarget.type !== 'movie' && parsed.detailTarget.type !== 'series') ||
        typeof parsed.detailTarget.id !== 'string' ||
        !parsed.detailTarget.id)
    ) {
      return null;
    }
    return {
      route: parsed.route,
      catalogCategoryFilter:
        typeof parsed.catalogCategoryFilter === 'string' && parsed.catalogCategoryFilter
          ? parsed.catalogCategoryFilter
          : 'all',
      detailTarget: parsed.detailTarget ?? null,
    };
  } catch {
    return null;
  }
}

function clearSavedNavState(scope: string) {
  try {
    localStorage.removeItem(`${NAV_STORAGE_PREFIX}${scope}`);
  } catch {
    // Ignore storage access errors
  }
}

export default function App() {
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [route, setRoute] = useState<AppRoute>('home');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>('all');
  const [detailTarget, setDetailTarget] = useState<{
    type: 'movie' | 'series';
    id: string;
  } | null>(null);
  const [previousRoute, setPreviousRoute] = useState<AppRoute>('home');

  const [homeCatalog, setHomeCatalog] = useState<HomeCatalogResponse | null>(null);
  const [sectionLoading, setSectionLoading] = useState<Record<MediaType, boolean>>({
    movie: false,
    series: false,
    live: false,
  });
  const [sectionErrors, setSectionErrors] = useState<Record<MediaType, string | null>>({
    movie: null,
    series: null,
    live: null,
  });
  const loadedScopeRef = useRef<string | null>(null);
  const sessionRef = useRef<AuthSessionInfo | null>(null);
  const expiringRef = useRef(false);

  const [playerTarget, setPlayerTarget] = useState<PlayerTarget | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);

  sessionRef.current = session;
  const accountScope = getAccountScope(session);

  const {
    favorites,
    history,
    isFavorite,
    toggleFavorite,
    removeFavorite,
    upsertContinueWatching,
    getSavedPosition,
  } = useUserLibrary(accountScope);

  const isDemoMode = !session || session.mode === 'demo';

  const loadSingleSection = useCallback(
    async (type: MediaType, activeScope: string) => {
      setSectionLoading((prev) => ({...prev, [type]: true}));
      setSectionErrors((prev) => ({...prev, [type]: null}));
      try {
        const res = await fetchHomeSection(type);
        if (loadedScopeRef.current !== activeScope) return;
        setHomeCatalog((prev) => {
          const base: HomeCatalogResponse = prev || {
            featured: null,
            liveChannels: [],
            popularMovies: [],
            popularSeries: [],
            recentlyAdded: [],
            categories: {movies: [], series: [], live: []},
          };
          const nextMovies = type === 'movie' ? res.items : base.popularMovies;
          const nextSeries = type === 'series' ? res.items : base.popularSeries;
          const nextLive = type === 'live' ? res.items : base.liveChannels;
          const nextFeatured =
            base.featured || nextMovies[0] || nextSeries[0] || nextLive[0] || null;
          const nextRecent =
            type === 'live'
              ? base.recentlyAdded
              : [
                  ...(type === 'movie' ? res.recentlyAdded.slice(0, 8) : base.popularMovies.slice(-8).reverse()),
                  ...(type === 'series' ? res.recentlyAdded.slice(0, 8) : base.popularSeries.slice(-8).reverse()),
                ].slice(0, 16);

          return {
            featured: nextFeatured,
            popularMovies: nextMovies,
            popularSeries: nextSeries,
            liveChannels: nextLive,
            recentlyAdded: nextRecent,
            categories: {
              movies: type === 'movie' ? res.categories : base.categories.movies,
              series: type === 'series' ? res.categories : base.categories.series,
              live: type === 'live' ? res.categories : base.categories.live,
            },
          };
        });
      } catch (err) {
        if (loadedScopeRef.current !== activeScope) return;
        setSectionErrors((prev) => ({
          ...prev,
          [type]:
            err instanceof Error
              ? err.message
              : 'Erro ao carregar esta seção.',
        }));
      } finally {
        if (loadedScopeRef.current === activeScope) {
          setSectionLoading((prev) => ({...prev, [type]: false}));
        }
      }
    },
    [],
  );

  const loadHome = useCallback(
    (activeSession: AuthSessionInfo, force = false) => {
      const scope = activeSession.authenticated
        ? `${activeSession.mode}:${activeSession.serverHost || ''}:${activeSession.accountLabel}`
        : 'demo';

      if (!force && loadedScopeRef.current === scope) {
        return;
      }
      loadedScopeRef.current = scope;

      if (activeSession.mode === 'demo') {
        setHomeCatalog(getDemoHomeCatalog());
        setSectionLoading({movie: false, series: false, live: false});
        setSectionErrors({movie: null, series: null, live: null});
        return;
      }

      setHomeCatalog(null);
      // Load movies, series, and live independently so the first ready data renders immediately
      void loadSingleSection('movie', scope);
      void loadSingleSection('series', scope);
      void loadSingleSection('live', scope);
    },
    [loadSingleSection],
  );

  useEffect(() => {
    if (session) {
      loadHome(session);
    }
  }, [session, loadHome]);

  const handleNavigate = (next: AppRoute) => {
    if (next !== 'detail') {
      setCatalogCategoryFilter('all');
    }
    setRoute(next);
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const handleNavigateCatalog = (type: MediaType, categoryId?: string) => {
    setCatalogCategoryFilter(categoryId || 'all');
    if (type === 'movie') setRoute('movies');
    else if (type === 'series') setRoute('series');
    else setRoute('live');
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const handleOpenDetail = (item: MediaItem) => {
    if (item.type === 'live') {
      handlePlayItem(item);
      return;
    }
    setPreviousRoute(route === 'detail' ? previousRoute : route);
    setDetailTarget({type: item.type, id: item.id});
    setRoute('detail');
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const handlePlayItem = async (item: MediaItem, resumeAtSeconds?: number) => {
    if (item.type === 'live') {
      setPlayerTarget({
        mediaType: 'live',
        id: item.id,
        title: item.title,
        subtitle: item.categoryName || 'TV ao vivo',
        poster: item.poster,
        banner: item.banner,
        streamUrl: item.streamUrl,
        streamFormat: item.streamFormat,
        isDemo: item.isDemo,
        channelsQueue: homeCatalog?.liveChannels,
      });
      return;
    }

    if (item.type === 'series') {
      try {
        const res = isDemoMode
          ? getDemoItemDetail('series', item.id)
          : await fetchItemDetail('series', item.id);
        const series = res?.item as SeriesDetail | undefined;
        if (series && series.seasons.length > 0) {
          const allEps = series.seasons.flatMap((s) => s.episodes);
          const saved = getSavedPosition(`series:${series.id}`);
          const targetEp =
            (saved?.episodeId && allEps.find((e) => e.id === saved.episodeId)) ||
            allEps[0];
          if (targetEp) {
            handlePlayEpisode(
              series,
              targetEp,
              allEps,
              saved?.episodeId === targetEp.id ? saved.positionSeconds : undefined,
            );
            return;
          }
        }
      } catch {
        // Fall through to detail page if series load fails
      }
      handleOpenDetail(item);
      return;
    }

    // Movie playback
    const saved = getSavedPosition(`movie:${item.id}`);
    setPlayerTarget({
      mediaType: 'movie',
      id: item.id,
      title: item.title,
      subtitle: [item.year, item.genres[0]].filter(Boolean).join(' · '),
      poster: item.poster,
      banner: item.banner,
      streamUrl: item.streamUrl,
      streamFormat: item.streamFormat,
      isDemo: item.isDemo,
      resumeAtSeconds: resumeAtSeconds ?? saved?.positionSeconds,
    });
  };

  const handlePlayEpisode = (
    series: SeriesDetail,
    episode: EpisodeItem,
    allEpisodes: EpisodeItem[],
    resumeAtSeconds?: number,
  ) => {
    setPlayerTarget({
      mediaType: 'series',
      id: series.id,
      seriesId: series.id,
      episodeId: episode.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: series.title,
      subtitle: `T${String(episode.seasonNumber).padStart(2, '0')} · E${String(episode.episodeNumber).padStart(2, '0')} — ${episode.title}`,
      poster: series.poster,
      banner: episode.thumbnail || series.banner || series.poster,
      streamUrl: episode.streamUrl,
      streamFormat: episode.streamFormat,
      isDemo: episode.isDemo ?? series.isDemo,
      episodesQueue: allEpisodes,
      resumeAtSeconds,
    });
  };

  const handlePlayChannel = (channel: MediaItem, queue?: MediaItem[]) => {
    setPlayerTarget({
      mediaType: 'live',
      id: channel.id,
      title: channel.title,
      subtitle: channel.categoryName || 'Transmissão ao vivo',
      poster: channel.poster,
      banner: channel.banner,
      streamUrl: channel.streamUrl,
      streamFormat: channel.streamFormat,
      isDemo: channel.isDemo,
      channelsQueue: queue,
    });
  };

  const handleResumeHistory = async (entry: ContinueWatchingEntry) => {
    if (entry.mediaType === 'series' && entry.seriesId) {
      const res = isDemoMode
        ? getDemoItemDetail('series', entry.seriesId)
        : await fetchItemDetail('series', entry.seriesId).catch(() => null);
      const series = res?.item as SeriesDetail | undefined;
      if (series && 'seasons' in series) {
        const allEps = series.seasons.flatMap((s) => s.episodes);
        const ep =
          allEps.find((e) => e.id === entry.episodeId) || allEps[0];
        if (ep) {
          handlePlayEpisode(series, ep, allEps, entry.positionSeconds);
          return;
        }
      }
    }

    if (entry.mediaType === 'movie') {
      const res = isDemoMode
        ? getDemoItemDetail('movie', entry.mediaId)
        : await fetchItemDetail('movie', entry.mediaId).catch(() => null);
      if (res?.item) {
        handlePlayItem(res.item, entry.positionSeconds);
        return;
      }
    }

    setPlayerTarget({
      mediaType: entry.mediaType,
      id: entry.mediaId,
      title: entry.title,
      poster: entry.poster,
      banner: entry.banner,
      isDemo: entry.isDemo,
      resumeAtSeconds: entry.positionSeconds,
    });
  };

  const handlePlayerProgress = useCallback(
    (positionSeconds: number, durationSeconds: number, current: PlayerTarget) => {
      if (current.mediaType === 'live') return;
      const key =
        current.mediaType === 'series'
          ? `series:${current.seriesId || current.id}`
          : `movie:${current.id}`;
      upsertContinueWatching({
        key,
        mediaType: current.mediaType,
        mediaId: current.id,
        seriesId: current.seriesId,
        episodeId: current.episodeId,
        seasonNumber: current.seasonNumber,
        episodeNumber: current.episodeNumber,
        episodeTitle: current.subtitle,
        title: current.title,
        poster: current.poster,
        banner: current.banner,
        positionSeconds,
        durationSeconds,
        updatedAt: Date.now(),
        isDemo: current.isDemo,
      });
    },
    [upsertContinueWatching],
  );

  const resetToLogin = useCallback(
    async (notice: string | null = null, clearSavedNav = true) => {
      const currentScope = getAccountScope(sessionRef.current);
      if (clearSavedNav && currentScope !== 'demo') {
        clearSavedNavState(currentScope);
      }
      await logoutIptv();
      loadedScopeRef.current = null;
      setSession(null);
      setHomeCatalog(null);
      setSectionLoading({movie: false, series: false, live: false});
      setSectionErrors({movie: null, series: null, live: null});
      setPlayerTarget(null);
      setShowAccountModal(false);
      setDetailTarget(null);
      setCatalogCategoryFilter('all');
      setRoute('home');
      setAuthNotice(notice);
    },
    [],
  );

  const handleDisconnect = useCallback(
    () => resetToLogin(null, true),
    [resetToLogin],
  );

  const handleSessionExpired = useCallback(
    async (message?: string) => {
      if (expiringRef.current) return;
      expiringRef.current = true;
      try {
        await resetToLogin(
          message ||
            'A validade desta lista IPTV expirou. Conecte uma nova lista.',
          true,
        );
      } finally {
        expiringRef.current = false;
      }
    },
    [resetToLogin],
  );

  useEffect(() => {
    setSessionExpiredListener((message) => {
      void handleSessionExpired(message);
    });
    return () => {
      setSessionExpiredListener(null);
    };
  }, [handleSessionExpired]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await checkSavedSession();
        if (!active) return;
        if (res.authenticated && res.session) {
          const restoredScope = getAccountScope(res.session);
          const savedNav = loadSavedNavState(restoredScope);
          if (savedNav) {
            setRoute(savedNav.route);
            setCatalogCategoryFilter(savedNav.catalogCategoryFilter);
            setDetailTarget(savedNav.detailTarget);
          }
          setAuthNotice(null);
          setSession(res.session);
        } else if (res.expired) {
          setAuthNotice(
            res.message ||
              'A validade da sua lista IPTV salva expirou. Conecte uma nova lista.',
          );
        }
      } finally {
        if (active) {
          setCheckingSession(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!session?.authenticated || session.mode === 'demo') return;
    const payload: SavedNavState = {
      route: SAFE_NAV_ROUTES.includes(route) ? route : 'home',
      catalogCategoryFilter,
      detailTarget: route === 'detail' ? detailTarget : null,
    };
    try {
      localStorage.setItem(
        `${NAV_STORAGE_PREFIX}${accountScope}`,
        JSON.stringify(payload),
      );
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [session, accountScope, route, catalogCategoryFilter, detailTarget]);

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-[#060807] text-[#F3F6F4] flex flex-col items-center justify-center px-6">
        <BrandLogo size="lg" />
        <div className="mt-6 flex items-center gap-2.5 text-sm text-[#98A69E]">
          <span className="w-4 h-4 rounded-full border-2 border-[#00E676]/30 border-t-[#00E676] animate-spin" />
          <span>Restaurando sua conexão IPTV...</span>
        </div>
        <OfflineIndicator />
      </div>
    );
  }

  // Show IPTV Login screen until authenticated or user chooses Demo preview
  if (!session) {
    return (
      <>
        <LoginPage
          noticeError={authNotice}
          onAuthenticated={(authSession) => {
            loadedScopeRef.current = null;
            expiringRef.current = false;
            setAuthNotice(null);
            setDetailTarget(null);
            setCatalogCategoryFilter('all');
            setSession(authSession);
            setRoute('home');
          }}
          onEnterDemo={() => {
            loadedScopeRef.current = null;
            expiringRef.current = false;
            setAuthNotice(null);
            setDetailTarget(null);
            setCatalogCategoryFilter('all');
            setSession(DEMO_SESSION);
            setRoute('home');
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#060807] text-[#F3F6F4] flex flex-col">
      <Header
        activeRoute={route}
        onNavigate={handleNavigate}
        session={session}
        onOpenAccount={() => setShowAccountModal(true)}
        onSessionExpired={() => void handleSessionExpired()}
      />

      <main className="flex-1 pb-20 md:pb-0">
        {route === 'home' && (
          <HomePage
            catalog={homeCatalog}
            sectionLoading={sectionLoading}
            sectionErrors={sectionErrors}
            onRetrySection={(type) => loadSingleSection(type, accountScope)}
            onRetryAll={() => loadHome(session, true)}
            favorites={favorites}
            history={history}
            onPlayItem={(item) => handlePlayItem(item)}
            onResumeHistory={handleResumeHistory}
            onOpenDetail={handleOpenDetail}
            onNavigateCatalog={handleNavigateCatalog}
            onNavigateMyList={() => handleNavigate('mylist')}
          />
        )}

        {route === 'movies' && (
          <CatalogPage
            mediaType="movie"
            isDemoMode={isDemoMode}
            initialCategoryId={catalogCategoryFilter}
            onSelectItem={handleOpenDetail}
          />
        )}

        {route === 'series' && (
          <CatalogPage
            mediaType="series"
            isDemoMode={isDemoMode}
            initialCategoryId={catalogCategoryFilter}
            onSelectItem={handleOpenDetail}
          />
        )}

        {route === 'live' && (
          <LiveTVPage
            isDemoMode={isDemoMode}
            initialCategoryId={catalogCategoryFilter}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onPlayChannel={(ch, queue) => handlePlayChannel(ch, queue)}
            onConnectIptv={handleDisconnect}
          />
        )}

        {route === 'mylist' && (
          <MyListPage
            favorites={favorites}
            onSelectItem={handleOpenDetail}
            onRemoveFavorite={removeFavorite}
          />
        )}

        {route === 'search' && (
          <SearchPage
            isDemoMode={isDemoMode}
            onSelectMedia={handleOpenDetail}
            onPlayChannel={(ch) => handlePlayChannel(ch)}
            onSelectEpisodeSeries={(seriesId) => {
              setPreviousRoute('search');
              setDetailTarget({type: 'series', id: seriesId});
              setRoute('detail');
            }}
          />
        )}

        {route === 'detail' && detailTarget && (
          <DetailPage
            mediaType={detailTarget.type}
            mediaId={detailTarget.id}
            isDemoMode={isDemoMode}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            getSavedPosition={getSavedPosition}
            onPlayMovie={(movie, pos) => handlePlayItem(movie, pos)}
            onPlayEpisode={handlePlayEpisode}
            onSelectRelated={handleOpenDetail}
            onBack={() =>
              setRoute(previousRoute === 'detail' ? 'home' : previousRoute)
            }
          />
        )}
      </main>

      <footer className="hidden md:block border-t border-white/[0.06] py-6 px-10 text-xs text-[#6E7D75]">
        <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-4">
          <span>GreenPlay TV — Plataforma de Streaming IPTV</span>
          <div className="flex items-center gap-4">
            {session.mode !== 'demo' && (
              <ValidityCountdown
                expiresAtTimestamp={session.expiresAtTimestamp}
                isTrial={session.isTrial}
                variant="compact"
              />
            )}
            <span>
              {session.mode === 'demo'
                ? 'Modo Demonstração · Sem fontes de vídeo externas conectadas'
                : `Conectado a ${session.serverHost || session.accountLabel}`}
            </span>
          </div>
        </div>
      </footer>

      {showAccountModal && (
        <AccountModal
          session={session}
          onClose={() => setShowAccountModal(false)}
          onDisconnect={handleDisconnect}
          onConnectList={handleDisconnect}
        />
      )}

      {playerTarget && (
        <VideoPlayerModal
          target={playerTarget}
          resolvePlaybackSource={
            isDemoMode ? undefined : (type, id) => fetchPlaybackSource(type, id)
          }
          onClose={() => setPlayerTarget(null)}
          onProgress={handlePlayerProgress}
          onConnectIptv={handleDisconnect}
          onSelectEpisode={(ep) => {
            if (!playerTarget.episodesQueue) return;
            const saved = getSavedPosition(`series:${playerTarget.seriesId || playerTarget.id}`);
            setPlayerTarget({
              ...playerTarget,
              episodeId: ep.id,
              seasonNumber: ep.seasonNumber,
              episodeNumber: ep.episodeNumber,
              subtitle: `T${String(ep.seasonNumber).padStart(2, '0')} · E${String(ep.episodeNumber).padStart(2, '0')} — ${ep.title}`,
              banner: ep.thumbnail || playerTarget.banner,
              streamUrl: ep.streamUrl,
              streamFormat: ep.streamFormat,
              isDemo: ep.isDemo,
              resumeAtSeconds:
                saved?.episodeId === ep.id ? saved.positionSeconds : undefined,
            });
          }}
          onSelectChannel={(ch) => {
            setPlayerTarget({
              ...playerTarget,
              id: ch.id,
              title: ch.title,
              subtitle: ch.categoryName || 'Transmissão ao vivo',
              poster: ch.poster,
              banner: ch.banner,
              streamUrl: ch.streamUrl,
              streamFormat: ch.streamFormat,
              isDemo: ch.isDemo,
            });
          }}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}
