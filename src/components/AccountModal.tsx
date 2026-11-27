import React from 'react';
import {LogOut, Plug, Server, ShieldCheck, X} from 'lucide-react';
import type {AuthSessionInfo} from '../types/catalog';
import {describeProviderPlanDuration, ValidityCountdown} from './ValidityCountdown';

interface AccountModalProps {
  session: AuthSessionInfo;
  onClose: () => void;
  onDisconnect: () => void;
  onConnectList: () => void;
}

export const AccountModal: React.FC<AccountModalProps> = ({
  session,
  onClose,
  onDisconnect,
  onConnectList,
}) => {
  const planSummary = describeProviderPlanDuration(
    session.createdAtTimestamp,
    session.expiresAtTimestamp,
    session.isTrial,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
    >
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-white/10 bg-[#0D1210] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/[0.06]">
          <div>
            <h2 id="account-modal-title" className="font-display text-lg font-semibold text-[#F3F6F4]">
              Conexão IPTV
            </h2>
            <p className="text-xs text-[#9CA8A2] mt-0.5">
              {session.mode === 'demo'
                ? 'Modo demonstração ativo (sem lista real conectada)'
                : session.mode === 'xtream'
                  ? 'Autenticado via Xtream Codes'
                  : 'Autenticado via Lista M3U'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-lg text-[#9CA8A2] hover:text-white cursor-pointer"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="py-5 space-y-3.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8C9B93]">Conta</span>
            <span className="font-medium text-[#F3F6F4] truncate max-w-[220px]">
              {session.accountLabel}
            </span>
          </div>

          {session.serverHost && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[#8C9B93] inline-flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5" />
                Servidor
              </span>
              <span className="font-mono text-xs text-[#D1DBD5] truncate max-w-[220px]">
                {session.serverHost}
              </span>
            </div>
          )}

          {session.status && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[#8C9B93]">Status</span>
              <span className="font-medium text-emerald-400">{session.status}</span>
            </div>
          )}

          {session.mode !== 'demo' && (
            <>
              {planSummary && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#8C9B93]">Plano</span>
                  <span className="font-medium text-[#E2EAE5]">{planSummary}</span>
                </div>
              )}

              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8C9B93]">Tempo restante</span>
                <ValidityCountdown
                  expiresAtTimestamp={session.expiresAtTimestamp}
                  isTrial={session.isTrial}
                  variant="detailed"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8C9B93]">Vencimento</span>
                <span className="font-mono text-xs tabular-nums text-[#F3F6F4]">
                  {session.expiresAt || 'Validade não informada'}
                </span>
              </div>
            </>
          )}

          {session.maxConnections && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[#8C9B93]">Conexões</span>
              <span className="font-mono text-xs tabular-nums text-[#F3F6F4]">
                {session.activeConnections || '0'} / {session.maxConnections}
              </span>
            </div>
          )}

          <div className="pt-2 flex items-start gap-2.5 text-xs text-[#8C9B93]">
            <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              Sua conexão é mantida em sessão segura criptografada sem expor DNS, usuário ou senha no navegador.
            </span>
          </div>
        </div>

        <div className="pt-2 flex flex-col gap-2.5">
          {session.mode === 'demo' ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                onConnectList();
              }}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-[#04120B] font-semibold text-sm transition-colors cursor-pointer"
            >
              <Plug className="h-4 w-4" />
              <span>Conectar lista IPTV real</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onClose();
                onDisconnect();
              }}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 font-medium text-sm transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>Desconectar lista</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
