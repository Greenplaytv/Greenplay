import React, {useEffect, useRef, useState} from 'react';
import {Clock} from 'lucide-react';

interface ValidityCountdownProps {
  expiresAtTimestamp?: number;
  isTrial?: boolean;
  variant?: 'header' | 'compact' | 'detailed';
  onClick?: () => void;
  onExpired?: () => void;
}

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, '0');
}

export function formatRemainingDuration(remainingMs: number, detailed = false): string {
  if (remainingMs <= 0) {
    return 'Expirada';
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) {
    if (detailed) {
      return `${days} ${days === 1 ? 'dia' : 'dias'}, ${pad2(hours)}h ${pad2(minutes)}m ${pad2(seconds)}s`;
    }
    return `${days}d ${pad2(hours)}h ${pad2(minutes)}m ${pad2(seconds)}s`;
  }

  return `${pad2(hours)}h ${pad2(minutes)}m ${pad2(seconds)}s`;
}

export function describeProviderPlanDuration(
  createdAtTimestamp?: number,
  expiresAtTimestamp?: number,
  isTrial?: boolean,
): string | null {
  if (!createdAtTimestamp || !expiresAtTimestamp || expiresAtTimestamp <= createdAtTimestamp) {
    return isTrial ? 'Lista de teste' : null;
  }
  const diffHours = Math.round((expiresAtTimestamp - createdAtTimestamp) / 3600000);
  const diffDays = Math.round(diffHours / 24);

  if (diffHours < 24) {
    return isTrial
      ? `Teste de ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`
      : `Validade de ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
  }
  if (diffDays >= 28 && diffDays <= 32) {
    return isTrial ? 'Teste de 1 mês' : 'Validade de 1 mês';
  }
  if (diffDays >= 360 && diffDays <= 370) {
    return 'Validade de 1 ano';
  }
  return isTrial
    ? `Teste de ${diffDays} ${diffDays === 1 ? 'dia' : 'dias'}`
    : `Validade de ${diffDays} ${diffDays === 1 ? 'dia' : 'dias'}`;
}

export const ValidityCountdown: React.FC<ValidityCountdownProps> = ({
  expiresAtTimestamp,
  isTrial,
  variant = 'header',
  onClick,
  onExpired,
}) => {
  const [now, setNow] = useState<number>(() => Date.now());
  const expiredNotifiedRef = useRef(false);

  useEffect(() => {
    expiredNotifiedRef.current = false;
    setNow(Date.now());
  }, [expiresAtTimestamp]);

  useEffect(() => {
    if (!expiresAtTimestamp) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAtTimestamp]);

  const remainingMs = expiresAtTimestamp ? expiresAtTimestamp - now : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const isExpiringSoon =
    remainingMs !== null && remainingMs > 0 && remainingMs <= 2 * 60 * 60 * 1000;

  useEffect(() => {
    if (isExpired && onExpired && !expiredNotifiedRef.current) {
      expiredNotifiedRef.current = true;
      onExpired();
    }
  }, [isExpired, onExpired]);

  const text =
    remainingMs === null
      ? 'Validade não informada'
      : formatRemainingDuration(remainingMs, variant === 'detailed');

  const toneTextClass = isExpired
    ? 'text-red-300'
    : isExpiringSoon
      ? 'text-amber-300'
      : remainingMs === null
        ? 'text-[#8C9B93]'
        : 'text-[#E2EAE5]';

  const iconClass = isExpired
    ? 'text-red-400'
    : isExpiringSoon
      ? 'text-amber-400'
      : remainingMs === null
        ? 'text-[#75847C]'
        : 'text-emerald-400';

  if (variant === 'detailed') {
    return (
      <span className={`inline-flex items-center gap-1.5 font-mono text-xs tabular-nums ${toneTextClass}`}>
        <Clock className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
        <span>{text}</span>
      </span>
    );
  }

  if (variant === 'compact') {
    const Content = (
      <>
        <Clock className={`h-3 w-3 shrink-0 ${iconClass}`} />
        <span className="font-mono text-[11px] tabular-nums truncate">{text}</span>
      </>
    );

    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          className={`inline-flex items-center gap-1.5 cursor-pointer ${toneTextClass}`}
          title="Ver validade da lista IPTV"
        >
          {Content}
        </button>
      );
    }
    return (
      <span className={`inline-flex items-center gap-1.5 ${toneTextClass}`}>{Content}</span>
    );
  }

  const labelPrefix = isTrial && remainingMs !== null && !isExpired ? 'Teste · ' : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 min-h-[40px] px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#0D1210] hover:border-emerald-500/40 text-xs font-mono tabular-nums transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${toneTextClass}`}
      title="Tempo restante da lista IPTV"
    >
      <Clock className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
      <span>
        {labelPrefix}
        {text}
      </span>
    </button>
  );
};
