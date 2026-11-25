import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Hls from 'hls.js';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  FastForward,
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  Play,
  Plug,
  Radio,
  RotateCcw,
  Scan,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  EpisodeItem,
  MediaItem,
  MediaType,
  PlaybackSourceResponse,
  PlayerTarget,
} from '../types/catalog';

type VideoFitMode = 'contain' | 'cover' | 'fill';
type StreamFormat = 'hls' | 'mp4' | 'mkv' | 'ts' | 'unsupported';
type PlayerErrorCategory =
  | 'network'
  | 'timeout'
  | 'format'
  | 'invalid_url'
  | 'mixed_content'
  | 'provider_http';

interface PlayerErrorState {
  category: PlayerErrorCategory;
  message: string;
}

const FIT_MODE_STORAGE_KEY = 'greenplay_player_fit_mode';
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAYS_MS = [1200, 2200, 3500];
const STARTUP_TIMEOUT_MS = 18000;

const FIT_MODE_OPTIONS: {value: VideoFitMode; label: string; shortLabel: string}[] = [
  {value: 'contain', label: 'Ajustar (Original)', shortLabel: 'Ajustar'},
  {value: 'cover', label: 'Preencher tela', shortLabel: 'Preencher'},
  {value: 'fill', label: 'Esticar bordas', shortLabel: 'Esticar'},
];

const INTRO_SKIP_SECONDS = 85;
const INTRO_WINDOW_MAX_SECONDS = 300;

interface VideoPlayerModalProps {
  target: PlayerTarget;
  resolvePlaybackSource?: (type: MediaType, id: string) => Promise<PlaybackSourceResponse>;
  onClose: () => void;
  onProgress: (positionSeconds: number, durationSeconds: number, currentTarget: PlayerTarget) => void;
  onSelectEpisode?: (episode: EpisodeItem) => void;
  onSelectChannel?: (channel: MediaItem) => void;
  onConnectIptv?: () => void;
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const secs = Math.floor(totalSeconds);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function redactStreamUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
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

function detectEffectiveFormat(
  src: string,
  hintedFormat: PlayerTarget['streamFormat'],
  mediaType: MediaType,
): StreamFormat {
  const cleanPath = src.split('?')[0].split('#')[0].trim().toLowerCase();
  if (cleanPath.endsWith('.m3u8') || cleanPath.includes('.m3u8') || hintedFormat === 'hls') {
    return 'hls';
  }
  if (/\.(mp4|m4v|mov|webm)$/.test(cleanPath)) return 'mp4';
  if (cleanPath.endsWith('.mkv') || hintedFormat === 'mkv') return 'mkv';
  if (cleanPath.endsWith('.ts') || hintedFormat === 'ts') return 'ts';
  if (
    /\.(avi|flv|wmv|mpg|mpeg|vob|divx)$/.test(cleanPath) ||
    hintedFormat === 'unsupported'
  ) {
    return 'unsupported';
  }
  if (mediaType === 'live' && !hintedFormat) return 'hls';
  return hintedFormat || 'mp4';
}

function checkBrowserCanPlayFormat(
  video: HTMLVideoElement,
  format: StreamFormat,
): {supported: boolean; reason?: string} {
  if (format === 'unsupported') {
    return {
      supported: false,
      reason:
        'Formato de vídeo incompatível com navegadores (AVI/FLV/WMV/MPEG). Utilize conteúdos em MP4 ou HLS (.m3u8).',
    };
  }
  if (format === 'ts') {
    const canTs = video.canPlayType('video/mp2t');
    if (!canTs) {
      return {
        supported: false,
        reason:
          'Transmissão em fluxo MPEG-TS (.ts) não é suportada diretamente pelo navegador. Selecione um canal ou vídeo em HLS (.m3u8) ou MP4.',
      };
    }
    return {supported: true};
  }
  if (format === 'mkv') {
    const canMkv =
      video.canPlayType('video/x-matroska; codecs="avc1.42E01E, mp4a.40.2"') ||
      video.canPlayType('video/x-matroska') ||
      video.canPlayType('video/webm; codecs="vp8, opus"');
    if (!canMkv) {
      return {
        supported: false,
        reason:
          'Este navegador não oferece suporte nativo ao formato MKV. Experimente um título em MP4 ou HLS (.m3u8).',
      };
    }
    return {supported: true};
  }
  if (format === 'hls') {
    if (Hls.isSupported() || video.canPlayType('application/vnd.apple.mpegurl')) {
      return {supported: true};
    }
    return {
      supported: false,
      reason: 'Reprodução HLS (.m3u8) não suportada neste navegador.',
    };
  }
  const canMp4 = video.canPlayType('video/mp4');
  if (!canMp4) {
    return {
      supported: false,
      reason: 'Reprodução MP4 não suportada neste navegador.',
    };
  }
  return {supported: true};
}

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  target,
  resolvePlaybackSource,
  onClose,
  onProgress,
  onSelectEpisode,
  onSelectChannel,
  onConnectIptv,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const lastSavedAtRef = useRef<number>(0);

