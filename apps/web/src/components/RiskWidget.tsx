'use client';

import React, { useState, useEffect } from 'react';
import {
  Calculator,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  Coins,
  Percent,
  Sliders,
  IndianRupee,
  Layers,
  Sparkles,
  Zap,
  Target,
  Shield,
  RotateCcw,
  Check,
} from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface RiskWidgetProps {
  selectedSignal: ISignalSetup | null;
}

export const RiskWidget: React.FC<RiskWidgetProps> = ({ selectedSignal }) => {
  const isCrypto = selectedSignal?.symbol === 'BTCUSDT';
  const isGold = selectedSignal?.symbol === 'XAUUSD' || selectedSignal?.symbol === 'GOLD';
  const currencySymbol = isCrypto || isGold ? '$' : '₹';

  // Persistent States with localStorage fallback
  const [accountBalance, setAccountBalance] = useState<number>(1000000);
  const [riskPercent, setRiskPercent] = useState<number>(1.0);
  const [leverage, setLeverage] = useState<number>(5);
  const [tradeMode, setTradeMode] = useState<'FO' | 'CASH'>('FO');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedBal = localStorage.getItem('quant_account_balance');
      if (savedBal && !isNaN(Number(savedBal))) setAccountBalance(Number(savedBal));

      const savedRisk = localStorage.getItem('quant_risk_percent');
      if (savedRisk && !isNaN(Number(savedRisk))) setRiskPercent(Number(savedRisk));

      const savedLev = localStorage.getItem('quant_risk_leverage');
      if (savedLev && !isNaN(Number(savedLev))) setLeverage(Number(savedLev));

      const savedMode = localStorage.getItem('quant_sizing_mode');
      if (savedMode === 'FO' || savedMode === 'CASH') setTradeMode(savedMode);
    }
  }, []);

  const [entryPrice, setEntryPrice] = useState<number>(24175.65);
  const [stopLoss, setStopLoss] = useState<number>(24086.6);
  const [tp1Price, setTp1Price] = useState<number>(24302.62);
  const [tp2Price, setTp2Price] = useState<number>(24387.27);
  const [lotSize, setLotSize] = useState<number>(65);
  const [savedNotification, setSavedNotification] = useState<string | null>(null);

  // Save leverage changes immediately to localStorage
  const handleLeverageChange = (newLev: number) => {
    const val = Math.max(1, Math.min(125, newLev));
    setLeverage(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_risk_leverage', String(val));
    }
    showSavedToast(`⚡ Leverage set to ${val}x (Saved to Profile)`);
  };

  // Save account balance changes to localStorage
  const handleBalanceChange = (newBal: number) => {
    const val = Math.max(1, newBal);
    setAccountBalance(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_account_balance', String(val));
    }
  };

  // Save risk percent changes to localStorage
  const handleRiskPercentChange = (newRisk: number) => {
    const val = Math.max(0.1, Math.min(10, newRisk));
    setRiskPercent(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_risk_percent', String(val));
    }
  };

  // Save trade mode to localStorage
  const handleTradeModeChange = (mode: 'FO' | 'CASH') => {
    setTradeMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_sizing_mode', mode);
    }
  };

  const showSavedToast = (msg: string) => {
    setSavedNotification(msg);
    setTimeout(() => setSavedNotification(null), 3000);
  };

  // Sync with selected signal whenever it changes
  useEffect(() => {
    if (selectedSignal) {
      const isBtc = selectedSignal.symbol === 'BTCUSDT';
      const optimal = selectedSignal.entryZone?.optimal || 24175.65;
      const sl = selectedSignal.stopLoss || optimal * 0.995;
      const tp1 = selectedSignal.takeProfits?.tp1 || optimal + Math.abs(optimal - sl) * 1.5;
      const tp2 = selectedSignal.takeProfits?.tp2 || optimal + Math.abs(optimal - sl) * 2.5;

      setEntryPrice(Number(optimal.toFixed(2)));
      setStopLoss(Number(sl.toFixed(2)));
      setTp1Price(Number(tp1.toFixed(2)));
      setTp2Price(Number(tp2.toFixed(2)));

      if (isBtc) {
        setLotSize(0.001);
        setTradeMode('CASH');
      } else if (selectedSignal.symbol === 'XAUUSD' || selectedSignal.symbol === 'GOLD') {
        setLotSize(1);
        setTradeMode('CASH');
      } else if (selectedSignal.symbol === 'NIFTY') {
        setLotSize(65);
        setTradeMode('FO');
      } else if (selectedSignal.symbol === 'BANKNIFTY') {
        setLotSize(15);
        setTradeMode('FO');
      } else if (selectedSignal.symbol === 'RELIANCE') {
        setLotSize(250);
        setTradeMode('CASH');
      } else if (selectedSignal.symbol === 'HDFCBANK') {
        setLotSize(550);
        setTradeMode('CASH');
      } else if (selectedSignal.symbol === 'INFY') {
        setLotSize(400);
        setTradeMode('CASH');
      } else {
        setLotSize(1);
        setTradeMode('CASH');
      }
    }
  }, [selectedSignal]);

  // Mathematical Risk Calculations
  const USD_INR_RATE = 87.0;
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const target1Distance = Math.abs(tp1Price - entryPrice);
  const target2Distance = Math.abs(tp2Price - entryPrice);
  const plannedRiskAmount = (accountBalance * riskPercent) / 100;

  // Unit / Quantity sizing
  const inrRiskPerUnit = isCrypto ? riskPerUnit * USD_INR_RATE : riskPerUnit;
  let calculatedUnits = inrRiskPerUnit > 0 ? plannedRiskAmount / inrRiskPerUnit : 0;
  let finalUnits = 0;
  let lotsCount = 0;

  if (isCrypto) {
    // Crypto fractional sizing (rounded to 4 decimals, min 0.001)
    finalUnits = Math.max(0.001, Number(calculatedUnits.toFixed(4)));
  } else if (tradeMode === 'FO') {
    // F&O Lot-Based sizing
    const effectiveLot = Math.max(1, lotSize);
    lotsCount = Math.max(1, Math.floor(calculatedUnits / effectiveLot));
    finalUnits = lotsCount * effectiveLot;
  } else {
    // Cash direct shares sizing
    finalUnits = Math.max(1, Math.floor(calculatedUnits));
  }

  // Notional & Profit/Loss Values
  const totalPositionValue = finalUnits * entryPrice * (isCrypto ? USD_INR_RATE : 1.0);
  const actualMaxRisk = finalUnits * riskPerUnit * (isCrypto ? USD_INR_RATE : 1.0);
  const actualRiskPercent = accountBalance > 0 ? (actualMaxRisk / accountBalance) * 100 : 0;
  const expectedProfitTP1 = finalUnits * target1Distance * (isCrypto ? USD_INR_RATE : 1.0);
  const expectedProfitTP2 = finalUnits * target2Distance * (isCrypto ? USD_INR_RATE : 1.0);
  const rewardToRiskRatio =
    riskPerUnit > 0 ? Number((target2Distance / riskPerUnit).toFixed(2)) : 0;

  const marginRequired = totalPositionValue / leverage;
  const freeMargin = Math.max(0, accountBalance - marginRequired);
  const marginUsagePercent =
    accountBalance > 0 ? Math.min(100, (marginRequired / accountBalance) * 100) : 0;
  const isMarginWarning = marginRequired > accountBalance;

  // Quick Account Balance Presets (INR)
  const currentPresets = [50000, 100000, 200000, 500000, 1000000, 2500000, 5000000];

  const leveragePresets = isCrypto ? [1, 5, 10, 20, 50, 100] : [1, 2, 4, 5, 10];

  return (
    <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-4 sm:p-6 shadow-2xl font-mono space-y-5 relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-500/10">
            <Calculator className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-black text-white uppercase tracking-tight">
                INSTITUTIONAL RISK & POSITION SIZING CALCULATOR
              </h3>
              <span className="bg-cyan-950 text-cyan-300 border border-cyan-800 px-2 py-0.5 rounded text-[10px] font-bold">
                {selectedSignal?.symbol || 'NIFTY'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Strict quantitative capital preservation engine guaranteeing fixed % equity risk and
              leverage persistence.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {savedNotification && (
            <span className="text-[11px] text-emerald-400 bg-emerald-950/60 border border-emerald-500/40 px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 animate-in fade-in">
              <Check className="w-3 h-3" /> {savedNotification}
            </span>
          )}

          <span className="text-xs text-emerald-400 flex items-center gap-1.5 bg-emerald-950/40 border border-emerald-800/40 px-3 py-1 rounded-lg font-bold">
            <ShieldCheck className="w-4 h-4" /> {riskPercent}% Capital Risk
          </span>
        </div>
      </div>

      {/* Quick Account Balance Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl text-xs">
        <span className="text-[11px] text-slate-400 font-bold flex items-center gap-1">
          <Coins className="w-3.5 h-3.5 text-cyan-400" />
          ACCOUNT CAPITAL PRESETS (₹ INR):
        </span>
        <div className="flex flex-wrap gap-1.5">
          {currentPresets.map((bal) => (
            <button
              key={bal}
              onClick={() => handleBalanceChange(bal)}
              className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition-all ${
                accountBalance === bal
                  ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                  : 'bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              ₹
              {bal >= 100000
                ? `${(bal / 100000).toFixed(bal % 100000 === 0 ? 0 : 1)}L`
                : `${bal / 1000}k`}
            </button>
          ))}
        </div>
      </div>

      {/* Two Column Layout: Left Inputs, Right Calculations */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Parameter Inputs (7 Cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-xs">
            {/* 1. Account Balance */}
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-1.5">
              <label className="text-[10px] uppercase text-slate-400 font-bold block">
                Account Balance ({currencySymbol})
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={accountBalance}
                  onChange={(e) => handleBalanceChange(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-black text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>
            </div>

            {/* 2. Risk Percentage */}
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase text-slate-400 font-bold">
                  Risk Per Trade (% Equity)
                </label>
                <span className="text-xs font-black text-emerald-400">{riskPercent}%</span>
              </div>
              <div className="flex gap-1">
                {[0.5, 1.0, 1.5, 2.0].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => handleRiskPercentChange(pct)}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                      riskPercent === pct
                        ? 'bg-emerald-500 text-slate-950 shadow-sm'
                        : 'bg-slate-950 border border-slate-700 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {/* 3. Entry Price */}
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-1.5">
              <label className="text-[10px] uppercase text-slate-400 font-bold block">
                Entry Price ({currencySymbol})
              </label>
              <input
                type="number"
                step="any"
                value={entryPrice}
                onChange={(e) => setEntryPrice(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-cyan-400 font-black text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>

            {/* 4. Stop Loss */}
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase text-slate-400 font-bold">
                  Stop Loss ({currencySymbol})
                </label>
                <span className="text-[10px] text-rose-400 font-bold">
                  Δ {riskPerUnit.toFixed(2)} pts
                </span>
              </div>
              <input
                type="number"
                step="any"
                value={stopLoss}
                onChange={(e) => setStopLoss(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-rose-400 font-black text-sm focus:border-rose-500 focus:outline-none"
              />
            </div>

            {/* 5. Sizing Mode */}
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-1.5">
              <label className="text-[10px] uppercase text-slate-400 font-bold block">
                Contract Sizing Mode
              </label>
              <div className="flex gap-1">
                <button
                  disabled={isCrypto}
                  onClick={() => handleTradeModeChange('FO')}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                    tradeMode === 'FO' && !isCrypto
                      ? 'bg-cyan-500 text-slate-950 shadow-sm'
                      : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  F&O Lots ({lotSize})
                </button>
                <button
                  onClick={() => handleTradeModeChange('CASH')}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                    tradeMode === 'CASH' || isCrypto
                      ? 'bg-cyan-500 text-slate-950 shadow-sm'
                      : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  Cash / Units
                </button>
              </div>
            </div>

            {/* 6. Persistent Margin Leverage Selector */}
            <div className="bg-slate-900/90 border border-cyan-500/30 p-3 rounded-xl space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase text-cyan-400 font-bold flex items-center gap-1">
                  <Zap className="w-3 h-3 text-cyan-400" />
                  Margin Leverage (Saved)
                </label>
                <span className="text-xs font-black text-white bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                  {leverage}x
                </span>
              </div>
              <div className="flex gap-1">
                {leveragePresets.map((lev) => (
                  <button
                    key={lev}
                    onClick={() => handleLeverageChange(lev)}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                      leverage === lev
                        ? 'bg-cyan-500 text-slate-950 shadow-sm'
                        : 'bg-slate-950 border border-slate-700 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {lev}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Execution Output Cards (5 Cols) */}
        <div className="lg:col-span-5 flex flex-col justify-between space-y-3">
          {/* Main Sizing Highlight */}
          <div className="bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-950 border border-emerald-500/50 rounded-xl p-4 shadow-xl space-y-2">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] text-emerald-400 uppercase font-bold tracking-wider block">
                  AUTHORIZED POSITION SIZING
                </span>
                <div className="text-2xl sm:text-3xl font-black text-white mt-0.5">
                  {isCrypto ? `${finalUnits.toFixed(4)} BTC` : `${finalUnits.toLocaleString()} Qty`}
                </div>
              </div>
              <span className="text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2.5 py-1 rounded-lg">
                {tradeMode === 'FO' && !isCrypto ? `${lotsCount} Lot(s)` : 'Direct Sizing'}
              </span>
            </div>

            <div className="pt-2 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[10px] text-slate-400 block">Actual Risk at SL</span>
                <span className="font-bold text-rose-400">
                  -{currencySymbol}
                  {actualMaxRisk.toFixed(2)} ({actualRiskPercent.toFixed(2)}%)
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block">Risk:Reward Ratio</span>
                <span className="font-bold text-emerald-400">1:{rewardToRiskRatio} R:R</span>
              </div>
            </div>
          </div>

          {/* Target 1 & Target 2 Projections */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
              <span className="text-[10px] text-cyan-400 font-bold block uppercase flex items-center gap-1">
                <Target className="w-3 h-3" /> Target 1 (1.5R)
              </span>
              <span className="text-sm font-black text-cyan-300 mt-1 block">
                +{currencySymbol}
                {expectedProfitTP1.toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-500 block mt-0.5">
                +{((expectedProfitTP1 / accountBalance) * 100).toFixed(1)}% ROI
              </span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
              <span className="text-[10px] text-emerald-400 font-bold block uppercase flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> Target 2 (2.5R)
              </span>
              <span className="text-sm font-black text-emerald-300 mt-1 block">
                +{currencySymbol}
                {expectedProfitTP2.toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-500 block mt-0.5">
                +{((expectedProfitTP2 / accountBalance) * 100).toFixed(1)}% ROI
              </span>
            </div>
          </div>

          {/* Margin & Capital Cushion */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-xs space-y-1.5">
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-slate-400">Required Margin (@ {leverage}x):</span>
              <span
                className={`font-black ${isMarginWarning ? 'text-rose-400' : 'text-slate-200'}`}
              >
                {currencySymbol}
                {marginRequired.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-slate-400">Position Notional Value:</span>
              <span className="font-bold text-white">
                {currencySymbol}
                {totalPositionValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>

            {/* Visual Margin Bar */}
            <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden flex mt-2">
              <div
                className={`h-full transition-all ${
                  isMarginWarning
                    ? 'bg-rose-500'
                    : marginUsagePercent > 70
                      ? 'bg-amber-500'
                      : 'bg-cyan-500'
                }`}
                style={{ width: `${Math.min(100, marginUsagePercent)}%` }}
              />
            </div>
            <div className="flex justify-between text-[9px] text-slate-500">
              <span>{marginUsagePercent.toFixed(1)}% Margin Used</span>
              <span>
                Free Buffer: {currencySymbol}
                {freeMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Prop Firm / Institutional Rule Validation Matrix */}
      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="flex items-center gap-2">
          {actualRiskPercent <= 2.0 ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          <div>
            <span className="text-[10px] text-slate-400 block">Risk Per Trade</span>
            <span
              className={`font-bold ${actualRiskPercent <= 2.0 ? 'text-emerald-400' : 'text-rose-400'}`}
            >
              {actualRiskPercent <= 2.0 ? 'PASSED (<= 2%)' : 'VIOLATION (> 2%)'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {rewardToRiskRatio >= 1.5 ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <div>
            <span className="text-[10px] text-slate-400 block">Reward to Risk</span>
            <span
              className={`font-bold ${rewardToRiskRatio >= 1.5 ? 'text-emerald-400' : 'text-amber-400'}`}
            >
              {rewardToRiskRatio >= 1.5 ? 'EXCELLENT (>= 1.5R)' : 'SUB-OPTIMAL (< 1.5R)'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isMarginWarning ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          <div>
            <span className="text-[10px] text-slate-400 block">Margin Adequacy</span>
            <span
              className={`font-bold ${!isMarginWarning ? 'text-emerald-400' : 'text-rose-400'}`}
            >
              {!isMarginWarning ? 'ADEQUATE' : 'MARGIN SHORTFALL'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
          <div>
            <span className="text-[10px] text-slate-400 block">Leverage Profile</span>
            <span className="font-bold text-cyan-300">SAVED ({leverage}x ACTIVE)</span>
          </div>
        </div>
      </div>
    </div>
  );
};
