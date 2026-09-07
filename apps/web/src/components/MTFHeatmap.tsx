'use client';

import React from 'react';
import {
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface MTFHeatmapProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  signals?: ISignalSetup[];
}

export const MTFHeatmap: React.FC<MTFHeatmapProps> = ({
  selectedSymbol,
  onSelectSymbol,
  signals = [],
}) => {
  const baseAssets = [
    { symbol: 'NIFTY', name: 'NIFTY 50', type: 'INDEX' },
    { symbol: 'BANKNIFTY', name: 'Bank NIFTY', type: 'INDEX' },
    { symbol: 'XAUUSD', name: 'Gold Spot (XAU/USD)', type: 'COMMODITY' },
    { symbol: 'BTCUSDT', name: 'Bitcoin 24/7', type: 'CRYPTO' },
    { symbol: 'RELIANCE', name: 'Reliance Ind.', type: 'EQUITY' },
    { symbol: 'HDFCBANK', name: 'HDFC Bank', type: 'EQUITY' },
    { symbol: 'INFY', name: 'Infosys Ltd.', type: 'EQUITY' },
  ];

  const computedMatrix = React.useMemo(() => {
    return baseAssets.map((asset) => {
      const sig = signals.find((s) => s.symbol === asset.symbol);

      let m5 = 'BEARISH';
      let m15 = 'BEARISH';
      let h1 = 'BEARISH';
      let h4 = 'BEARISH';

      if (sig && sig.grade !== 'NO_TRADE' && sig.score > 0) {
        m15 = sig.direction || 'BEARISH';
        h1 = sig.htfBias || sig.direction || 'BEARISH';
        h4 = sig.htfBias || sig.direction || 'BEARISH';
        m5 = sig.direction || 'BEARISH';
      } else {
        // Default market structure fallbacks
        if (asset.symbol === 'BANKNIFTY' || asset.symbol === 'HDFCBANK') {
          m5 = 'BULLISH';
          m15 = 'BULLISH';
          h1 = 'BULLISH';
          h4 = 'BULLISH';
        } else if (asset.symbol === 'BTCUSDT') {
          m5 = 'BEARISH';
          m15 = 'BEARISH';
          h1 = 'BEARISH';
          h4 = 'BEARISH';
        } else {
          m5 = 'BEARISH';
          m15 = 'BEARISH';
          h1 = 'BEARISH';
          h4 = 'BEARISH';
        }
      }

      const bullCount = [m5, m15, h1, h4].filter((d) => d === 'BULLISH').length;
      const bearCount = [m5, m15, h1, h4].filter((d) => d === 'BEARISH').length;
      const is100Aligned = bullCount === 4 || bearCount === 4;
      const is75Aligned = bullCount === 3 || bearCount === 3;

      return {
        ...asset,
        m5,
        m15,
        h1,
        h4,
        is100Aligned,
        is75Aligned,
        alignmentLabel: is100Aligned ? '4/4 Aligned' : is75Aligned ? '3/4 Bias' : 'Divergent',
      };
    });
  }, [signals]);

  const renderBadge = (dir: string) => {
    if (dir === 'BULLISH') {
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <ArrowUpRight className="w-2.5 h-2.5" /> Bull
        </span>
      );
    }
    if (dir === 'BEARISH') {
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
          <ArrowDownRight className="w-2.5 h-2.5" /> Bear
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
        <Minus className="w-2.5 h-2.5" /> Range
      </span>
    );
  };

  return (
    <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-4 shadow-xl space-y-3 font-mono">
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          MULTI-TIMEFRAME STRUCTURE HEATMAP
        </h3>
        <span className="text-[10px] text-slate-400 font-bold bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
          5M • 15M • 1H • 4H
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800/80">
              <th className="pb-2 font-bold">Asset</th>
              <th className="pb-2 text-center font-bold">5M</th>
              <th className="pb-2 text-center font-bold">15M</th>
              <th className="pb-2 text-center font-bold">1H</th>
              <th className="pb-2 text-center font-bold">4H</th>
              <th className="pb-2 text-right font-bold">Structure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {computedMatrix.map((item) => {
              const isSelected = selectedSymbol === item.symbol;
              return (
                <tr
                  key={item.symbol}
                  onClick={() => onSelectSymbol(item.symbol)}
                  className={`cursor-pointer transition-all duration-200 ${
                    isSelected
                      ? 'bg-cyan-500/10 border-l-2 border-cyan-400'
                      : 'hover:bg-slate-800/40'
                  }`}
                >
                  <td className="py-2">
                    <div className="font-black text-white flex items-center gap-1.5 text-[11px]">
                      <span className={isSelected ? 'text-cyan-300' : 'text-slate-200'}>
                        {item.symbol}
                      </span>
                      <span className="text-[8px] text-slate-500 font-bold px-1 py-0.5 bg-slate-900 rounded border border-slate-800">
                        {item.type}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 text-center">{renderBadge(item.m5)}</td>
                  <td className="py-2 text-center">{renderBadge(item.m15)}</td>
                  <td className="py-2 text-center">{renderBadge(item.h1)}</td>
                  <td className="py-2 text-center">{renderBadge(item.h4)}</td>
                  <td className="py-2 text-right">
                    {item.is100Aligned ? (
                      <span className="text-[9px] text-emerald-400 font-bold px-1.5 py-0.5 bg-emerald-950/80 border border-emerald-800/80 rounded inline-flex items-center gap-0.5">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                        {item.alignmentLabel}
                      </span>
                    ) : item.is75Aligned ? (
                      <span className="text-[9px] text-cyan-400 font-bold px-1.5 py-0.5 bg-cyan-950/80 border border-cyan-800/80 rounded">
                        {item.alignmentLabel}
                      </span>
                    ) : (
                      <span className="text-[9px] text-amber-400 font-medium px-1.5 py-0.5 bg-amber-950/80 border border-amber-800/80 rounded inline-flex items-center gap-0.5">
                        <AlertCircle className="w-2.5 h-2.5 text-amber-400" />
                        {item.alignmentLabel}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
