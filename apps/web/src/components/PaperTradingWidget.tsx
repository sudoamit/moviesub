'use client';

import React, { useState, useEffect } from 'react';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Percent,
  Calculator,
  Shield,
  Target,
  XCircle,
  Clock,
  RotateCcw,
  History,
  BarChart2,
  Check,
  DollarSign,
} from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface PaperTradingWidgetProps {
  currentSymbol: string;
  activeSignal: ISignalSetup | null;
  livePrice: number;
}

export const PaperTradingWidget: React.FC<PaperTradingWidgetProps> = ({
  currentSymbol,
  activeSignal,
  livePrice,
}) => {
  const isCrypto = currentSymbol === 'BTCUSDT';
  const isGold = currentSymbol === 'XAUUSD' || currentSymbol === 'GOLD';
  const currencySymbol = isGold || isCrypto ? '$' : '₹';

  const [portfolio, setPortfolio] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'positions' | 'history' | 'analytics'>('positions');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [lots, setLots] = useState<number>(1);
  const [customQty, setCustomQty] = useState<number>(0);
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>(
    activeSignal?.direction === 'BEARISH' ? 'SELL' : 'BUY',
  );
  const [leverage, setLeverage] = useState<number>(5);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('quant_risk_leverage');
      if (saved && !isNaN(Number(saved))) {
        setLeverage(Number(saved));
      }
    }
  }, []);

  // Exact Exchange Lot Multipliers
  const getLotMultiplier = (sym: string): number => {
    switch (sym.toUpperCase()) {
      case 'NIFTY':
        return 65;
      case 'BANKNIFTY':
        return 15;
      case 'FINNIFTY':
        return 40;
      case 'RELIANCE':
        return 250;
      case 'HDFCBANK':
        return 550;
      case 'INFY':
        return 400;
      case 'BTCUSDT':
        return 0.01;
      case 'XAUUSD':
      case 'GOLD':
        return 1;
      default:
        return 1;
    }
  };

  const lotMultiplier = getLotMultiplier(currentSymbol);
  const totalQuantity = customQty > 0 ? customQty : lots * lotMultiplier;

  const cmp = livePrice || activeSignal?.entryZone?.optimal || 100.0;
  const notionalTurnover = cmp * totalQuantity;
  const estimatedCharges = isCrypto
    ? Number((notionalTurnover * 0.0004).toFixed(2))
    : Number((20.0 + notionalTurnover * 0.00016).toFixed(2));
  const estimatedMargin = Number((notionalTurnover / leverage + estimatedCharges).toFixed(2));

  const fetchPortfolio = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/paper-trading/portfolio');
      const data = await res.json();
      setPortfolio(data);
    } catch (e) {
      console.error('Failed to fetch paper portfolio:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeSignal) {
      setOrderSide(activeSignal.direction === 'BEARISH' ? 'SELL' : 'BUY');
    }
  }, [activeSignal, currentSymbol]);

  const handlePlaceOrder = async (overrideSide?: 'BUY' | 'SELL') => {
    const side = overrideSide || orderSide;
    try {
      setIsSubmitting(true);
      const res = await fetch('http://localhost:3001/api/paper-trading/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: currentSymbol,
          direction: side,
          quantity: totalQuantity,
          orderType: 'MARKET',
          price: cmp,
          stopLoss: activeSignal?.stopLoss,
          target1: activeSignal?.takeProfits?.tp1,
          target2: activeSignal?.takeProfits?.tp2,
          target3: activeSignal?.takeProfits?.tp3,
          leverage,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to place order');
      }

      setStatusMessage(
        `✓ Virtual Order Executed: ${side} ${totalQuantity} ${currentSymbol} @ ${currencySymbol}${cmp.toFixed(2)} (${leverage}x)`,
      );
      setTimeout(() => setStatusMessage(null), 5000);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(`quant_pos_cut_${currentSymbol}`);
        localStorage.removeItem(`quant_pos_cut_summary_${currentSymbol}`);
        window.dispatchEvent(
          new CustomEvent('quant_trade_opened', { detail: { symbol: currentSymbol } }),
        );
      }
      fetchPortfolio();
    } catch (err: any) {
      setStatusMessage(`❌ Order Rejected: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 6000);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClosePosition = async (posId: string) => {
    try {
      const res = await fetch('http://localhost:3001/api/paper-trading/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: posId, reason: 'Manual User Market Exit' }),
      });
      const data = await res.json();
      setStatusMessage(
        `✓ Position Closed @ ${currencySymbol}${data.exitPrice.toFixed(2)} | Net PnL: ${currencySymbol}${data.realizedPnL.toFixed(2)}`,
      );
      setTimeout(() => setStatusMessage(null), 5000);
      if (typeof window !== 'undefined') {
        localStorage.setItem(`quant_pos_cut_${currentSymbol}`, 'true');
        window.dispatchEvent(
          new CustomEvent('quant_trade_closed', { detail: { symbol: currentSymbol } }),
        );
      }
      fetchPortfolio();
    } catch (e: any) {
      setStatusMessage(`❌ Close Error: ${e.message}`);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleResetPortfolio = async () => {
    if (
      !confirm(
        `Are you sure you want to reset your virtual paper balance to ${isCrypto ? '$10,000' : '₹10,00,000'}?`,
      )
    )
      return;
    try {
      await fetch('http://localhost:3001/api/paper-trading/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialCapital: isCrypto ? 10000.0 : 1000000.0 }),
      });
      setStatusMessage(
        `✓ Virtual Brokerage balance reset to ${isCrypto ? '$10,000' : '₹10,00,000'}`,
      );
      setTimeout(() => setStatusMessage(null), 4000);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('quant_trade_closed', { detail: { symbol: 'ALL' } }));
      }
      fetchPortfolio();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="bg-[#0B0F19] border border-cyan-500/30 rounded-xl p-4 sm:p-6 shadow-2xl space-y-5 font-mono relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute top-0 left-0 w-80 h-80 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-500/10">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-black uppercase tracking-tight text-white flex items-center gap-1.5">
                INSTITUTIONAL PAPER TRADING SIMULATOR
              </h3>
              <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded border border-emerald-500/40">
                100% RISK FREE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Simulate live 1-click market execution with real exchange transaction charges, STT,
              and margin.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchPortfolio}
            className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-white transition-all text-xs flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetPortfolio}
            className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1 bg-slate-900 border border-slate-800 hover:bg-slate-800 px-3 py-1.5 rounded-lg transition-all font-bold"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Balance ({isCrypto ? '$10k' : '₹10.0L'})
          </button>
        </div>
      </div>

      {/* Account Balances Matrix */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 block uppercase font-bold">TOTAL EQUITY</span>
          <span className="text-lg sm:text-xl font-black text-white block mt-0.5">
            {currencySymbol}
            {portfolio?.totalEquity?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ||
              (isCrypto ? '10,000.00' : '10,00,000.00')}
          </span>
          <span className="text-[9px] text-slate-500">Virtual Portfolio</span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 block uppercase font-bold">
            AVAILABLE MARGIN
          </span>
          <span className="text-lg sm:text-xl font-black text-cyan-300 block mt-0.5">
            {currencySymbol}
            {portfolio?.availableMargin?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ||
              (isCrypto ? '10,000.00' : '10,00,000.00')}
          </span>
          <span className="text-[9px] text-slate-500">
            Used: {currencySymbol}
            {portfolio?.usedMargin?.toLocaleString() || '0'}
          </span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 block uppercase font-bold">REALIZED P&L</span>
          <span
            className={`text-lg sm:text-xl font-black block mt-0.5 ${
              (portfolio?.realizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {(portfolio?.realizedPnL || 0) >= 0 ? '+' : ''}
            {currencySymbol}
            {portfolio?.realizedPnL?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ||
              '0.00'}
          </span>
          <span className="text-[9px] text-slate-500">
            Win Rate: {portfolio?.winRate || 0}% ({portfolio?.totalTrades || 0} trades)
          </span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 block uppercase font-bold">
            UNREALIZED P&L
          </span>
          <span
            className={`text-lg sm:text-xl font-black block mt-0.5 ${
              (portfolio?.unrealizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {(portfolio?.unrealizedPnL || 0) >= 0 ? '+' : ''}
            {currencySymbol}
            {portfolio?.unrealizedPnL?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ||
              '0.00'}
          </span>
          <span className="text-[9px] text-slate-500">
            {portfolio?.openPositions?.length || 0} Active Position(s)
          </span>
        </div>
      </div>

      {/* Execution Control Center */}
      <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Sizing & Lots Selector */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-slate-300">ORDER SIZE:</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {[1, 2, 5, 10].map((l) => (
                <button
                  key={l}
                  onClick={() => {
                    setLots(l);
                    setCustomQty(0);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    lots === l && customQty === 0
                      ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/20'
                      : 'bg-slate-950 text-slate-300 border-slate-700 hover:bg-slate-800'
                  }`}
                >
                  {l} Lot{l > 1 ? 's' : ''} (
                  {isCrypto
                    ? `${(l * lotMultiplier).toFixed(2)} BTC`
                    : isGold
                      ? `${l * lotMultiplier} oz`
                      : `${l * lotMultiplier} Qty`}
                  )
                </button>
              ))}
            </div>
          </div>

          {/* Leverage Selector */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 font-bold flex items-center gap-1">
              <Zap className="w-3 h-3 text-cyan-400" /> Leverage:
            </span>
            <div className="flex gap-1">
              {[1, 2, 5, 10, 20].map((lev) => (
                <button
                  key={lev}
                  onClick={() => setLeverage(lev)}
                  className={`px-2 py-1 rounded-md text-[11px] font-bold border transition-all ${
                    leverage === lev
                      ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Cost and Margin Summary Strip */}
        <div className="bg-slate-950/80 border border-slate-800/80 p-2.5 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
          <div>
            CMP:{' '}
            <strong className="text-white">
              {currencySymbol}
              {cmp.toFixed(2)}
            </strong>
          </div>
          <div>
            Notional:{' '}
            <strong className="text-cyan-300">
              {currencySymbol}
              {notionalTurnover.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </strong>
          </div>
          <div>
            Margin Req (@ {leverage}x):{' '}
            <strong className="text-emerald-400">
              {currencySymbol}
              {estimatedMargin.toLocaleString()}
            </strong>
          </div>
          <div>
            Est. Charges:{' '}
            <strong className="text-amber-400">
              {currencySymbol}
              {estimatedCharges}
            </strong>
          </div>
        </div>

        {/* 1-Click Buy / Sell Execution Buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => handlePlaceOrder('BUY')}
            disabled={isSubmitting}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black py-3 rounded-xl flex items-center justify-center gap-2 text-sm transition-all shadow-lg shadow-emerald-950/50 active:scale-[0.99]"
          >
            <TrendingUp className="w-4 h-4" />
            1-CLICK BUY MARKET ({totalQuantity} {currentSymbol} @ {currencySymbol}
            {cmp.toFixed(2)})
          </button>

          <button
            onClick={() => handlePlaceOrder('SELL')}
            disabled={isSubmitting}
            className="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-black py-3 rounded-xl flex items-center justify-center gap-2 text-sm transition-all shadow-lg shadow-rose-950/50 active:scale-[0.99]"
          >
            <TrendingDown className="w-4 h-4" />
            1-CLICK SELL SHORT ({totalQuantity} {currentSymbol} @ {currencySymbol}
            {cmp.toFixed(2)})
          </button>
        </div>

        {statusMessage && (
          <div className="p-3 rounded-xl bg-slate-950 border border-cyan-500/40 text-cyan-300 text-xs text-center font-bold animate-in fade-in">
            {statusMessage}
          </div>
        )}
      </div>

      {/* Tabs for Positions vs Trade History vs Performance Analytics */}
      <div className="space-y-3">
        <div className="flex border-b border-slate-800 gap-4 text-xs font-bold">
          <button
            onClick={() => setActiveTab('positions')}
            className={`pb-2.5 flex items-center gap-1.5 transition-all ${
              activeTab === 'positions'
                ? 'border-b-2 border-cyan-400 text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            ACTIVE POSITIONS ({portfolio?.openPositions?.length || 0})
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`pb-2.5 flex items-center gap-1.5 transition-all ${
              activeTab === 'history'
                ? 'border-b-2 border-cyan-400 text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <History className="w-4 h-4" />
            TRADE HISTORY ({portfolio?.tradeHistory?.length || 0})
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            className={`pb-2.5 flex items-center gap-1.5 transition-all ${
              activeTab === 'analytics'
                ? 'border-b-2 border-cyan-400 text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart2 className="w-4 h-4" />
            PERFORMANCE METRICS
          </button>
        </div>

        {/* TAB 1: ACTIVE POSITIONS */}
        {activeTab === 'positions' && (
          <div>
            {portfolio?.openPositions?.length === 0 ? (
              <div className="p-8 rounded-xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500 space-y-1">
                <p className="font-bold text-slate-400">No active paper trading positions.</p>
                <p>Click BUY or SELL above to execute a virtual order at live market prices.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-900/90 text-slate-400 font-bold border-b border-slate-800">
                    <tr>
                      <th className="p-3">Symbol</th>
                      <th className="p-3">Side</th>
                      <th className="p-3">Qty</th>
                      <th className="p-3">Avg Entry</th>
                      <th className="p-3">CMP</th>
                      <th className="p-3">SL / TP2</th>
                      <th className="p-3">Unrealized P&L</th>
                      <th className="p-3">Charges</th>
                      <th className="p-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-950/60">
                    {portfolio?.openPositions?.map((pos: any) => {
                      const isCryptoPos = pos.symbol === 'BTCUSDT' || pos.symbol?.includes('BTC');
                      const posCurr = isCryptoPos ? '$' : '₹';
                      return (
                        <tr key={pos.id} className="hover:bg-slate-900/50 transition-colors">
                          <td className="p-3 font-black text-white">
                            <span className="text-cyan-300">
                              {pos.contractSymbol || pos.symbol}
                            </span>
                          </td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                pos.direction === 'BUY'
                                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                  : 'bg-rose-950 text-rose-400 border border-rose-800'
                              }`}
                            >
                              {pos.direction} ({pos.leverage}x)
                            </span>
                          </td>
                          <td className="p-3 text-slate-300 font-bold">{pos.quantity}</td>
                          <td className="p-3 text-slate-300">
                            {posCurr}
                            {pos.entryPrice?.toFixed(2) || pos.averageEntryPrice?.toFixed(2)}
                          </td>
                          <td className="p-3 text-cyan-300 font-bold">
                            {posCurr}
                            {pos.currentPrice.toFixed(2)}
                          </td>
                          <td className="p-3 text-[11px]">
                            <span className="text-rose-400 font-bold block">
                              SL: {posCurr}
                              {pos.stopLoss ? pos.stopLoss.toFixed(2) : '-'}
                            </span>
                            <span className="text-emerald-400 font-bold block">
                              TP: {posCurr}
                              {pos.target2 ? pos.target2.toFixed(2) : '-'}
                            </span>
                          </td>
                          <td className="p-3 font-bold">
                            <span
                              className={
                                pos.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
                              }
                            >
                              {pos.unrealizedPnL >= 0 ? '+' : ''}
                              {posCurr}
                              {pos.unrealizedPnL.toFixed(2)} ({pos.unrealizedR}R)
                            </span>
                          </td>
                          <td className="p-3 text-slate-500">
                            {posCurr}
                            {pos.charges?.totalCharges || 20}
                          </td>
                          <td className="p-3 text-right">
                            <button
                              onClick={() => handleClosePosition(pos.id)}
                              className="bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white border border-rose-500/40 px-3 py-1 rounded-lg text-xs font-bold transition-all shadow-sm"
                            >
                              Close @ Market
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: TRADE HISTORY */}
        {activeTab === 'history' && (
          <div>
            {portfolio?.tradeHistory?.length === 0 ? (
              <div className="p-8 rounded-xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500">
                No closed trades yet in this session.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-900/90 text-slate-400 font-bold border-b border-slate-800">
                    <tr>
                      <th className="p-3">Symbol</th>
                      <th className="p-3">Side</th>
                      <th className="p-3">Qty</th>
                      <th className="p-3">Entry Price</th>
                      <th className="p-3">Exit Price</th>
                      <th className="p-3">Realized P&L</th>
                      <th className="p-3">R-Multiple</th>
                      <th className="p-3">Exit Reason</th>
                      <th className="p-3">Closed At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-950/60">
                    {portfolio?.tradeHistory?.map((trade: any) => {
                      const isCryptoTrade =
                        trade.symbol === 'BTCUSDT' || trade.symbol?.includes('BTC');
                      const tradeCurr = isCryptoTrade ? '$' : '₹';
                      return (
                        <tr key={trade.id} className="hover:bg-slate-900/50 transition-colors">
                          <td className="p-3 font-black text-white">
                            <span className="text-cyan-300">
                              {trade.contractSymbol || trade.symbol}
                            </span>
                          </td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                trade.direction === 'BUY'
                                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                  : 'bg-rose-950 text-rose-400 border border-rose-800'
                              }`}
                            >
                              {trade.direction}
                            </span>
                          </td>
                          <td className="p-3 text-slate-300 font-bold">{trade.quantity}</td>
                          <td className="p-3 text-slate-300">
                            {tradeCurr}
                            {trade.entryPrice.toFixed(2)}
                          </td>
                          <td className="p-3 text-cyan-300 font-bold">
                            {tradeCurr}
                            {trade.exitPrice.toFixed(2)}
                          </td>
                          <td className="p-3 font-black">
                            <span
                              className={
                                trade.realizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
                              }
                            >
                              {trade.realizedPnL >= 0 ? '+' : ''}
                              {tradeCurr}
                              {trade.realizedPnL.toFixed(2)}
                            </span>
                          </td>
                          <td className="p-3 font-bold text-slate-300">
                            {trade.realizedR >= 0 ? `+${trade.realizedR}R` : `${trade.realizedR}R`}
                          </td>
                          <td className="p-3 text-slate-400 font-medium">
                            <span className="bg-slate-900 px-2 py-0.5 rounded border border-slate-800 text-[10px]">
                              {trade.exitReason}
                            </span>
                          </td>
                          <td className="p-3 text-slate-500 text-[10px]" suppressHydrationWarning>
                            {new Date(trade.closedAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: PERFORMANCE ANALYTICS */}
        {activeTab === 'analytics' && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
              <span className="text-[10px] text-slate-400 block uppercase font-bold">WIN RATE</span>
              <span className="text-xl font-black text-emerald-400 mt-1 block">
                {portfolio?.winRate || 0}%
              </span>
              <span className="text-[9px] text-slate-500">
                {portfolio?.winningTrades || 0} Wins / {portfolio?.losingTrades || 0} Losses
              </span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
              <span className="text-[10px] text-slate-400 block uppercase font-bold">
                PROFIT FACTOR
              </span>
              <span className="text-xl font-black text-cyan-300 mt-1 block">
                {portfolio?.profitFactor || 0}
              </span>
              <span className="text-[9px] text-slate-500">Gross Wins / Gross Losses</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
              <span className="text-[10px] text-slate-400 block uppercase font-bold">
                TOTAL TRADES
              </span>
              <span className="text-xl font-black text-white mt-1 block">
                {portfolio?.totalTrades || 0}
              </span>
              <span className="text-[9px] text-slate-500">Completed roundtrips</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
              <span className="text-[10px] text-slate-400 block uppercase font-bold">
                CHARGES & TAXES
              </span>
              <span className="text-xl font-black text-amber-400 mt-1 block">
                ₹{portfolio?.totalChargesPaid?.toFixed(2) || '0.00'}
              </span>
              <span className="text-[9px] text-slate-500">Brokerage, STT, GST, SEBI</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