  // Concurrency & retry guards
  const playbackSessionIdRef = useRef<number>(0);
  const retryTimerRef = useRef<number | null>(null);
  const startupTimerRef = useRef<number | null>(null);
  const autoRetryCountRef = useRef<number>(0);
  const initialResumeRef = useRef<number | undefined>(target.resumeAtSeconds);
  const resolvePlaybackRef = useRef(resolvePlaybackSource);
  resolvePlaybackRef.current = resolvePlaybackSource;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(!target.isDemo);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<PlayerErrorState | null>(null);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [hasActiveSource, setHasActiveSource] = useState(Boolean(target.streamUrl));

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [drawerMode, setDrawerMode] = useState<'none' | 'episodes' | 'channels'>('none');
  const [fitMode, setFitMode] = useState<VideoFitMode>(() => {
    try {
      const saved = window.localStorage.getItem(FIT_MODE_STORAGE_KEY);
      if (saved === 'contain' || saved === 'cover' || saved === 'fill') {
        return saved;
      }
    } catch {
      // Ignore storage failures
    }
    return 'contain';
  });
  const [showFitMenu, setShowFitMenu] = useState(false);
  const [introSkipped, setIntroSkipped] = useState(false);
  const [attemptSeed, setAttemptSeed] = useState(0);

  const controlsTimerRef = useRef<number | null>(null);
  const targetIdentityKey = `${target.mediaType}:${target.id}:${target.episodeId || ''}:${target.streamUrl || ''}`;

  // Update initial resume target only when switching to a different movie/episode/channel
  useEffect(() => {
    initialResumeRef.current = target.resumeAtSeconds;
    autoRetryCountRef.current = 0;
  }, [targetIdentityKey, target.resumeAtSeconds]);

  const nextEpisode = useMemo(() => {
    if (!target.episodesQueue || !target.episodeId) return null;
    const idx = target.episodesQueue.findIndex((e) => e.id === target.episodeId);
    if (idx >= 0 && idx + 1 < target.episodesQueue.length) {
      return target.episodesQueue[idx + 1];
    }
    return null;
  }, [target.episodesQueue, target.episodeId]);

  const scheduleHideControls = useCallback(() => {
    if (controlsTimerRef.current) {
      window.clearTimeout(controlsTimerRef.current);
    }
    setShowControls(true);
    controlsTimerRef.current = window.setTimeout(() => {
      if (drawerMode === 'none' && !showFitMenu) {
        setShowControls(false);
      }
    }, 3500);
  }, [drawerMode, showFitMenu]);

