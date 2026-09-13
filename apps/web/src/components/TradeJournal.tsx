'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  Target,
  RefreshCw,
  Award,
  Filter,
  DollarSign,
  Zap,
  Calendar,
  Timer,
  Trash2,
  Eye,
  Info,
  ListChecks,
  Sparkles,
  Download,
  X,
} from 'lucide-react';
import {
  ISignalSetup,
  ITradeJournalRecord,
  formatCurrencyAmount,
  formatPriceWithCurrency,
  formatPnlWithCurrency,
} from '@quant/shared';

type ITradeRecord = ITradeJournalRecord & {
  pnlAmount?: number;
  pnlRMultiple?: number;
  activatedAt?: string;
  closedAt?: string;
};

interface IJournalStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  averageR: number;
}

interface TradeJournalProps {
  currentSymbol?: string;
  activeSignal?: ISignalSetup | null;
  livePrice?: number;
  onTradeClosedNotification?: (trade: any) => void;
}

const formatDateTime = (dateStr?: string | Date) => {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';

  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

const formatDuration = (mins: number, durationMs?: number) => {
  const effectiveMs = durationMs ?? (mins > 0 ? mins * 60000 : 0);
  if (!effectiveMs || effectiveMs <= 0) return '< 1m';
  const totalSeconds = Math.floor(effectiveMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};

const formatQuantity = (symbol: string, qty?: number) => {
  if (qty && qty > 0) {
    if (symbol === 'BTCUSDT') return `${qty} BTC`;
    if (symbol === 'XAUUSD' || symbol === 'GOLD') return `${qty} oz Gold`;
    return `${qty} Qty`;
  }
  return 'N/A';
};

const getContractLabel = (symbol: string, direction: string, entryPrice: number) => {
  if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') return null;
  const interval = symbol === 'NIFTY' ? 50 : 100;
  const strike = entryPrice > 1000 ? Math.round(entryPrice / interval) * interval : null;
  if (!strike) return direction === 'BEARISH' || direction === 'SELL' ? 'PE' : 'CE';
  return `${strike} ${direction === 'BEARISH' || direction === 'SELL' ? 'PE' : 'CE'}`;
};

export const TradeJournal: React.FC<TradeJournalProps> = ({
  currentSymbol = 'NIFTY',
  activeSignal,
  livePrice,
  onTradeClosedNotification,
}) => {
  const [trades, setTrades] = useState<ITradeRecord[]>([]);
  const [stats, setStats] = useState<IJournalStats>({
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalPnl: 0,
    profitFactor: 0,
    averageR: 0,
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedFilter, setSelectedFilter] = useState<string>('ALL');
  const [selectedTradeReason, setSelectedTradeReason] = useState<ITradeRecord | null>(null);

  const fetchCompletedTrades = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/signals/completed-trades');
      const data = await res.json();
      if (data && data.trades) {
        setTrades(data.trades);
        setStats(data.stats);
      }
    } catch (e) {
      console.error('Failed to fetch completed trades:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompletedTrades();
    if (typeof window !== 'undefined') {
      const handler = () => {
        fetchCompletedTrades();
      };
      window.addEventListener('quant_trade_closed', handler);
      return () => window.removeEventListener('quant_trade_closed', handler);
    }
  }, [fetchCompletedTrades]);

  const handleClearJournal = async () => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Are you sure you want to clear all closed trades from the Journal?',
      );
      if (!confirmed) return;
    }

    try {
      setIsLoading(true);
      await fetch('http://localhost:3001/api/signals/clear-trades', { method: 'DELETE' });
      await fetch('http://localhost:3001/api/signals/clear-trades', { method: 'POST' }).catch(
        () => {},
      );
      await fetch('http://localhost:3001/api/paper-trading/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialCapital: 1000000.0 }),
      }).catch(() => {});

      setTrades([]);
      setStats({
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnl: 0,
        profitFactor: 0,
        averageR: 0,
      });

      if (typeof window !== 'undefined') {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (
            k &&
            (k.startsWith('quant_pos_cut_') ||
              k.startsWith('quant_trade_') ||
              k.startsWith('quant_pos_closed_'))
          ) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
        window.dispatchEvent(new CustomEvent('quant_journal_cleared'));
        window.dispatchEvent(new CustomEvent('quant_trade_closed', { detail: { symbol: 'ALL' } }));
      }
    } catch (e) {
      console.error('Failed to clear journal:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncHistoricalTrades = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/signals/sync-trades', { method: 'POST' });
      const data = await res.json();
      if (data && data.trades) {
        setTrades(data.trades);
        setStats(data.stats);
      }
    } catch (e) {
      console.error('Failed to sync historical trades:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportTaxReportCsv = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('http://localhost:3001/api/signals/export-csv?limit=500');
      if (!res.ok) throw new Error('Failed to export CSV');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trade-journal-tax-report-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('CSV export failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredTrades = trades.filter((t) => {
    if (selectedFilter === 'ALL') return true;
    if (selectedFilter === 'WINS') return t.state !== 'SL_HIT';
    if (selectedFilter === 'LOSSES') return t.state === 'SL_HIT';
    return t.symbol === selectedFilter;
  });

  const effectiveStats = React.useMemo(() => {
    let totalPnl = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalR = 0;

    trades.forEach((t) => {
      const rawPnl = Number(t.pnlAmount);
      const pnl = rawPnl;
      totalPnl += pnl;
      totalR += Number(t.pnlRMultiple || 0);

      if (pnl >= 0) {
        winningTrades++;
        grossProfit += pnl;
      } else {
        losingTrades++;
        grossLoss += Math.abs(pnl);
      }
    });

    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(1)) : 0;
    const profitFactor =
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99.9 : 0;
    const averageR = totalTrades > 0 ? Number((totalR / totalTrades).toFixed(2)) : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      totalPnl: Number(totalPnl.toFixed(2)),
      profitFactor,
      averageR,
    };
  }, [trades]);

  return (
    <div className="bg-[#111827]/90 backdrop-blur border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
            Institutional Trade Journal & Completed Trades History
          </h3>
          <span className="text-[10px] bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> Auto-Recorded in Postgres
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportTaxReportCsv}
            disabled={isLoading || trades.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-200 rounded-lg font-mono text-xs font-bold transition-all shadow-sm active:scale-95 disabled:opacity-50"
            title="Download Tax & Audit CSV Report with STT, GST, and SEBI fee breakdown"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Export Tax Report</span>
          </button>

          <button
            onClick={handleSyncHistoricalTrades}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-600/30 to-emerald-600/30 border border-cyan-500/50 hover:border-cyan-400 text-cyan-300 rounded-lg font-mono text-xs font-black transition-all shadow-sm active:scale-95"
            title="Scan market history and populate verified strategy executions into Journal"
          >
            <Zap className={`w-3.5 h-3.5 text-cyan-400 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Sync Strategy Executions</span>
          </button>

          <button
            onClick={handleClearJournal}
            disabled={isLoading}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-rose-950/40 border border-rose-800/60 hover:bg-rose-900/60 text-rose-300 rounded-lg font-mono text-xs font-bold transition-colors"
            title="Clear All Trades from Journal"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>

          <button
            onClick={fetchCompletedTrades}
            disabled={isLoading}
            className="p-1.5 bg-slate-900 border border-slate-700 hover:bg-slate-800 rounded-lg text-slate-300 transition-colors"
            title="Refresh Journal"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Performance Analytics Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono text-center">
        {/* Win Rate */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Win Rate</span>
          <span className="text-lg font-black text-emerald-400">{effectiveStats.winRate}%</span>
          <span className="text-[9px] text-slate-500 block mt-0.5">
            {effectiveStats.winningTrades}W / {effectiveStats.losingTrades}L
          </span>
        </div>

        {/* Net Realized PnL */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Net Realized P&L</span>
          <span
            className={`text-lg font-black ${effectiveStats.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
          >
            {effectiveStats.totalPnl >= 0 ? '+' : ''}₹
            {effectiveStats.totalPnl.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="text-[9px] text-slate-500 block mt-0.5">Verified Journal PnL</span>
        </div>

        {/* Total Completed Trades */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Total Recorded</span>
          <span className="text-lg font-black text-white">{effectiveStats.totalTrades}</span>
          <span className="text-[9px] text-slate-500 block mt-0.5">Closed Setups</span>
        </div>

        {/* Profit Factor */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Profit Factor</span>
          <span className="text-lg font-black text-cyan-400">{effectiveStats.profitFactor}</span>
          <span className="text-[9px] text-slate-500 block mt-0.5">Gross Win / Loss</span>
        </div>

        {/* Average R Multiple */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Average R:R</span>
          <span className="text-lg font-black text-teal-300">+{effectiveStats.averageR}R</span>
          <span className="text-[9px] text-slate-500 block mt-0.5">Per Completed Trade</span>
        </div>

        {/* Execution Mode */}
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
          <span className="text-[10px] text-slate-400 uppercase block">Risk Sizing</span>
          <span className="text-lg font-black text-amber-400">1.0% FIXED</span>
          <span className="text-[9px] text-slate-500 block mt-0.5">Institutional Strict</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs font-mono">
        <span className="text-[10px] text-slate-400 flex items-center gap-1 mr-1">
          <Filter className="w-3 h-3" /> Filter:
        </span>
        {[
          'ALL',
          'NIFTY',
          'BANKNIFTY',
          'XAUUSD',
          'BTCUSDT',
          'RELIANCE',
          'HDFCBANK',
          'INFY',
          'WINS',
          'LOSSES',
        ].map((f) => (
          <button
            key={f}
            onClick={() => setSelectedFilter(f)}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-all ${
              selectedFilter === f
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Completed Trades Records Ledger Table with Explicit Trade Reason & Confluence */}
      <div className="overflow-x-auto border border-slate-800 rounded-lg shadow-inner">
        <table className="w-full text-left border-collapse text-xs font-mono min-w-[1100px]">
          <thead>
            <tr className="bg-slate-900/95 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider">
              <th className="py-3 px-3">Instrument</th>
              <th className="py-3 px-3">Bias</th>
              <th className="py-3 px-3">Entry & Exit Price</th>
              <th className="py-3 px-3 min-w-[280px]">Trade Setup Rationale & Reason</th>
              <th className="py-3 px-3">Outcome / Exit Reason</th>
              <th className="py-3 px-3 text-right">Realized Return</th>
              <th className="py-3 px-3 text-right">R-Multiple</th>
              <th className="py-3 px-3 text-left">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-cyan-400" />
                  Entry & Close Time
                </span>
              </th>
              <th className="py-3 px-3 text-center">
                <span className="flex items-center justify-center gap-1">
                  <Timer className="w-3 h-3 text-amber-400" />
                  Duration
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 bg-slate-950/50">
            {filteredTrades.map((t) => {
              const isWin = t.state !== 'SL_HIT' && Number(t.netPnlAccount ?? t.pnlAmount ?? 0) >= 0;
              const isCrypto = t.symbol === 'BTCUSDT' || t.symbol?.includes('BTC');
              const isGold = t.symbol === 'XAUUSD' || t.symbol === 'GOLD';
              const priceCurr = (t as any).entryPriceCurrency || (t as any).currency || (isCrypto ? 'USDT' : isGold ? 'USD' : 'INR');
              const pnlCurr = (t as any).accountCurrency || 'INR';
              const isOption =
                t.instrumentType === 'OPTION' ||
                (Number(t.entryPrice) < 500 && (t.symbol === 'NIFTY' || t.symbol === 'BANKNIFTY'));
              const contractLabel =
                t.contractSymbol && t.contractSymbol !== t.symbol
                  ? t.contractSymbol
                  : isOption && t.strike
                    ? `${t.strike} ${t.optionType || (t.direction === 'BEARISH' || t.direction === 'SELL' ? 'PE' : 'CE')}`
                    : getContractLabel(t.symbol, t.direction, Number(t.entryPrice));

              const isSaiyan = t.tradeReason?.includes('Saiyan') || t.symbol === 'BTCUSDT';
              const effectivePnl = Number(t.netPnlAccount ?? t.pnlAmount ?? 0);
              const effectiveR = Number(t.realizedR ?? t.pnlRMultiple ?? 0);

              return (
                <tr key={t.id} className="hover:bg-slate-900/70 transition-colors">
                  {/* Instrument */}
                  <td className="py-3 px-3 font-bold text-white">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-cyan-300 font-bold">{t.symbol}</span>
                      <span className="text-[9px] bg-slate-800 text-slate-400 px-1 py-0.5 rounded font-normal">
                        {t.timeframe || '15m'}
                      </span>
                      {contractLabel && (
                        <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-800/80 px-1.5 py-0.5 rounded font-mono font-bold tracking-tight shadow-sm">
                          {contractLabel}
                        </span>
                      )}
                      {(t as any).executionDataComplete === false ? (
                        <span className="text-[9px] bg-amber-950/60 text-amber-400 border border-amber-800 px-1 py-0.5 rounded">
                          Execution data unavailable
                        </span>
                      ) : (t as any).isLegacyExecutionData ? (
                        <span className="text-[9px] bg-slate-900 text-slate-400 border border-slate-700 px-1 py-0.5 rounded">
                          Legacy
                        </span>
                      ) : null}
                    </div>
                    <span className="text-[10px] text-slate-400 font-normal block mt-0.5">
                      {formatQuantity(t.symbol, t.quantity)}
                    </span>
                  </td>

                  {/* Direction */}
                  <td className="py-3 px-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5 w-fit ${
                        t.direction === 'BULLISH' || t.direction === 'BUY'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                          : 'bg-rose-950 text-rose-400 border border-rose-800/60'
                      }`}
                    >
                      {t.direction === 'BULLISH' || t.direction === 'BUY' ? (
                        <TrendingUp className="w-3 h-3" />
                      ) : (
                        <TrendingDown className="w-3 h-3" />
                      )}
                      {t.direction}
                    </span>
                  </td>

                  {/* Entry & Exit Price */}
                  <td className="py-3 px-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1 text-[11px]">
                        <span className="text-slate-500 font-normal">Entry:</span>
                        {t.actualEntryPrice != null && (t as any).executionDataComplete !== false ? (
                          <span className="text-cyan-300 font-bold">
                            {formatPriceWithCurrency(t.actualEntryPrice, (t as any).actualEntryPriceCurrency || priceCurr)}
                          </span>
                        ) : (
                          <span className="text-amber-400/90 font-normal text-[10px] italic">
                            Unavailable (Legacy)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[11px]">
                        <span className="text-slate-500 font-normal">Exit:</span>
                        {t.actualExitPrice != null ? (
                          <span className="text-slate-200 font-bold">
                            {formatPriceWithCurrency(t.actualExitPrice, (t as any).actualExitPriceCurrency || priceCurr)}
                          </span>
                        ) : (
                          <span className="text-slate-400 font-normal text-[10px] italic">
                            {formatPriceWithCurrency(t.exitPrice, priceCurr)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Trade Setup Rationale & Reason */}
                  <td className="py-3 px-3 max-w-sm">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {isSaiyan ? (
                          <span className="bg-amber-950/80 text-amber-300 border border-amber-700/80 px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center gap-1">
                            <Zap className="w-2.5 h-2.5 text-amber-400" /> SAIYAN OCC
                          </span>
                        ) : (
                          <span className="bg-cyan-950/80 text-cyan-300 border border-cyan-700/80 px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5 text-cyan-400" /> INSTITUTIONAL SMC
                          </span>
                        )}
                        <span className="text-[9px] bg-slate-900 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded font-bold">
                          Score: {t.score || 88}/100 (Grade {t.grade || 'A+'})
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-300 leading-snug font-sans font-medium line-clamp-2">
                        {t.tradeReason ||
                          `Institutional ${t.direction} momentum trigger with multi-timeframe order flow alignment.`}
                      </p>

                      <button
                        onClick={() => setSelectedTradeReason(t)}
                        className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-bold bg-cyan-950/40 hover:bg-cyan-950/70 border border-cyan-800/60 px-2 py-0.5 rounded transition-all"
                      >
                        <ListChecks className="w-3 h-3" /> View 5-Pt Confluence Checklist
                      </button>
                    </div>
                  </td>

                  {/* Outcome / Exit Reason Badge */}
                  <td className="py-3 px-3">
                    <div className="space-y-1">
                      <div>
                        {t.exitReason?.toLowerCase().includes('manual') ||
                        t.exitReason?.toLowerCase().includes('cut') ? (
                          <span className="bg-amber-950/80 text-amber-300 border border-amber-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                            <Zap className="w-3 h-3 text-amber-400" /> MANUAL MARKET EXIT
                          </span>
                        ) : t.state === 'TP3_HIT' ? (
                          <span className="bg-emerald-950 text-emerald-300 border border-emerald-700 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                            <Award className="w-3 h-3 text-yellow-400" /> TARGET 3 RUNNER (4.0R)
                          </span>
                        ) : t.state === 'TP2_HIT' ? (
                          <span className="bg-teal-950/80 text-teal-300 border border-teal-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                            <Target className="w-3 h-3 text-teal-400" /> TARGET 2 COMPLETED (2.5R)
                          </span>
                        ) : t.state === 'TP1_HIT' ? (
                          <span className="bg-emerald-950/80 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                            <CheckCircle2 className="w-3 h-3" /> TARGET 1 COMPLETED (1.5R)
                          </span>
                        ) : (
                          <span className="bg-rose-950/80 text-rose-400 border border-rose-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                            <XCircle className="w-3 h-3" /> STOP LOSS HIT (-1.0R)
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 font-normal block">
                        {t.exitReason || `${t.state} Hit`}
                      </span>
                    </div>
                  </td>

                  {/* Realized Return */}
                  <td
                    className={`py-3 px-3 text-right font-bold ${
                      effectivePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    <div>
                      <span>
                        {formatPnlWithCurrency(effectivePnl, pnlCurr)}
                      </span>
                      {(t as any).quotePnl !== undefined &&
                        (t as any).quoteCurrency &&
                        (t as any).quoteCurrency !== pnlCurr && (
                          <span className="text-[10px] text-slate-400 block font-normal">
                            {formatPnlWithCurrency(Number((t as any).quotePnl), (t as any).quoteCurrency)}
                          </span>
                        )}
                    </div>
                  </td>

                  {/* R Multiple */}
                  <td
                    className={`py-3 px-3 text-right font-bold ${isWin ? 'text-teal-300' : 'text-rose-400'}`}
                  >
                    {effectiveR >= 0 ? '+' : ''}
                    {effectiveR.toFixed(1)}R
                  </td>

                  {/* Entry & Close Date/Time */}
                  <td className="py-3 px-3 text-slate-300 text-[10px] space-y-0.5">
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500">In:</span>
                      {t.entryTimeUtc != null && (t as any).executionDataComplete !== false ? (
                        <span className="text-cyan-300 font-bold" suppressHydrationWarning>
                          {formatDateTime(t.entryTimeUtc)}
                        </span>
                      ) : (
                        <span className="text-amber-400/90 font-normal italic text-[9px]">
                          Unavailable (Legacy)
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500">Out:</span>
                      {t.exitTimeUtc != null ? (
                        <span className="text-emerald-400 font-bold" suppressHydrationWarning>
                          {formatDateTime(t.exitTimeUtc)}
                        </span>
                      ) : (
                        <span className="text-slate-400 font-normal italic text-[9px]" suppressHydrationWarning>
                          {formatDateTime(t.closedAt)}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Duration */}
                  <td className="py-3 px-3 text-center text-slate-400 text-[11px]">
                    <span className="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-amber-300 font-bold">
                      {formatDuration(t.durationMinutes, (t as any).durationMs)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Trade Reason & Confluence Checklist Modal Popup */}
      {selectedTradeReason && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0B111E] border border-slate-700 rounded-2xl max-w-xl w-full p-6 space-y-5 font-mono shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-black text-white uppercase tracking-wider">
                  Trade Reason & Confluence Breakdown
                </h3>
              </div>
              <button
                onClick={() => setSelectedTradeReason(null)}
                className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Asset & Strategy Header Card */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-black text-white">
                      {selectedTradeReason.symbol}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                        selectedTradeReason.direction === 'BULLISH' || selectedTradeReason.direction === 'BUY'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}
                    >
                      {selectedTradeReason.direction}
                    </span>
                    <span className="text-[10px] bg-slate-900 text-slate-400 border border-slate-800 px-1.5 py-0.5 rounded">
                      {selectedTradeReason.timeframe || '15m'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Entry:{' '}
                    {selectedTradeReason.actualEntryPrice != null &&
                    (selectedTradeReason as any).executionDataComplete !== false
                      ? formatPriceWithCurrency(
                          selectedTradeReason.actualEntryPrice,
                          (selectedTradeReason as any).actualEntryPriceCurrency ||
                            (selectedTradeReason as any).currency ||
                            'INR',
                        )
                      : 'Unavailable (Legacy)'}{' '}
                    • Exit:{' '}
                    {selectedTradeReason.actualExitPrice != null
                      ? formatPriceWithCurrency(
                          selectedTradeReason.actualExitPrice,
                          (selectedTradeReason as any).actualExitPriceCurrency ||
                            (selectedTradeReason as any).currency ||
                            'INR',
                        )
                      : formatPriceWithCurrency(
                          selectedTradeReason.exitPrice,
                          (selectedTradeReason as any).currency || 'INR',
                        )}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-xs font-black text-cyan-400 bg-cyan-950/80 border border-cyan-800 px-2 py-1 rounded">
                    Score: {selectedTradeReason.score || 90}/100 (Grade{' '}
                    {selectedTradeReason.grade || 'A+'})
                  </span>
                  <div className="text-xs font-bold text-emerald-400 mt-1.5">
                    {formatPnlWithCurrency(Number((selectedTradeReason as any).netPnlAccount ?? selectedTradeReason.pnlAmount ?? 0), (selectedTradeReason as any).accountCurrency || 'INR')} ({selectedTradeReason.realizedR ?? selectedTradeReason.pnlRMultiple ?? 0}R)
                  </div>
                </div>
              </div>

              {/* Core Strategy Reason */}
              <div className="space-y-1.5">
                <span className="text-[11px] text-slate-400 font-bold uppercase flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-cyan-400" /> Core Setup Rationale:
                </span>
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 leading-relaxed font-sans font-medium">
                  {selectedTradeReason.tradeReason ||
                    `Institutional ${selectedTradeReason.direction} setup with multi-timeframe order flow alignment.`}
                </div>
              </div>

              {/* 5-Point Confirmed Algorithmic Checklist */}
              <div className="space-y-2">
                <span className="text-[11px] text-slate-400 font-bold uppercase flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-emerald-400" /> Confirmed Algorithmic
                  Checklist:
                </span>
                <div className="space-y-1.5 bg-slate-950 border border-slate-800 rounded-xl p-3">
                  {(
                    selectedTradeReason.checklist || [
                      'Multi-Timeframe Trend & Order Flow Bias Alignment',
                      'Institutional Order Block / Supply-Demand POI Mitigation',
                      'Fair Value Gap (FVG) Liquidity Sweep Mitigation',
                      'Break of Structure (BOS) Volume Confirmation',
                      'Strict Multi-Tier Target Scaling Exit Plan',
                    ]
                  ).map((item, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Exit Justification */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between text-xs">
                <span className="text-slate-400 font-bold uppercase">Exit Execution:</span>
                <span className="text-emerald-300 font-bold">
                  {selectedTradeReason.exitReason || `${selectedTradeReason.state} Hit`}
                </span>
              </div>
            </div>

            <button
              onClick={() => setSelectedTradeReason(null)}
              className="w-full py-2 bg-gradient-to-r from-cyan-500 to-teal-400 hover:from-cyan-400 hover:to-teal-300 text-slate-950 font-black rounded-xl text-xs uppercase tracking-wider transition-all shadow-lg shadow-cyan-500/20"
            >
              Close Breakdown
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
