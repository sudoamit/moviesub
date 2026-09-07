'use client';

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Grid2X2, Columns, RefreshCw, Layers, Zap } from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

const TradingChart = dynamic(() => import('./TradingChart').then((mod) => mod.TradingChart), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[320px] bg-[#0c121e] rounded-lg flex items-center justify-center text-slate-500 border border-slate-800 animate-pulse">
      <span className="text-[11px] font-mono">Loading Chart...</span>
    </div>
  ),
});

interface MultiChartGridProps {
  signals: ISignalSetup[];
  tickers: Record<string, any>;
}

export const MultiChartGrid: React.FC<MultiChartGridProps> = ({ signals, tickers }) => {
  const [layout, setLayout] = useState<'dual' | 'quad'>('dual');
  const [pane1Symbol, setPane1Symbol] = useState<string>('NIFTY');
  const [pane1Tf, setPane1Tf] = useState<string>('15m');
  const [pane1Candles, setPane1Candles] = useState<any[]>([]);

  const [pane2Symbol, setPane2Symbol] = useState<string>('BANKNIFTY');
  const [pane2Tf, setPane2Tf] = useState<string>('15m');
  const [pane2Candles, setPane2Candles] = useState<any[]>([]);

  const [pane3Symbol, setPane3Symbol] = useState<string>('RELIANCE');
  const [pane3Tf, setPane3Tf] = useState<string>('15m');
  const [pane3Candles, setPane3Candles] = useState<any[]>([]);

  const [pane4Symbol, setPane4Symbol] = useState<string>('HDFCBANK');
  const [pane4Tf, setPane4Tf] = useState<string>('15m');
  const [pane4Candles, setPane4Candles] = useState<any[]>([]);

  const availableSymbols = [
    'NIFTY',
    'BANKNIFTY',
    'XAUUSD',
    'BTCUSDT',
    'RELIANCE',
    'HDFCBANK',
    'INFY',
  ];
  const timeframes = ['5m', '15m', '1h', '4h', '1d'];

  // Fetch candles helper
  const loadCandles = async (symbol: string, tf: string, setter: (c: any[]) => void) => {
    try {
      const res = await fetch(
        `http://localhost:3001/api/candles/chart-data?symbol=${symbol}&timeframe=${tf}&limit=200`,
      );
      const data = await res.json();
      const candleList = Array.isArray(data) ? data : data?.candles || [];
      const parsedCandles = candleList.map((c: any) => ({
        timestamp: c.timestamp ? new Date(c.timestamp) : new Date((c.time || 0) * 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 1),
        isClosed: true,
      }));
      setter(parsedCandles);
    } catch (e) {
      console.error(`Failed to fetch candles for ${symbol}:`, e);
    }
  };

  useEffect(() => {
    loadCandles(pane1Symbol, pane1Tf, setPane1Candles);
  }, [pane1Symbol, pane1Tf]);

  useEffect(() => {
    loadCandles(pane2Symbol, pane2Tf, setPane2Candles);
  }, [pane2Symbol, pane2Tf]);

  useEffect(() => {
    if (layout === 'quad') {
      loadCandles(pane3Symbol, pane3Tf, setPane3Candles);
      loadCandles(pane4Symbol, pane4Tf, setPane4Candles);
    }
  }, [layout, pane3Symbol, pane3Tf, pane4Symbol, pane4Tf]);

  return (
    <div className="space-y-4 font-mono">
      {/* Top Controls Bar */}
      <div className="bg-[#111827]/95 backdrop-blur-md border border-cyan-500/30 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
            <Grid2X2 className="w-4 h-4" />
          </div>
          <h3 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
            INSTITUTIONAL MULTI-CHART MATRIX
            <span className="bg-cyan-500/20 text-cyan-300 text-[9px] px-2 py-0.5 rounded border border-cyan-500/30">
              SYNCHRONIZED
            </span>
          </h3>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setLayout('dual')}
            className={`px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 border transition-all ${
              layout === 'dual'
                ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/20'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            Dual View (1x2)
          </button>

          <button
            onClick={() => setLayout('quad')}
            className={`px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 border transition-all ${
              layout === 'quad'
                ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/20'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Grid2X2 className="w-3.5 h-3.5" />
            Quad View (2x2)
          </button>
        </div>
      </div>

      {/* Charts Grid */}
      <div
        className={`grid gap-4 ${layout === 'dual' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}
      >
        {/* Pane 1 */}
        <div className="space-y-2 bg-[#111827]/90 border border-slate-800 p-3 rounded-xl">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2 text-xs">
            <div className="flex items-center gap-2">
              <select
                value={pane1Symbol}
                onChange={(e) => setPane1Symbol(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-white font-bold px-2.5 py-1 rounded"
              >
                {availableSymbols.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={pane1Tf}
                onChange={(e) => setPane1Tf(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-cyan-300 font-bold px-2 py-1 rounded"
              >
                {timeframes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <span className="text-xs text-slate-300 font-bold">
              ₹{(tickers[pane1Symbol]?.price || 0).toFixed(2)}
            </span>
          </div>
          <TradingChart
            symbol={pane1Symbol}
            timeframe={pane1Tf}
            candles={pane1Candles}
            signal={signals.find((s) => s.symbol === pane1Symbol)}
            livePrice={tickers[pane1Symbol]?.price}
            onTimeframeChange={setPane1Tf}
          />
        </div>

        {/* Pane 2 */}
        <div className="space-y-2 bg-[#111827]/90 border border-slate-800 p-3 rounded-xl">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2 text-xs">
            <div className="flex items-center gap-2">
              <select
                value={pane2Symbol}
                onChange={(e) => setPane2Symbol(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-white font-bold px-2.5 py-1 rounded"
              >
                {availableSymbols.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={pane2Tf}
                onChange={(e) => setPane2Tf(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-cyan-300 font-bold px-2 py-1 rounded"
              >
                {timeframes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <span className="text-xs text-slate-300 font-bold">
              ₹{(tickers[pane2Symbol]?.price || 0).toFixed(2)}
            </span>
          </div>
          <TradingChart
            symbol={pane2Symbol}
            timeframe={pane2Tf}
            candles={pane2Candles}
            signal={signals.find((s) => s.symbol === pane2Symbol)}
            livePrice={tickers[pane2Symbol]?.price}
            onTimeframeChange={setPane2Tf}
          />
        </div>

        {/* Pane 3 (Quad Only) */}
        {layout === 'quad' && (
          <div className="space-y-2 bg-[#111827]/90 border border-slate-800 p-3 rounded-xl">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2 text-xs">
              <div className="flex items-center gap-2">
                <select
                  value={pane3Symbol}
                  onChange={(e) => setPane3Symbol(e.target.value)}
                  className="bg-slate-900 border border-slate-700 text-white font-bold px-2.5 py-1 rounded"
                >
                  {availableSymbols.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  value={pane3Tf}
                  onChange={(e) => setPane3Tf(e.target.value)}
                  className="bg-slate-900 border border-slate-700 text-cyan-300 font-bold px-2 py-1 rounded"
                >
                  {timeframes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <span className="text-xs text-slate-300 font-bold">
                ₹{(tickers[pane3Symbol]?.price || 0).toFixed(2)}
              </span>
            </div>
            <TradingChart
              symbol={pane3Symbol}
              timeframe={pane3Tf}
              candles={pane3Candles}
              signal={signals.find((s) => s.symbol === pane3Symbol)}
              livePrice={tickers[pane3Symbol]?.price}
              onTimeframeChange={setPane3Tf}
            />
          </div>
        )}

        {/* Pane 4 (Quad Only) */}
        {layout === 'quad' && (
          <div className="space-y-2 bg-[#111827]/90 border border-slate-800 p-3 rounded-xl">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2 text-xs">
              <div className="flex items-center gap-2">
                <select
                  value={pane4Symbol}
                  onChange={(e) => setPane4Symbol(e.target.value)}
                  className="bg-slate-900 border border-slate-700 text-white font-bold px-2.5 py-1 rounded"
                >
                  {availableSymbols.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  value={pane4Tf}
                  onChange={(e) => setPane4Tf(e.target.value)}
                  className="bg-slate-900 border border-slate-700 text-cyan-300 font-bold px-2 py-1 rounded"
                >
                  {timeframes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <span className="text-xs text-slate-300 font-bold">
                ₹{(tickers[pane4Symbol]?.price || 0).toFixed(2)}
              </span>
            </div>
            <TradingChart
              symbol={pane4Symbol}
              timeframe={pane4Tf}
              candles={pane4Candles}
              signal={signals.find((s) => s.symbol === pane4Symbol)}
              livePrice={tickers[pane4Symbol]?.price}
              onTimeframeChange={setPane4Tf}
            />
          </div>
        )}
      </div>
    </div>
  );
};