  const flushProgress = useCallback(
    (force = false) => {
      const video = videoRef.current;
      if (!video || target.mediaType === 'live') return;
      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 8000) return;
      const pos = Math.floor(video.currentTime || 0);
      const dur = Math.floor(video.duration || 0);
      if (pos > 0) {
        lastSavedAtRef.current = now;
        onProgress(pos, dur, target);
      }
    },
    [onProgress, target],
  );

  // Full media & timer teardown helper to ensure no stale sockets or overlapping sessions
  const teardownPlayback = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (startupTimerRef.current) {
      window.clearTimeout(startupTimerRef.current);
      startupTimerRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  // Initialize playback when item or attemptSeed changes
  useEffect(() => {
    const sessionId = ++playbackSessionIdRef.current;
    teardownPlayback();

    setErrorState(null);
    setStatusNotice(null);
    setSourceUnavailable(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIntroSkipped(false);
    setShowFitMenu(false);

    if (target.isDemo && !target.streamUrl) {
      setHasActiveSource(false);
      setSourceUnavailable(true);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setHasActiveSource(true);

    let localCleanup: (() => void) | null = null;

    const handleFailure = (
      category: PlayerErrorCategory,
      message: string,
      recoverable: boolean,
      formatLabel: string,
      redactedUrl: string,
    ) => {
      if (playbackSessionIdRef.current !== sessionId) return;

      const currentRetries = autoRetryCountRef.current;
      console.warn('[GreenPlay Player] Playback error', {
        errorType: category,
        format: formatLabel,
        attempt: currentRetries + 1,
        recoverable,
        url: redactedUrl,
      });

      if (recoverable && currentRetries < MAX_AUTO_RETRIES) {
        const nextRetryNum = currentRetries + 1;
        autoRetryCountRef.current = nextRetryNum;
        const delayMs = RETRY_DELAYS_MS[nextRetryNum - 1] || 3000;
        teardownPlayback();
        setIsLoading(true);
        setStatusNotice(
          `Instabilidade temporária detectada. Reconectando (${nextRetryNum}/${MAX_AUTO_RETRIES})...`,
        );

        retryTimerRef.current = window.setTimeout(() => {
          if (playbackSessionIdRef.current !== sessionId) return;
          setAttemptSeed((s) => s + 1);
        }, delayMs);
        return;
      }

      teardownPlayback();
      setIsLoading(false);
      setStatusNotice(null);
      setErrorState({category, message});
    };

    const startPlayback = async () => {
      let src = target.streamUrl?.trim() || '';
      let hintedFormat = target.streamFormat;

      if (!src && resolvePlaybackRef.current && !target.isDemo) {
        try {
          const resolvedId =
            target.mediaType === 'series' && target.episodeId ? target.episodeId : target.id;
          const resolved = await resolvePlaybackRef.current(target.mediaType, resolvedId);
          if (playbackSessionIdRef.current !== sessionId) return;
          src = resolved.streamUrl?.trim() || '';
          hintedFormat = resolved.streamFormat || hintedFormat;
        } catch (err) {
          if (playbackSessionIdRef.current !== sessionId) return;
          const msg =
            err instanceof Error
              ? err.message
              : 'Falha ao obter endereço de reprodução do provedor.';
          handleFailure('network', msg, true, hintedFormat || 'unknown', '[unresolved]');
          return;
        }
      }

      if (playbackSessionIdRef.current !== sessionId) return;

      if (!src) {
        setHasActiveSource(false);
        setSourceUnavailable(true);
        setIsLoading(false);
        return;
      }

      // Validate playback URL syntax before attempting playback
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(src, window.location.origin);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error('Protocolo não suportado.');
        }
        if (parsedUrl.pathname === '/' && !parsedUrl.search) {
          throw new Error('Endereço sem caminho de mídia.');
        }
      } catch {
        handleFailure(
          'invalid_url',
          'O provedor retornou uma URL de reprodução inválida ou incompleta.',
          false,
          hintedFormat || 'unknown',
          '[invalid-url]',
        );
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      const format = detectEffectiveFormat(src, hintedFormat, target.mediaType);
      const redactedUrl = redactStreamUrlForLog(src);
      const attemptNumber = autoRetryCountRef.current + 1;

      console.info('[GreenPlay Player] Initializing', {
        mediaType: target.mediaType,
        id: target.episodeId || target.id,
        format,
        attempt: attemptNumber,
        url: redactedUrl,
      });

      // Verify browser compatibility before attempting playback (blocks MKV/AVI/TS when unsupported)
      const compat = checkBrowserCanPlayFormat(video, format);
      if (!compat.supported) {
        handleFailure(
          'format',
          compat.reason || 'Formato de vídeo não suportado pelo navegador.',
          false,
          format,
          redactedUrl,
        );
        return;
      }

      const isMixedContent =
        window.location.protocol === 'https:' && parsedUrl.protocol === 'http:';

      const applyResume = () => {
        const resumePos = initialResumeRef.current;
        if (
          target.mediaType !== 'live' &&
          resumePos &&
          resumePos > 5 &&
          Number.isFinite(video.duration) &&
          video.duration > resumePos + 5
        ) {
          video.currentTime = resumePos;
        }
      };

      const clearStartupTimer = () => {
        if (startupTimerRef.current) {
          window.clearTimeout(startupTimerRef.current);
          startupTimerRef.current = null;
        }
      };

      // Guard against indefinite hung requests during initialization
      startupTimerRef.current = window.setTimeout(() => {
        if (playbackSessionIdRef.current !== sessionId) return;
        handleFailure(
          'timeout',
          'Tempo esgotado ao carregar o vídeo do provedor IPTV. O servidor demorou para responder.',
          true,
          format,
          redactedUrl,
        );
      }, STARTUP_TIMEOUT_MS);

      const useHlsJs = format === 'hls' && Hls.isSupported();

      if (useHlsJs && isMixedContent) {
        // Check native HLS fallback (Safari) before failing on Mixed Content XHR block
        if (!video.canPlayType('application/vnd.apple.mpegurl')) {
          clearStartupTimer();
          handleFailure(
            'mixed_content',
            'Este fluxo HLS usa HTTP sem HTTPS, o que é bloqueado pelo navegador em páginas HTTPS. Verifique se seu provedor oferece DNS com HTTPS.',
            false,
            format,
            redactedUrl,
          );
          return;
        }
      }

      if (useHlsJs && !isMixedContent) {
        let mediaRecoveredOnce = false;
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: target.mediaType === 'live',
          backBufferLength: 60,
          manifestLoadingTimeOut: 14000,
          levelLoadingTimeOut: 14000,
          fragLoadingTimeOut: 18000,
          manifestLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 1,
        });
        hlsRef.current = hls;

        const onVideoError = () => {
          if (playbackSessionIdRef.current !== sessionId) return;
          clearStartupTimer();
          const mediaErr = video.error;
          if (mediaErr?.code === MediaError.MEDIA_ERR_DECODE || mediaErr?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
            handleFailure(
              'format',
              'O navegador não conseguiu decodificar este stream HLS (codec de vídeo/áudio incompatível).',
              false,
              format,
              redactedUrl,
            );
          } else {
            handleFailure(
              'network',
              'Falha de rede durante a reprodução do fluxo HLS.',
              true,
              format,
              redactedUrl,
            );
          }
        };

        video.addEventListener('error', onVideoError);
        localCleanup = () => {
          video.removeEventListener('error', onVideoError);
        };

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (playbackSessionIdRef.current !== sessionId) return;
          clearStartupTimer();
          setIsLoading(false);
          setStatusNotice(null);
          applyResume();
          video.play().catch((playErr) => {
            if (playbackSessionIdRef.current !== sessionId) return;
            if (playErr instanceof Error && playErr.name === 'NotAllowedError') {
              setIsPlaying(false);
            }
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (playbackSessionIdRef.current !== sessionId || !data.fatal) return;
          clearStartupTimer();
          const httpCode = data.response?.code;

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (httpCode === 401 || httpCode === 403 || httpCode === 404 || httpCode === 410) {
              handleFailure(
                'provider_http',
                `O servidor IPTV recusou ou não encontrou o fluxo de vídeo (HTTP ${httpCode}).`,
                false,
                format,
                redactedUrl,
              );
              return;
            }
            if (httpCode === 0) {
              handleFailure(
                'network',
                'Não foi possível acessar o fluxo HLS no navegador (bloqueio de CORS ou falha de conexão com o provedor).',
                true,
                format,
                redactedUrl,
              );
              return;
            }
            handleFailure(
              'network',
              `Erro de rede ao carregar o stream HLS${httpCode ? ` (HTTP ${httpCode})` : ''}.`,
              true,
              format,
              redactedUrl,
            );
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (!mediaRecoveredOnce) {
              mediaRecoveredOnce = true;
              hls.recoverMediaError();
              return;
            }
            handleFailure(
              'format',
              'Erro de decodificação de mídia no stream HLS. O codec pode ser incompatível com o navegador.',
              false,
              format,
              redactedUrl,
            );
            return;
          }

          handleFailure(
            'format',
            'Não foi possível inicializar o stream HLS no navegador.',
            false,
            format,
            redactedUrl,
          );
        });

        hls.loadSource(src);
        hls.attachMedia(video);
        return;
      }

      // Native HTML5 playback (MP4, Safari native HLS, or browser-supported MKV)
      const onLoadedMetadata = () => {
        if (playbackSessionIdRef.current !== sessionId) return;
        clearStartupTimer();
        setDuration(Number.isFinite(video.duration) ? video.duration : 0);
        setIsLoading(false);
        setStatusNotice(null);
        applyResume();
        video.play().catch((playErr) => {
          if (playbackSessionIdRef.current !== sessionId) return;
          if (playErr instanceof Error && playErr.name === 'NotAllowedError') {
            setIsPlaying(false);
          }
        });
      };

      const onCanPlay = () => {
        if (playbackSessionIdRef.current !== sessionId) return;
        clearStartupTimer();
        setIsLoading(false);
        setStatusNotice(null);
      };

      const onNativeError = () => {
        if (playbackSessionIdRef.current !== sessionId) return;
        clearStartupTimer();
        const code = video.error?.code;

        if (code === MediaError.MEDIA_ERR_NETWORK) {
          handleFailure(
            isMixedContent ? 'mixed_content' : 'network',
            isMixedContent
              ? 'Falha ao carregar vídeo HTTP em página HTTPS (Mixed Content) ou queda na rede.'
              : 'Falha de rede ao carregar o vídeo do provedor IPTV.',
            !isMixedContent,
            format,
            redactedUrl,
          );
          return;
        }

        if (code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          if (isMixedContent) {
            handleFailure(
              'mixed_content',
              'O link do vídeo utiliza HTTP em uma página HTTPS ou o formato não é compatível com o navegador.',
              false,
              format,
              redactedUrl,
            );
            return;
          }
          const formatHint =
            format === 'mkv'
              ? 'Arquivo MKV com codec de vídeo/áudio (como HEVC ou AC3) incompatível com o navegador.'
              : 'Formato ou codec de vídeo incompatível com este navegador, ou resposta inválida do servidor IPTV.';
          handleFailure('format', formatHint, false, format, redactedUrl);
          return;
        }

        handleFailure(
          'network',
          'Erro inesperado ao iniciar a reprodução do vídeo.',
          true,
          format,
          redactedUrl,
        );
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('canplay', onCanPlay);
      video.addEventListener('error', onNativeError);
      localCleanup = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('error', onNativeError);
      };

      video.src = src;
      video.load();
    };

    void startPlayback();

    return () => {
      playbackSessionIdRef.current += 1;
      localCleanup?.();
      teardownPlayback();
    };
  }, [targetIdentityKey, target.isDemo, target.mediaType, target.id, target.episodeId, target.streamFormat, target.streamUrl, attemptSeed, teardownPlayback]);

  // Save final position on unmount or target switch
  useEffect(() => {
    return () => {
      flushProgress(true);
      if (controlsTimerRef.current) {
        window.clearTimeout(controlsTimerRef.current);
      }
    };
  }, [flushProgress]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Keyboard shortcuts (Escape, Space, F, M)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFitMenu) setShowFitMenu(false);
        else if (drawerMode !== 'none') setDrawerMode('none');
        else onClose();
      } else if (e.key === ' ' && hasActiveSource) {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === 'f' || e.key === 'F') && hasActiveSource) {
        toggleFullscreen();
      } else if ((e.key === 'm' || e.key === 'M') && hasActiveSource) {
        toggleMute();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
      flushProgress(true);
    }
    scheduleHideControls();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    scheduleHideControls();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    const video = videoRef.current;
    if (!video) return;
    video.volume = val;
    video.muted = val === 0;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = val;
    setCurrentTime(val);
    scheduleHideControls();
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    const video = videoRef.current as (HTMLVideoElement & {webkitEnterFullscreen?: () => void}) | null;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (container?.requestFullscreen) {
        await container.requestFullscreen();
      } else if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } catch {
      // Ignore fullscreen denial
    }
  };

  const handleSelectFitMode = (mode: VideoFitMode) => {
    setFitMode(mode);
    setShowFitMenu(false);
    try {
      window.localStorage.setItem(FIT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors
    }
    scheduleHideControls();
  };

  const handleSkipIntro = () => {
    const video = videoRef.current;
    if (!video || target.mediaType === 'live') return;
    const maxTarget =
      Number.isFinite(video.duration) && video.duration > 2
        ? video.duration - 2
        : Number.MAX_SAFE_INTEGER;
    const nextPos = Math.min(video.currentTime + INTRO_SKIP_SECONDS, maxTarget);
    video.currentTime = nextPos;
    setCurrentTime(nextPos);
    setIntroSkipped(true);
    flushProgress(true);
    scheduleHideControls();
  };

  const handleManualRetry = () => {
    teardownPlayback();
    autoRetryCountRef.current = 0;
    setErrorState(null);
    setStatusNotice(null);
    setIsLoading(true);
    setAttemptSeed((s) => s + 1);
  };

  const handleClose = () => {
    teardownPlayback();
    flushProgress(true);
    onClose();
  };

  const videoFitClass =
    fitMode === 'cover'
      ? 'object-cover'
      : fitMode === 'fill'
        ? 'object-fill'
        : 'object-contain';

  const canSkipIntro =
    target.mediaType !== 'live' &&
    hasActiveSource &&
    !sourceUnavailable &&
    !errorState &&
    !introSkipped &&
    currentTime < INTRO_WINDOW_MAX_SECONDS &&
    (duration === 0 || currentTime + 15 < duration);

  const currentFitLabel =
    FIT_MODE_OPTIONS.find((opt) => opt.value === fitMode)?.shortLabel || 'Ajustar';

  return (
    <div
      ref={containerRef}
      onMouseMove={scheduleHideControls}
      onTouchStart={scheduleHideControls}
      className="fixed inset-0 z-50 bg-black flex flex-col justify-between overflow-hidden select-none"
      role="dialog"
      aria-modal="true"
      aria-label={`Player: ${target.title}`}
    >
      {/* Top Overlay Header */}
      <div
        className={`relative z-30 flex items-center justify-between gap-4 px-4 sm:px-6 py-4 bg-gradient-to-b from-black/90 via-black/50 to-transparent transition-opacity duration-200 ${
          showControls || sourceUnavailable || errorState ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={handleClose}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-2 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors shrink-0 cursor-pointer"
          >
            <ArrowLeft className="h-5 w-5" />
            <span className="hidden sm:inline">Voltar</span>
          </button>
          <div className="min-w-0">
            <h2 className="font-display text-sm sm:text-lg font-semibold text-white truncate">
              {target.title}
            </h2>
            {target.subtitle && (
              <p className="text-xs text-[#B7C4BC] truncate">{target.subtitle}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {target.episodesQueue && target.episodesQueue.length > 0 && onSelectEpisode && (
            <button
              type="button"
              onClick={() => setDrawerMode(drawerMode === 'episodes' ? 'none' : 'episodes')}
              className="min-h-[44px] inline-flex items-center gap-2 px-3.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
            >
              <ListVideo className="h-4 w-4 text-emerald-400" />
              <span className="hidden sm:inline">Episódios</span>
            </button>
          )}

          {target.channelsQueue && target.channelsQueue.length > 0 && onSelectChannel && (
            <button
              type="button"
              onClick={() => setDrawerMode(drawerMode === 'channels' ? 'none' : 'channels')}
              className="min-h-[44px] inline-flex items-center gap-2 px-3.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
            >
              <Radio className="h-4 w-4 text-emerald-400" />
              <span className="hidden sm:inline">Canais</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Video Stage */}
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        {sourceUnavailable ? (
          /* Clean Unavailable Source State (Zero fake playback links) */
          <div className="relative z-20 max-w-md mx-auto px-6 text-center">
            <div className="mx-auto mb-5 h-14 w-14 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center">
              <Plug className="h-7 w-7 text-emerald-400" />
            </div>
            <h3 className="font-display text-xl sm:text-2xl font-semibold text-white">
              Reprodução ainda não disponível
            </h3>
            <p className="mt-2.5 text-sm text-[#9CA8A2] leading-relaxed">
              {target.isDemo
                ? 'Este título faz parte do catálogo de demonstração visual do GreenPlay TV. Conecte sua lista IPTV real (Xtream Codes ou M3U) para assistir a transmissões e vídeos.'
                : 'Nenhuma fonte de vídeo compatível foi encontrada para este conteúdo no momento.'}
            </p>
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
              {onConnectIptv && (
                <button
                  type="button"
                  onClick={() => {
                    handleClose();
                    onConnectIptv();
                  }}
                  className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-[#04120B] font-semibold text-sm transition-colors cursor-pointer"
                >
                  Conectar lista IPTV
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-xl border border-white/15 bg-white/[0.06] hover:bg-white/[0.12] text-white text-sm font-medium transition-colors cursor-pointer"
              >
                Voltar ao catálogo
              </button>
            </div>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              onClick={togglePlay}
              onPlay={() => setIsPlaying(true)}
              onPause={() => {
                setIsPlaying(false);
                flushProgress(true);
              }}
              onWaiting={() => setIsLoading(true)}
              onPlaying={() => {
                setIsLoading(false);
                setStatusNotice(null);
              }}
              onTimeUpdate={() => {
                if (!videoRef.current) return;
                setCurrentTime(videoRef.current.currentTime);
                flushProgress(false);
              }}
              onLoadedMetadata={() => {
                if (!videoRef.current) return;
                setDuration(
                  Number.isFinite(videoRef.current.duration) ? videoRef.current.duration : 0,
                );
              }}
              className={`w-full h-full max-w-full max-h-full ${videoFitClass}`}
            />

            {isLoading && !errorState && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none px-6 text-center">
                <div className="h-12 w-12 rounded-full border-2 border-emerald-500/30 border-t-emerald-400 animate-spin" />
                {statusNotice && (
                  <p className="text-xs sm:text-sm text-[#D1DBD5] bg-black/75 px-3.5 py-1.5 rounded-lg border border-white/10">
                    {statusNotice}
                  </p>
                )}
              </div>
            )}

            {errorState && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/85 p-6">
                <div className="max-w-md text-center">
                  <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" />
                  <h3 className="font-display text-lg font-semibold text-white">
                    Erro na reprodução
                  </h3>
                  <p className="mt-2 text-sm text-[#B7C4BC]">{errorState.message}</p>
                  <div className="mt-5 flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={handleManualRetry}
                      className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-[#04120B] font-semibold text-sm cursor-pointer"
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span>Tentar novamente</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleClose}
                      className="min-h-[44px] px-5 py-2.5 rounded-xl border border-white/15 bg-white/10 text-white text-sm cursor-pointer"
                    >
                      Fechar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom Controls Bar */}
      {hasActiveSource && !sourceUnavailable && !errorState && (
        <div
          className={`relative z-30 px-4 sm:px-6 pb-5 pt-10 bg-gradient-to-t from-black/95 via-black/65 to-transparent transition-opacity duration-200 ${
            showControls || showFitMenu ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Compact Skip Intro Button (Movies & Series Episodes only) */}
          {canSkipIntro && (
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={handleSkipIntro}
                className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg border border-emerald-500/45 bg-[#0D1210]/90 hover:bg-emerald-500 text-emerald-300 hover:text-[#04120B] text-xs font-semibold tracking-wide backdrop-blur-md transition-colors shadow-lg cursor-pointer"
              >
                <FastForward className="h-3.5 w-3.5 shrink-0" />
                <span>Pular abertura</span>
              </button>
            </div>
          )}

          {/* Seek Bar for VOD */}
          {target.mediaType !== 'live' && duration > 0 && (
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs tabular-nums text-[#D1DBD5] w-14 text-right shrink-0">
                {formatTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration}
                value={Math.min(currentTime, duration)}
                onChange={handleSeek}
                aria-label="Posição da reprodução"
                className="w-full h-1.5 accent-emerald-400 cursor-pointer bg-white/20 rounded-lg"
              />
              <span className="font-mono text-xs tabular-nums text-[#9CA8A2] w-14 shrink-0">
                {formatTime(duration)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={togglePlay}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-[#04120B] transition-colors cursor-pointer"
                aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5 fill-current" />
                ) : (
                  <Play className="h-5 w-5 fill-current ml-0.5" />
                )}
              </button>

              <button
                type="button"
                onClick={toggleMute}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-5 w-5" />
                ) : (
                  <Volume2 className="h-5 w-5" />
                )}
              </button>

              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                aria-label="Volume"
                className="hidden sm:block w-24 h-1.5 accent-emerald-400 cursor-pointer"
              />

              {target.mediaType === 'live' && (
                <span className="ml-2 inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-emerald-400 uppercase">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  AO VIVO
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {nextEpisode && onSelectEpisode && (
                <button
                  type="button"
                  onClick={() => onSelectEpisode(nextEpisode)}
                  className="min-h-[44px] inline-flex items-center gap-2 px-3.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
                >
                  <SkipForward className="h-4 w-4 text-emerald-400" />
                  <span className="hidden sm:inline">Próximo episódio</span>
                </button>
              )}

              {/* Border Fill Mode Selector (All Players) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowFitMenu((prev) => !prev);
                    scheduleHideControls();
                  }}
                  className={`min-h-[44px] inline-flex items-center gap-2 px-3 rounded-xl border text-xs sm:text-sm font-medium transition-colors cursor-pointer ${
                    showFitMenu || fitMode !== 'contain'
                      ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                      : 'border-transparent bg-white/10 hover:bg-white/20 text-white'
                  }`}
                  aria-label="Escolher preenchimento das bordas"
                  aria-expanded={showFitMenu}
                  title="Preenchimento das bordas"
                >
                  <Scan className="h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">{currentFitLabel}</span>
                </button>

                {showFitMenu && (
                  <div
                    className="absolute right-0 bottom-full mb-2 w-48 rounded-xl border border-white/10 bg-[#0D1210]/95 backdrop-blur-lg p-1.5 shadow-2xl"
                    role="menu"
                    aria-label="Modo de preenchimento das bordas"
                  >
                    <div className="px-2.5 py-1.5 text-[11px] font-medium text-[#8C9B93]">
                      Preenchimento das bordas
                    </div>
                    {FIT_MODE_OPTIONS.map((option) => {
                      const active = fitMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => handleSelectFitMode(option.value)}
                          className={`w-full min-h-[40px] px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 text-xs font-medium transition-colors cursor-pointer ${
                            active
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'text-[#D1DBD5] hover:bg-white/[0.06]'
                          }`}
                        >
                          <span>{option.label}</span>
                          {active && <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              >
                {isFullscreen ? (
                  <Minimize className="h-5 w-5" />
                ) : (
                  <Maximize className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode or Channel Switcher Side Drawer */}
      {drawerMode !== 'none' && (
        <aside className="absolute top-0 right-0 bottom-0 z-40 w-full max-w-sm bg-[#0B100E]/95 backdrop-blur-lg border-l border-white/10 flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
            <h3 className="font-display text-base font-semibold text-white">
              {drawerMode === 'episodes' ? 'Selecionar episódio' : 'Trocar de canal'}
            </h3>
            <button
              type="button"
              onClick={() => setDrawerMode('none')}
              className="min-h-[44px] min-w-[44px] -mr-2 flex items-center justify-center rounded-lg text-[#9CA8A2] hover:text-white cursor-pointer"
              aria-label="Fechar painel"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">
            {drawerMode === 'episodes' &&
              target.episodesQueue?.map((ep) => {
                const active = ep.id === target.episodeId;
                return (
                  <button
                    key={ep.id}
                    type="button"
                    onClick={() => {
                      onSelectEpisode?.(ep);
                      setDrawerMode('none');
                    }}
                    className={`w-full text-left px-5 py-3.5 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                      active ? 'bg-emerald-500/15 text-emerald-300' : 'hover:bg-white/[0.04] text-[#D1DBD5]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-emerald-400 tabular-nums">
                        T{String(ep.seasonNumber).padStart(2, '0')} · E{String(ep.episodeNumber).padStart(2, '0')}
                      </div>
                      <div className="text-sm font-medium truncate mt-0.5">{ep.title}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
                  </button>
                );
              })}

            {drawerMode === 'channels' &&
              target.channelsQueue?.map((ch) => {
                const active = ch.id === target.id;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => {
                      onSelectChannel?.(ch);
                      setDrawerMode('none');
                    }}
                    className={`w-full text-left px-5 py-3.5 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                      active ? 'bg-emerald-500/15 text-emerald-300' : 'hover:bg-white/[0.04] text-[#D1DBD5]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {ch.channelNumber && (
                        <span className="font-mono text-xs tabular-nums text-[#8C9B93] w-8 shrink-0">
                          {ch.channelNumber}
                        </span>
                      )}
                      <span className="text-sm font-medium truncate">{ch.title}</span>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
                  </button>
                );
              })}
          </div>
        </aside>
      )}
    </div>
  );
};
