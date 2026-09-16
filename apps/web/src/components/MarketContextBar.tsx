'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Clock, Shield, Database, Radio } from 'lucide-react';
import { MarketDataState } from '../hooks/useMarketContext';
import { ITickerInfo } from './LiveTickerBar';

interface MarketContextBarProps {
  selectedSymbol: string;
  selectedTimeframe: string;
  currentTicker: ITickerInfo;
  marketDataState: MarketDataState;
  onSelectSymbol: (symbol: string) => void;
  onSelectTimeframe: (timeframe: string) => void;
}

const SUPPORTED_SYMBOLS = [
  { symbol: 'NIFTY', label: 'NIFTY 50', assetType: 'INDEX' },
  { symbol: 'BANKNIFTY', label: 'BANK NIFTY', assetType: 'INDEX' },
  { symbol: 'BTCUSDT', label: 'BTC / USDT', assetType: 'CRYPTO' },
  { symbol: 'XAUUSD', label: 'XAU / USD', assetType: 'COMMODITY' },
  { symbol: 'RELIANCE', label: 'RELIANCE', assetType: 'EQUITY' },
  { symbol: 'HDFCBANK', label: 'HDFC BANK', assetType: 'EQUITY' },
  { symbol: 'INFY', label: 'INFOSYS', assetType: 'EQUITY' },
];

const TIMEFRAMES = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '30m', label: '30m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
];

export const MarketContextBar: React.FC<MarketContextBarProps> = ({
  selectedSymbol,
  selectedTimeframe,
  currentTicker,
  marketDataState,
  onSelectSymbol,
  onSelectTimeframe,
}) => {
  const isBullish = (currentTicker.changePercent ?? 0) >= 0;
  const isCrypto = selectedSymbol === 'BTCUSDT';
  const isGold = selectedSymbol === 'XAUUSD';

  const priceStr =
    typeof currentTicker.price === 'number'
      ? isCrypto || isGold
        ? `$${currentTicker.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `₹${currentTicker.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '---';

  const changeStr =
    typeof currentTicker.changePercent === 'number'
      ? `${isBullish ? '+' : ''}${currentTicker.changePercent.toFixed(2)}%`
      : '0.00%';

  return (
    <section
      aria-label="Market Context Bar"
      className="bg-surface-subtle border-b border-surface-border px-3 sm:px-6 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 max-w-[1720px] mx-auto font-mono text-xs">
        {/* Left: Symbol & Timeframe Selectors */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Symbol Select Buttons */}
          <div className="flex items-center bg-surface-panel border border-surface-border rounded-lg p-0.5 overflow-x-auto">
            {SUPPORTED_SYMBOLS.map((item) => {
              const isActive = selectedSymbol === item.symbol;
              return (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => onSelectSymbol(item.symbol)}
                  className={`px-2.5 py-1 rounded-md font-bold transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-surface-elevated text-cyan-400 border border-cyan-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-surface-hover'
                  }`}
                >
                  {item.symbol}
                </button>
              );
            })}
          </div>

          {/* Timeframe Select Buttons */}
          <div className="flex items-center bg-surface-panel border border-surface-border rounded-lg p-0.5">
            {TIMEFRAMES.map((tf) => {
              const isActive = selectedTimeframe === tf.id;
              return (
                <button
                  key={tf.id}
                  type="button"
                  onClick={() => onSelectTimeframe(tf.id)}
                  className={`px-2 py-1 rounded font-bold transition-colors ${
                    isActive
                      ? 'bg-cyan-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-surface-hover'
                  }`}
                >
                  {tf.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Center: Live Price & Dynamics */}
        <div className="flex items-center gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-base sm:text-lg font-bold text-white tracking-tight">
              {priceStr}
            </span>
            <span
              className={`text-xs font-bold flex items-center gap-0.5 ${
                isBullish ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isBullish ? (
                <TrendingUp className="w-3.5 h-3.5" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5" />
              )}
              {changeStr}
            </span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-surface-border" />

          {/* High / Low Range */}
          {currentTicker.high > 0 && currentTicker.low > 0 && (
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-400">
              <span>H: {currentTicker.high.toFixed(1)}</span>
              <span>•</span>
              <span>L: {currentTicker.low.toFixed(1)}</span>
            </div>
          )}
        </div>

        {/* Right: Data Provenance & Market Session */}
        <div className="hidden md:flex items-center gap-3 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-panel border border-surface-border">
            <Database className="w-3 h-3 text-cyan-400" />
            <span>
              Feed: <strong className="text-slate-200">{marketDataState.providerId}</strong>
            </span>
            <span>•</span>
            <span>
              Prov: <strong className="text-slate-200">{marketDataState.dataProvenance}</strong>
            </span>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-panel border border-surface-border">
            <Clock className="w-3 h-3 text-emerald-400" />
            <span>
              Session:{' '}
              <strong className="text-slate-200">
                {isCrypto ? '24/7 Live' : isGold ? '23/5 Live' : 'NSE 09:15-15:30'}
              </strong>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
