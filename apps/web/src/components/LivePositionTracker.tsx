'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Shield,
  Target,
  Zap,
  CheckCircle2,
  XCircle,
  Clock,
  Layers,
  ArrowRight,
  ShieldCheck,
  Award,
  AlertTriangle,
  ShieldAlert,
  Calendar,
  Timer,
  Moon,
  Sun,
  Flame,
  Radio,
  Sliders,
  Bot,
} from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface LivePositionTrackerProps {
  symbol: string;
  signal: ISignalSetup | null;
  livePrice: number;
  activePosition?: RunningPaperPosition | any | null;
  onClosePosition?: ((positionId: string) => void) | ((exitPrice: number, pnl: number, r: number, reason: string) => void) | any;
}

interface RunningPaperPosition {
  id?: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity?: number;
  entryPrice?: number;
  entryTime?: string;
  averageEntryPrice?: number;
  openedAt?: string;
  usedMargin?: number;
  unrealizedPnL?: number;
  unrealizedR?: number;
  fxRateUsed?: number;
  status?: string;
}

const formatDateTimeIST = (date: Date | null | undefined) => {
  if (!date || isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-IN', {
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

/**
 * Calculates authentic market-session-aware timestamps strictly respecting NSE Market Hours (09:15 AM - 03:30 PM IST)
 */
function getMarketAwareTimestamps(symbol: string, signalTimestamp?: Date | string | number | null) {
  const isCrypto = symbol === 'BTCUSDT' || symbol.toUpperCase().includes('BTC');
  const isGold = symbol === 'XAUUSD' || symbol === 'GOLD';
  const now = new Date();

  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHours = istNow.getUTCHours();
  const istMinutes = istNow.getUTCMinutes();
  const istDay = istNow.getUTCDay();

  const isWeekday = istDay >= 1 && istDay <= 5;
  const currentMinInDay = istHours * 60 + istMinutes;
  const marketOpenMin = 9 * 60 + 15;
  const marketCloseMin = 15 * 60 + 30;

  const isNSE = !isCrypto && !isGold;
  const isMarketOpen =
    isCrypto ||
    isGold ||
    (isWeekday && currentMinInDay >= marketOpenMin && currentMinInDay <= marketCloseMin);

  const entryDate = signalTimestamp ? new Date(signalTimestamp) : null;
  const estCloseDate = entryDate ? new Date(entryDate.getTime() + 45 * 60000) : null;

  return {
    entryDate,
    estCloseDate,
    isMarketOpen,
    marketSessionLabel: isCrypto
      ? '24/7 LIVE CRYPTO SESSION'
      : isGold
        ? '23/5 LIVE GOLD COMMODITY (COMEX / LONDON FIX)'
        : isMarketOpen
          ? 'LIVE NSE SESSION (09:15 - 15:30 IST)'
          : 'NSE MARKET CLOSED (Session: 09:15 - 15:30 IST)',
    isNSE,
  };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const LivePositionTracker: React.FC<LivePositionTrackerProps> = ({
  symbol,
  signal,
  livePrice,
  activePosition,
  onClosePosition,
}) => {
  const isCrypto =
    symbol === 'BTCUSDT' ||
    symbol.toUpperCase().includes('BTC') ||
    symbol.toUpperCase().includes('ETH');
  const isGold = symbol === 'XAUUSD' || symbol === 'GOLD' || symbol.toUpperCase().includes('XAU');
  const nativeCurrency = isCrypto || isGold ? '$' : '₹';
  const currencySymbol = '₹';

  const isOptionsAsset = symbol === 'NIFTY' || symbol === 'BANKNIFTY';
  const [isOptionMode, setIsOptionMode] = useState<boolean>(isOptionsAsset);

  useEffect(() => {
    setIsOptionMode(symbol === 'NIFTY' || symbol === 'BANKNIFTY');
  }, [symbol]);

  const [optionData, setOptionData] = useState<any>(null);
  const [bot, setBot] = useState<any>(null);
  const [isTogglingBot, setIsTogglingBot] = useState<boolean>(false);

  const [paperPosition, setPaperPosition] = useState<RunningPaperPosition | null>(
    activePosition || null,
  );

  useEffect(() => {
    if (activePosition !== undefined) {
      setPaperPosition(activePosition || null);
    }
  }, [activePosition]);

  const fetchBot = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/algo-bots`);
      if (!res.ok) return;
      const bots = await res.json();
      const norm = symbol.toUpperCase().replace(/_SPOT$/, '');
      const match = bots.find(
        (b: any) =>
          b.symbol === symbol ||
          b.symbol === `${symbol}_SPOT` ||
          b.symbol.toUpperCase().replace(/_SPOT$/, '') === norm ||
          ((symbol === 'GOLD' || symbol === 'XAUUSD') && (b.symbol === 'XAUUSD' || b.symbol === 'GOLD')),
      );
      setBot(match || null);
    } catch {}
  }, [symbol]);

  useEffect(() => {
    fetchBot();
  }, [fetchBot]);

  const handleToggleBot = async () => {
    if (!bot || isTogglingBot) return;
    setIsTogglingBot(true);
    try {
      const res = await fetch(`${API_BASE}/api/algo-bots/${bot.id}/toggle`, {
        method: 'POST',
      });
      if (res.ok) {
        const updated = await res.json();
        setBot(updated);
        setManualCloseToast(
          updated.isActive
            ? `🤖 Bot '${updated.name}' ACTIVATED (Auto-Execute: ${updated.autoExecutePaper ? 'ON' : 'OFF'})`
            : `⏸️ Bot '${updated.name}' DEACTIVATED`,
        );
        setTimeout(() => setManualCloseToast(null), 5000);
      }
    } catch (err: any) {
      setManualCloseToast(`Failed to toggle bot: ${err.message}`);
      setTimeout(() => setManualCloseToast(null), 5000);
    } finally {
      setIsTogglingBot(false);
    }
  };

  const direction = signal?.direction || 'BULLISH';
  const rawPosDir = (paperPosition as any)?.direction;
  const effectiveDirection = paperPosition
    ? (rawPosDir === 'BUY' || rawPosDir === 'BULLISH' || rawPosDir === 'LONG'
        ? 'BULLISH'
        : 'BEARISH')
    : direction;
  const isBull = effectiveDirection === 'BULLISH';
  const hasActiveTrade = Boolean(paperPosition);
  const [isPlacingOrder, setIsPlacingOrder] = useState<boolean>(false);
  const positionLockKey = `${symbol}_${effectiveDirection}`;
  const executionEntryTimeStorageKey = `quant_running_entry_time_${positionLockKey}`;

  const fetchPaperPosition = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/paper-trading/portfolio`);
      if (!res.ok) return;
      const data = await res.json();
      const positions = Array.isArray(data?.openPositions) ? data.openPositions : [];
      const normSym = symbol.toUpperCase().replace(/_SPOT$/, '');
      const matchingPositions = positions.filter(
        (p: any) =>
          (p.symbol === symbol ||
            p.symbol === `${symbol}_SPOT` ||
            p.symbol?.toUpperCase().replace(/_SPOT$/, '') === normSym ||
            ((symbol === 'GOLD' || symbol === 'XAUUSD') &&
              (p.symbol === 'XAUUSD' || p.symbol === 'GOLD')) ||
            p.contractSymbol?.startsWith(symbol)) &&
          (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED' || !p.status),
      );
      const found =
        (activePosition?.id && matchingPositions.find((p: any) => p.id === activePosition.id)) ||
        matchingPositions[0] ||
        null;

      setPaperPosition(found || activePosition || null);
    } catch {}
  }, [symbol, activePosition]);

  useEffect(() => {
    fetchPaperPosition();
    const interval = setInterval(fetchPaperPosition, 1500);
    return () => {
      clearInterval(interval);
    };
  }, [fetchPaperPosition]);

  const { entryDate, estCloseDate, isMarketOpen, marketSessionLabel, isNSE } = useMemo(() => {
    const authoritativeEntryTime = paperPosition?.entryTime || paperPosition?.openedAt;
    return getMarketAwareTimestamps(symbol, authoritativeEntryTime);
  }, [symbol, paperPosition?.entryTime, paperPosition?.openedAt]);

  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  useEffect(() => {
    if (!entryDate) {
      setElapsedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      const diffSec = Math.max(0, Math.floor((Date.now() - entryDate.getTime()) / 1000));
      setElapsedSeconds(diffSec);
    }, 1000);
    return () => clearInterval(timer);
  }, [entryDate]);

  const formattedElapsed = useMemo(() => {
    if (!entryDate) return 'NO ACTIVE POSITION';
    const hrs = Math.floor(elapsedSeconds / 3600);
    const mins = Math.floor((elapsedSeconds % 3600) / 60);
    const secs = elapsedSeconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }, [entryDate, elapsedSeconds]);

  // Position Configuration with LocalStorage Persistence
  const [isBreakevenActive, setIsBreakevenActive] = useState(false);
  const [isTrailingSLActive, setIsTrailingSLActive] = useState(false);
  const [isAutoScaledOut, setIsAutoScaledOut] = useState(false);
  const [scaledOutPnL, setScaledOutPnL] = useState(0);
  const [manualCloseToast, setManualCloseToast] = useState<string | null>(null);
  // Sanity check: ensure spot price matches instrument magnitude (prevents NIFTY price in BTC)
  const isSaneSpot = React.useCallback((sym: string, price: number) => {
    if (!price || price <= 0 || isNaN(price)) return false;
    if (sym === 'BTCUSDT' || sym.toUpperCase().includes('BTC')) return price >= 50000;
    if (sym === 'XAUUSD' || sym === 'GOLD' || sym.toUpperCase().includes('XAU'))
      return price >= 3500 && price <= 8000;
    if (sym === 'NIFTY') return price >= 15000 && price <= 35000;
    if (sym === 'BANKNIFTY') return price >= 35000 && price <= 75000;
    if (sym === 'RELIANCE') return price >= 500 && price <= 5000;
    if (sym === 'HDFCBANK') return price >= 300 && price <= 2000;
    if (sym === 'INFY') return price >= 500 && price <= 3000;
    return true;
  }, []);

  const isSaneOptionPremium = React.useCallback((sym: string, price: number) => {
    return (
      (sym === 'NIFTY' || sym === 'BANKNIFTY') &&
      Number.isFinite(price) &&
      price > 0 &&
      price < 5000
    );
  }, []);

  const isSanePersistedExit = React.useCallback(
    (sym: string, price: number) => {
      return isSaneSpot(sym, price) || isSaneOptionPremium(sym, price);
    },
    [isSaneSpot, isSaneOptionPremium],
  );

  // Signal IDs can change when scans refresh. Keep running-trade state keyed to the actual position.
  const cutStorageKey = `quant_pos_cut_${positionLockKey}`;
  const symbolCutKey = `quant_pos_cut_${symbol}`;
  const cutSummaryStorageKey = `quant_pos_cut_summary_${positionLockKey}`;
  const scaleoutStorageKey = `quant_pos_scaleout_${positionLockKey}`;
  const scaleoutPnlStorageKey = `quant_pos_scaleout_pnl_${positionLockKey}`;

  const [isPositionCut, setIsPositionCut] = useState<boolean>(false);
  const [closedTradeSummary, setClosedTradeSummary] = useState<{
    exitPrice: number;
    pnl: number;
    r: number;
    reason: string;
  } | null>(null);

  // Client-side hydration sync & cross-window/tab event synchronization
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (paperPosition) {
        setIsPositionCut(false);
      } else {
        const isCut =
          localStorage.getItem(cutStorageKey) === 'true' ||
          localStorage.getItem(symbolCutKey) === 'true' ||
          Boolean(
            signal &&
            (signal.state === 'TP2_HIT' || signal.state === 'TP3_HIT' || signal.state === 'SL_HIT'),
          );
        setIsPositionCut(isCut);
      }

      const summaryStr = localStorage.getItem(cutSummaryStorageKey);
      if (summaryStr) {
        try {
          setClosedTradeSummary(JSON.parse(summaryStr));
        } catch {}
      }

      const isScaled = localStorage.getItem(scaleoutStorageKey) === 'true';
      setIsAutoScaledOut(isScaled);
      const savedPnl = localStorage.getItem(scaleoutPnlStorageKey);
      if (savedPnl) setScaledOutPnL(Number(savedPnl));
    }
  }, [
    symbol,
    paperPosition,
    positionLockKey,
    cutStorageKey,
    symbolCutKey,
    cutSummaryStorageKey,
    scaleoutStorageKey,
    scaleoutPnlStorageKey,
    signal?.state,
  ]);

  // Listen for global custom events when positions are closed/opened anywhere in the platform
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleTradeClosedEvent = (e: any) => {
      const targetSym = e?.detail?.symbol;
      if (!targetSym || targetSym === 'ALL' || targetSym === symbol) {
        setIsPositionCut(true);
        localStorage.setItem(cutStorageKey, 'true');
        localStorage.setItem(symbolCutKey, 'true');
      }
    };

    const handleTradeOpenedEvent = (e: any) => {
      const targetSym = e?.detail?.symbol;
      if (!targetSym || targetSym === 'ALL' || targetSym === symbol) {
        setIsPositionCut(false);
        localStorage.removeItem(cutStorageKey);
        localStorage.removeItem(symbolCutKey);
        localStorage.removeItem(cutSummaryStorageKey);
      }
    };

    window.addEventListener('quant_trade_closed', handleTradeClosedEvent);
    window.addEventListener('quant_trade_opened', handleTradeOpenedEvent);

    return () => {
      window.removeEventListener('quant_trade_closed', handleTradeClosedEvent);
      window.removeEventListener('quant_trade_opened', handleTradeOpenedEvent);
    };
  }, [symbol, cutStorageKey, symbolCutKey, cutSummaryStorageKey]);

  // Position Parameters from Signal
  const rawSignalOptimal = Number(signal?.entryZone?.optimal);
  const rawLivePrice = Number(livePrice);
  const setupKey = signal?.id
    ? `${symbol}_${direction}_${signal.id}`
    : `${symbol}_${direction}_${signal?.timestamp ? new Date(signal.timestamp).getTime() : 'curr'}`;
  const spotStorageKey = `quant_locked_spot_entry_${setupKey}`;
  const strikeStorageKey = `quant_locked_strike_${setupKey}`;

  // Initial spot entry should strictly match paper position entry (if open) or signal's optimal entry price
  const paperEntryPrice = paperPosition ? Number(paperPosition.entryPrice) : null;
  const initialSpotCandidate =
    paperEntryPrice && isSaneSpot(symbol, paperEntryPrice)
      ? paperEntryPrice
      : isSaneSpot(symbol, rawSignalOptimal)
        ? rawSignalOptimal
        : isSaneSpot(symbol, rawLivePrice)
          ? rawLivePrice
          : symbol === 'BTCUSDT' || symbol.toUpperCase().includes('BTC')
            ? 78200
            : symbol === 'XAUUSD' || symbol === 'GOLD'
              ? 4360.0
              : symbol === 'BANKNIFTY'
                ? 57400
                : 24060;

  const [lockedSpotEntry, setLockedSpotEntry] = useState<number>(initialSpotCandidate);

  const lockedSpotRef = React.useRef<number>(lockedSpotEntry);

  const spotEntryPrice =
    paperEntryPrice && isSaneSpot(symbol, paperEntryPrice)
      ? paperEntryPrice
      : lockedSpotRef.current > 0 && isSaneSpot(symbol, lockedSpotRef.current)
        ? lockedSpotRef.current
        : lockedSpotEntry > 0 && isSaneSpot(symbol, lockedSpotEntry)
          ? lockedSpotEntry
          : initialSpotCandidate;

  const currentCMP = livePrice && isSaneSpot(symbol, livePrice) ? livePrice : spotEntryPrice;

  // Compute and Freeze Active Strike Price so it NEVER automatically switches mid-trade
  const defaultStrike = useMemo(() => {
    if (symbol === 'NIFTY') return Math.round(spotEntryPrice / 50) * 50;
    if (symbol === 'BANKNIFTY') return Math.round(spotEntryPrice / 100) * 100;
    return Math.round(spotEntryPrice);
  }, [symbol, spotEntryPrice]);

  const [lockedStrike, setLockedStrike] = useState<number>(defaultStrike);

  const activeStrike = lockedStrike || defaultStrike;
  const strikeKey = String(activeStrike);
  const lockStorageKey = `quant_locked_opt_entry_${setupKey}_${strikeKey}`;

  // Lock Initial Entry Prices so they NEVER change during a running trade
  const [lockedEntryPremium, setLockedEntryPremium] = useState<number>(0);

  const lockedEntryRef = React.useRef<number>(lockedEntryPremium);
  useEffect(() => {
    lockedEntryRef.current = lockedEntryPremium;
  }, [lockedEntryPremium]);

  // Re-sync ONLY on setup change or symbol change, NEVER on live price ticks!
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedSpot = localStorage.getItem(spotStorageKey);
      let validSpot = 0;
      if (savedSpot) {
        const p = Number(savedSpot);
        if (isSaneSpot(symbol, p)) validSpot = p;
      }

      // Clean up corrupted or outdated static Gold entry price (< 3500)
      if (isGold && (validSpot < 3500 || validSpot > 8000)) {
        validSpot = initialSpotCandidate;
        localStorage.removeItem(spotStorageKey);
      }

      if (!validSpot || validSpot === 0) {
        validSpot = initialSpotCandidate;
        localStorage.setItem(spotStorageKey, String(validSpot));
      }

      lockedSpotRef.current = validSpot;
      setLockedSpotEntry(validSpot);

      const savedStrike = localStorage.getItem(strikeStorageKey);
      const validStrike =
        savedStrike && Number(savedStrike) > 0 ? Number(savedStrike) : defaultStrike;
      setLockedStrike(validStrike);
      if (validStrike > 0) {
        localStorage.setItem(strikeStorageKey, String(validStrike));
      }

      const savedOpt = localStorage.getItem(lockStorageKey);
      let initialOpt = savedOpt ? Number(savedOpt) : 0;
      // Sanity check: If NIFTY entry premium is corrupted with inflated ITM value (> 350) from previous bug
      if (symbol === 'NIFTY' && initialOpt > 350) {
        initialOpt = 0;
        localStorage.removeItem(lockStorageKey);
      }
      setLockedEntryPremium(initialOpt);
      lockedEntryRef.current = initialOpt;
    }
  }, [
    symbol,
    signal?.id,
    setupKey,
    spotStorageKey,
    strikeStorageKey,
    lockStorageKey,
    isSaneSpot,
    defaultStrike,
    initialSpotCandidate,
    isGold,
  ]);

  // Fetch Live Option Smart Strike Data & Locked Entry Premium
  useEffect(() => {
    if (!isOptionsAsset) return;
    let isMounted = true;

    const fetchOptionData = async () => {
      try {
        // 1. Fetch live market option data at current CMP
        const resLive = await fetch(
          `${API_BASE}/api/options/smart-strike?symbol=${symbol}&direction=${direction}&spotPrice=${currentCMP}&strike=${activeStrike}`,
        );
        const dataLive = await resLive.json();
        if (isMounted && dataLive && dataLive.contractName) {
          setOptionData(dataLive);
        }

        // 2. Lock initial entry premium calculated strictly at spotEntryPrice if not already locked
        if (!lockedEntryRef.current || lockedEntryRef.current === 0) {
          const resEntry = await fetch(
            `${API_BASE}/api/options/smart-strike?symbol=${symbol}&direction=${direction}&spotPrice=${spotEntryPrice}&strike=${activeStrike}`,
          );
          const dataEntry = await resEntry.json();
          if (isMounted && dataEntry && dataEntry.optionLtp > 0) {
            lockedEntryRef.current = dataEntry.optionLtp;
            setLockedEntryPremium(dataEntry.optionLtp);
            if (typeof window !== 'undefined') {
              localStorage.setItem(lockStorageKey, String(dataEntry.optionLtp));
            }
          }
        }
      } catch (err) {}
    };

    fetchOptionData();
    const interval = setInterval(fetchOptionData, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [symbol, direction, currentCMP, spotEntryPrice, activeStrike, isOptionsAsset, lockStorageKey]);

  // Base Standard Sizing: 65 Qty (1 Lot) for NIFTY, 15 Qty (1 Lot) for BANKNIFTY, 0.01 for BTC, 1 for Gold/Equities
  const lotSize =
    symbol === 'NIFTY'
      ? 65
      : symbol === 'BANKNIFTY'
        ? 15
        : isCrypto
          ? 0.01
          : 1;
  const activeQty = paperPosition
    ? Number(paperPosition.quantity)
    : isAutoScaledOut
      ? lotSize * 0.5
      : lotSize;
  const numericQty = activeQty;
  const totalQuantity = isCrypto ? activeQty.toFixed(4) : isGold ? `${activeQty}` : activeQty.toLocaleString();

  // Fixed Initial Entry Premium (LOCKED & IMMUTABLE) vs Live Current Option Premium (TICKING)
  const optionEntryPremium =
    lockedEntryRef.current > 0
      ? lockedEntryRef.current
      : lockedEntryPremium > 0
        ? lockedEntryPremium
        : optionData?.optionLtp || 45.35;

  const liveOptionPremium = optionData?.optionLtp || optionEntryPremium;

  // Max 20 to 30 points Stop Loss in NIFTY Option Premium
  const maxOptionRiskPts = symbol === 'NIFTY' ? 25.0 : symbol === 'BANKNIFTY' ? 60.0 : 25.0;
  const rawOptionRiskPts =
    optionEntryPremium > 40
      ? Math.min(maxOptionRiskPts, Math.max(18.0, optionEntryPremium * 0.35))
      : Math.min(20.0, Math.max(10.0, optionEntryPremium * 0.4));
  const optionStopLoss = Number(Math.max(1.0, optionEntryPremium - rawOptionRiskPts).toFixed(2));
  const optionRiskDistance = Math.abs(optionEntryPremium - optionStopLoss);

  const optionTP1 = Number((optionEntryPremium + optionRiskDistance * 1.5).toFixed(2)); // 1.5R (e.g. +37.5 pts)
  const optionTP2 = Number((optionEntryPremium + optionRiskDistance * 2.5).toFixed(2)); // 2.5R (e.g. +62.5 pts)
  const optionTP3 = Number((optionEntryPremium + optionRiskDistance * 4.0).toFixed(2)); // 4.0R (e.g. +100.0 pts)
  // Active Effective Parameters (Option Mode vs Spot Mode)
  const effectiveEntryPrice = isOptionMode && !isCrypto && !isGold ? optionEntryPremium : spotEntryPrice;
  const effectiveCurrentPrice = isOptionMode && !isCrypto && !isGold ? liveOptionPremium : currentCMP;

  // Strict Directional Stop Loss Geometry Validator (Bearish SL strictly > Entry, Bullish SL strictly < Entry)
  const safeInitialSL = React.useMemo(() => {
    const rawSL = Number(signal?.stopLoss);
    if (isOptionMode && !isCrypto && !isGold) return optionStopLoss;

    // Tight sniper SL defaults: BTC max 180 pts, Gold 15 pts, NIFTY max 20 pts, BANKNIFTY max 55 pts
    const defaultRisk = isCrypto
      ? 160.0
      : isGold
        ? 15.0
        : symbol === 'NIFTY'
          ? 20.0
          : symbol === 'BANKNIFTY'
            ? 55.0
            : spotEntryPrice * 0.004;

    const minAllowedDist = isGold ? 10.0 : isCrypto ? 80.0 : 5.0;

    if (isBull) {
      if (rawSL > 0 && rawSL < spotEntryPrice) {
        const dist = spotEntryPrice - rawSL;
        // Clamp excessive SL on BTC only if extreme (> 500 pts)
        if (isCrypto && dist > 500) return Number((spotEntryPrice - 300.0).toFixed(2));
        // Clamp micro-SL on Gold if < 10.0 pts
        if (isGold && dist < minAllowedDist) return Number((spotEntryPrice - defaultRisk).toFixed(2));
        return rawSL;
      }
      return Number((spotEntryPrice - defaultRisk).toFixed(2));
    } else {
      if (rawSL > 0 && rawSL > spotEntryPrice) {
        const dist = rawSL - spotEntryPrice;
        if (isCrypto && dist > 500) return Number((spotEntryPrice + 300.0).toFixed(2));
        if (isGold && dist < minAllowedDist) return Number((spotEntryPrice + defaultRisk).toFixed(2));
        return rawSL;
      }
      return Number((spotEntryPrice + defaultRisk).toFixed(2));
    }
  }, [signal?.stopLoss, isOptionMode, isCrypto, isGold, optionStopLoss, isBull, spotEntryPrice, symbol]);

  const originalSL = safeInitialSL;
  const riskPerUnit = Math.abs(effectiveEntryPrice - originalSL);

  // Dynamic Trailing Stop Loss Calculation
  const trailingSL = React.useMemo(() => {
    if (!isTrailingSLActive || riskPerUnit <= 0) return originalSL;
    if (isOptionMode && !isCrypto && !isGold) {
      return Number(Math.max(originalSL, effectiveCurrentPrice - riskPerUnit * 0.6).toFixed(2));
    }
    if (isBull) {
      const candidateSL = effectiveCurrentPrice - riskPerUnit * 0.9;
      return Math.max(originalSL, candidateSL);
    } else {
      const candidateSL = effectiveCurrentPrice + riskPerUnit * 0.9;
      return Math.min(originalSL, candidateSL);
    }
  }, [
    isTrailingSLActive,
    riskPerUnit,
    originalSL,
    effectiveCurrentPrice,
    isBull,
    isOptionMode,
    isCrypto,
    isGold,
  ]);

  const currentSL = isTrailingSLActive
    ? trailingSL
    : isBreakevenActive || isAutoScaledOut
      ? effectiveEntryPrice
      : originalSL;

  const isProfitLocked =
    isOptionMode && !isCrypto && !isGold
      ? currentSL > effectiveEntryPrice
      : isBull
        ? currentSL > effectiveEntryPrice
        : currentSL < effectiveEntryPrice;

  // FX rates from backend running position (Gold: USD/INR 87.5, BTC: USDT/INR 92.5)
  const cryptoFxRate = (paperPosition as any)?.fxRateUsed ?? (isGold ? 87.5 : isCrypto ? 92.5 : 1.0);

  // Read leverage from localStorage or default (1x for BTC spot & Indian indices, 5x for Gold CFD)
  const defaultLeverage = isGold ? 5 : 1;
  const [activeLeverage, setActiveLeverage] = React.useState<number>(defaultLeverage);
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('quant_risk_leverage');
      if (saved && !isNaN(Number(saved)) && Number(saved) > 1 && !isCrypto) {
        setActiveLeverage(Number(saved));
      } else {
        setActiveLeverage(defaultLeverage);
      }
    }
  }, [defaultLeverage, isCrypto]);

  const effectiveLeverage = isCrypto
    ? 1
    : ((paperPosition as any)?.leverage ? Number((paperPosition as any).leverage) : (activeLeverage > 1 ? activeLeverage : defaultLeverage));

  const rawLockedProfit = isProfitLocked
    ? Math.abs(effectiveEntryPrice - currentSL) * numericQty
    : 0;
  const lockedProfitAmount = Number(
    (isCrypto || isGold ? rawLockedProfit * cryptoFxRate : rawLockedProfit).toFixed(2),
  );

  const rawMaxRisk = numericQty * Math.abs(effectiveEntryPrice - originalSL);
  const maxRiskAmount = Number(
    (isCrypto || isGold ? rawMaxRisk * cryptoFxRate : rawMaxRisk).toFixed(2),
  );

  // Display price helper: preserves native instrument quote currency for display
  const dp = React.useCallback((price: number) => price, []);

  // Guaranteed Directional Take Profit Roadmap (Strictly < Entry for BEARISH, > Entry for BULLISH)
  const minTargetDist = isGold ? 12.0 : isCrypto ? 120.0 : 15.0;
  const targetRisk = Math.max(minTargetDist, riskPerUnit);

  const rawTP1 = Number(signal?.takeProfits?.tp1);
  const rawTP2 = Number(signal?.takeProfits?.tp2);
  const rawTP3 = Number(signal?.takeProfits?.tp3);

  const validTP1 = isBull
    ? rawTP1 > spotEntryPrice && (rawTP1 - spotEntryPrice) >= minTargetDist * 0.8
      ? rawTP1
      : Number((spotEntryPrice + targetRisk * 1.5).toFixed(2))
    : rawTP1 < spotEntryPrice && rawTP1 > 0 && (spotEntryPrice - rawTP1) >= minTargetDist * 0.8
      ? rawTP1
      : Number((spotEntryPrice - targetRisk * 1.5).toFixed(2));

  const validTP2 = isBull
    ? rawTP2 > spotEntryPrice && (rawTP2 - spotEntryPrice) >= minTargetDist * 1.5
      ? rawTP2
      : Number((spotEntryPrice + targetRisk * 2.5).toFixed(2))
    : rawTP2 < spotEntryPrice && rawTP2 > 0 && (spotEntryPrice - rawTP2) >= minTargetDist * 1.5
      ? rawTP2
      : Number((spotEntryPrice - targetRisk * 2.5).toFixed(2));

  const validTP3 = isBull
    ? rawTP3 > spotEntryPrice && (rawTP3 - spotEntryPrice) >= minTargetDist * 2.5
      ? rawTP3
      : Number((spotEntryPrice + targetRisk * 4.0).toFixed(2))
    : rawTP3 < spotEntryPrice && rawTP3 > 0 && (spotEntryPrice - rawTP3) >= minTargetDist * 2.5
      ? rawTP3
      : Number((spotEntryPrice - targetRisk * 4.0).toFixed(2));

  const tp1 = isOptionMode && !isCrypto && !isGold ? optionTP1 : validTP1;
  const tp2 = isOptionMode && !isCrypto && !isGold ? optionTP2 : validTP2;
  const tp3 = isOptionMode && !isCrypto && !isGold ? optionTP3 : validTP3;

  // Option buyers always gain when current premium > entry premium (effectiveCurrentPrice - effectiveEntryPrice)
  const priceDifference =
    isOptionMode && !isCrypto && !isGold
      ? effectiveCurrentPrice - effectiveEntryPrice
      : isBull
        ? effectiveCurrentPrice - effectiveEntryPrice
        : effectiveEntryPrice - effectiveCurrentPrice;

  // Margin used: consume backend authoritative usedMargin or calculate fallback (SPOT = 100% notional)
  const fallbackMargin =
    isOptionMode && !isCrypto && !isGold
      ? Number((effectiveEntryPrice * numericQty).toFixed(2))
      : isCrypto
        ? Number((effectiveEntryPrice * numericQty * cryptoFxRate).toFixed(2))
        : Number(
            (
              (effectiveEntryPrice * numericQty * (isGold ? cryptoFxRate : 1)) /
              (effectiveLeverage || 1)
            ).toFixed(2),
          );

  const totalMarginUsed =
    (paperPosition as any)?.usedMargin !== undefined
      ? Number((paperPosition as any).usedMargin)
      : fallbackMargin;

  // Presentation-only Running P&L: consume backend authoritative accounting breakdown or fallback
  const acct = (paperPosition as any)?.accounting;
  const canonicalPriceMove = acct?.priceMove !== undefined
    ? Number(acct.priceMove)
    : Number(priceDifference.toFixed(2));
  const fallbackPnL = Number(
    (priceDifference * numericQty * (isCrypto || isGold ? cryptoFxRate : 1)).toFixed(2),
  );
  const canonicalGrossPnlAccount = acct?.grossPnlAccount !== undefined
    ? Number(acct.grossPnlAccount)
    : fallbackPnL;
  const canonicalGrossPnlQuote = acct?.grossPnlQuote !== undefined
    ? Number(acct.grossPnlQuote)
    : Number((priceDifference * numericQty).toFixed(4));
  const canonicalFees = acct?.fees !== undefined
    ? Number(acct.fees)
    : ((paperPosition as any)?.charges?.totalCharges !== undefined
        ? Number((paperPosition as any).charges.totalCharges)
        : 0);

  const runningPnL =
    acct?.netPnlAccount !== undefined
      ? Number(acct.netPnlAccount)
      : (paperPosition as any)?.unrealizedPnL !== undefined
        ? Number((paperPosition as any).unrealizedPnL)
        : fallbackPnL;

  const runningRMultiple =
    (paperPosition as any)?.unrealizedR !== undefined
      ? Number((paperPosition as any).unrealizedR)
      : riskPerUnit > 0
        ? Number((priceDifference / riskPerUnit).toFixed(2))
        : 0;
  const returnPercentage =
    totalMarginUsed > 0
      ? Number(((runningPnL / totalMarginUsed) * 100).toFixed(2))
      : effectiveEntryPrice > 0
        ? Number(((priceDifference / effectiveEntryPrice) * 100).toFixed(2))
        : 0;

  // Progress towards Targets
  const totalTargetDistance = Math.abs(tp2 - effectiveEntryPrice);
  const currentProgressDistance = Math.max(0, priceDifference);
  const progressPercent = hasActiveTrade
    ? Math.min(
        100,
        Math.max(
          0,
          totalTargetDistance > 0 ? (currentProgressDistance / totalTargetDistance) * 100 : 0,
        ),
      )
    : 0;

  // Authentic Spot & Option Stop Loss Evaluation (Strict directional geometric safety)
  const isSpotSLHit =
    hasActiveTrade &&
    (isBull
      ? currentSL < spotEntryPrice && currentCMP > 0 && currentCMP <= currentSL
      : currentSL > spotEntryPrice && currentCMP > 0 && currentCMP >= currentSL);
  const isOptionSLHit =
    hasActiveTrade &&
    isOptionMode &&
    !isCrypto &&
    !isGold &&
    optionData?.optionLtp > 0 &&
    optionStopLoss > 0 &&
    liveOptionPremium > 0 &&
    liveOptionPremium <= currentSL;
  const isSLReached = isOptionMode && !isCrypto && !isGold ? isOptionSLHit : isSpotSLHit;

  const spotTP3 = validTP3;
  const isSpotTP3Hit =
    hasActiveTrade &&
    (isBull
      ? spotTP3 > spotEntryPrice && currentCMP >= spotTP3
      : spotTP3 < spotEntryPrice && currentCMP <= spotTP3);
  const isOptionTP3Hit =
    hasActiveTrade &&
    isOptionMode &&
    !isCrypto &&
    !isGold &&
    optionTP3 > 0 &&
    liveOptionPremium > 0 &&
    liveOptionPremium >= tp3;
  const isTP3Reached = isOptionMode && !isCrypto && !isGold ? isOptionTP3Hit : isSpotTP3Hit;

  const spotTP2 = validTP2;
  const isSpotTP2Hit =
    hasActiveTrade &&
    (isBull
      ? spotTP2 > spotEntryPrice && currentCMP >= spotTP2
      : spotTP2 < spotEntryPrice && currentCMP <= spotTP2);
  const isOptionTP2Hit =
    hasActiveTrade &&
    isOptionMode &&
    !isCrypto &&
    !isGold &&
    optionTP2 > 0 &&
    liveOptionPremium > 0 &&
    liveOptionPremium >= tp2;
  const isTP2Reached = isOptionMode && !isCrypto && !isGold ? isOptionTP2Hit : isSpotTP2Hit;

  const spotTP1 = validTP1;
  const isSpotTP1Hit =
    hasActiveTrade &&
    (isBull
      ? spotTP1 > spotEntryPrice && currentCMP >= spotTP1
      : spotTP1 < spotEntryPrice && currentCMP <= spotTP1);
  const isOptionTP1Hit =
    hasActiveTrade &&
    isOptionMode &&
    !isCrypto &&
    !isGold &&
    optionTP1 > 0 &&
    liveOptionPremium > 0 &&
    liveOptionPremium >= tp1;
  const isTP1Reached = isOptionMode && !isCrypto && !isGold ? isOptionTP1Hit : isSpotTP1Hit;

  const autoCutExecutedRef = React.useRef<string | null>(null);

  const handleCutTrade = async (reason: string, exitP?: number, partialRatio: number = 1.0) => {
    if (!paperPosition || !(paperPosition as any).id) {
      setManualCloseToast('No active backend position to close.');
      setTimeout(() => setManualCloseToast(null), 4000);
      return;
    }

    try {
      const exitPriceVal = exitP || effectiveCurrentPrice;
      const res = await fetch(`${API_BASE}/api/paper-trading/positions/${(paperPosition as any).id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positionId: (paperPosition as any).id,
          reason,
          exitPrice: exitPriceVal,
          exitPriceOverride: exitPriceVal,
          allowPriceOverride: true,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Close position request failed');
      }

      const completedTrade = await res.json();
      const finalExitPrice = Number(completedTrade.exitPrice);
      const finalPnL = Number(completedTrade.realizedPnL || 0);
      const finalR = Number(completedTrade.realizedR || 0);

      setIsPositionCut(true);
      const summary = {
        exitPrice: finalExitPrice,
        pnl: finalPnL,
        r: finalR,
        reason: completedTrade.exitReason || reason,
        isManual: true,
        closedAt: completedTrade.closedAt || new Date().toISOString(),
      };

      setClosedTradeSummary(summary);

      if (typeof window !== 'undefined') {
        localStorage.setItem(cutStorageKey, 'true');
        localStorage.setItem(symbolCutKey, 'true');
        localStorage.setItem(cutSummaryStorageKey, JSON.stringify(summary));
        window.dispatchEvent(
          new CustomEvent('quant_trade_closed', { detail: { ...summary, symbol } }),
        );
      }

      if (onClosePosition) {
        try {
          if (typeof (paperPosition as any)?.id === 'string') {
            onClosePosition((paperPosition as any).id);
          } else {
            onClosePosition(finalExitPrice, finalPnL, finalR, reason);
          }
        } catch {}
      }

      setManualCloseToast(
        `⚡ Position Exited: ${reason} @ ${currencySymbol}${finalExitPrice.toFixed(2)} | Realized: ${
          finalPnL >= 0 ? '+' : ''
        }${currencySymbol}${finalPnL.toFixed(2)} (${finalR}R)`,
      );
      setTimeout(() => setManualCloseToast(null), 8000);
    } catch (err: any) {
      setManualCloseToast(`EXIT FAILED / EXIT PENDING: ${err.message}`);
      setTimeout(() => setManualCloseToast(null), 8000);
    }
  };

  const handleExecutePaperOrder = async () => {
    if (isPlacingOrder) return;
    setIsPlacingOrder(true);
    try {
      let payload: any;

      if (isOptionsAsset) {
        // NIFTY and BANKNIFTY Options (Options-Only Execution via OptionContractResolver)
        // Long options: always BUY (BUY CE for Bullish, BUY PE for Bearish)
        const optType = isBull ? 'CE' : 'PE';
        const contractSym =
          (optionData?.recommendedStrike === activeStrike && optionData?.contractName) ||
          `${symbol} ${activeStrike} ${optType}`;

        const execPrice =
          effectiveCurrentPrice > 0
            ? effectiveCurrentPrice
            : optionData?.optionLtp > 0
              ? optionData.optionLtp
              : 60.0;

        payload = {
          symbol,
          contractSymbol: contractSym,
          instrumentType: 'OPTION',
          executionInstrumentType: 'OPTION',
          direction: 'BUY',
          strike: activeStrike,
          optionType: optType,
          quantity: numericQty,
          orderType: 'MARKET',
          allowPriceOverride: true,
          price: execPrice,
          stopLoss: optionStopLoss,
          target1: optionTP1,
          target2: optionTP2,
          target3: optionTP3,
          leverage: 1,
          signalId: signal?.id,
        };
      } else {
        // Spot Equity / Crypto / Commodity (Long-Only)
        if (!isBull) {
          throw new Error(
            `Spot instrument '${symbol}' is long-only. Short selling spot is not permitted by exchange rules. BUY entries only.`,
          );
        }

        payload = {
          symbol,
          direction: 'BUY',
          quantity: numericQty,
          orderType: 'MARKET',
          allowPriceOverride: true,
          price: currentCMP,
          stopLoss: safeInitialSL,
          target1: tp1,
          target2: tp2,
          target3: tp3,
          leverage: effectiveLeverage,
          signalId: signal?.id,
          instrumentType: 'SPOT',
        };
      }

      const res = await fetch(`${API_BASE}/api/paper-trading/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Failed to place paper order');
      }

      setIsPositionCut(false);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(cutStorageKey);
        localStorage.removeItem(symbolCutKey);
        localStorage.removeItem(cutSummaryStorageKey);
        window.dispatchEvent(new CustomEvent('quant_trade_opened', { detail: { symbol } }));
      }

      await fetchPaperPosition();

      const execLabel = isOptionsAsset
        ? `BUY ${payload.contractSymbol} (${payload.quantity} Qty)`
        : `BUY ${payload.quantity} ${symbol}`;

      setManualCloseToast(
        `🚀 Executed Paper Position: ${execLabel} @ ${nativeCurrency}${dp(payload.price).toFixed(2)} | SL: ${nativeCurrency}${dp(payload.stopLoss).toFixed(2)}`,
      );
      setTimeout(() => setManualCloseToast(null), 6000);
    } catch (err: any) {
      setManualCloseToast(`Order Execution Failed: ${err.message}`);
      setTimeout(() => setManualCloseToast(null), 8000);
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const handleReopenTrade = () => {
    autoCutExecutedRef.current = null;
    setIsPositionCut(false);
    setIsAutoScaledOut(false);
    setScaledOutPnL(0);
    setClosedTradeSummary(null);
    lockedEntryRef.current = 0;
    setLockedEntryPremium(0);
    setLockedSpotEntry(0);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(`quant_pos_cut_${symbol}`);
      localStorage.removeItem(`quant_pos_scaleout_${symbol}`);
      localStorage.removeItem(`quant_pos_scaleout_pnl_${symbol}`);
      localStorage.removeItem(`quant_pos_cut_summary_${symbol}`);
      localStorage.removeItem(cutStorageKey);
      localStorage.removeItem(symbolCutKey);
      localStorage.removeItem(cutSummaryStorageKey);
      localStorage.removeItem(scaleoutStorageKey);
      localStorage.removeItem(scaleoutPnlStorageKey);
      localStorage.removeItem(executionEntryTimeStorageKey);
      localStorage.removeItem(strikeStorageKey);
      localStorage.removeItem(lockStorageKey);
      localStorage.removeItem(spotStorageKey);
      window.dispatchEvent(new CustomEvent('quant_trade_opened', { detail: { symbol } }));
    }
    setManualCloseToast(`🔄 Position reset to Live Active tracking.`);
    setTimeout(() => setManualCloseToast(null), 3000);
  };

  const handleToggleBreakeven = () => {
    setIsBreakevenActive(!isBreakevenActive);
    setManualCloseToast(
      !isBreakevenActive
        ? `🛡️ Stop Loss moved to Breakeven (Entry: ${currencySymbol}${effectiveEntryPrice.toFixed(2)}). Trade is now 100% RISK-FREE!`
        : `Stop Loss restored to original level (${currencySymbol}${originalSL.toFixed(2)})`,
    );
    setTimeout(() => setManualCloseToast(null), 5000);
  };

  const handleToggleTrailing = () => {
    setIsTrailingSLActive(!isTrailingSLActive);
    setManualCloseToast(
      !isTrailingSLActive
        ? `📈 Dynamic Trailing Stop Loss ACTIVATED! SL will trail option premium to protect profit.`
        : `Trailing Stop Loss disabled. SL restored to fixed level.`,
    );
    setTimeout(() => setManualCloseToast(null), 5000);
  };

  const lockedStrikeLabel = useMemo(() => {
    if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') return '';
    return `${activeStrike} ${isBull ? 'CE' : 'PE'}`;
  }, [activeStrike, isBull, symbol]);

  const isSetupClosed =
    !paperPosition &&
    isPositionCut &&
    Boolean(closedTradeSummary);

  if (isSetupClosed) {
    return (
      <div className="bg-[#111827]/80 backdrop-blur-md border border-slate-800 rounded-xl p-5 shadow-xl font-mono flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">
                No Active Running Position for {symbol}
              </span>
              <span className="bg-emerald-950/80 text-emerald-300 border border-emerald-800 text-[10px] px-2 py-0.5 rounded font-bold">
                Position Exited
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Closed position logged in{' '}
              <strong className="text-cyan-300">Institutional Trade Journal</strong> below. Scanning
              15m order flow for next high-probability SMC setup.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReopenTrade}
            className="text-xs text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg transition-all font-bold"
            title="Reset tracker to track next setup"
          >
            Track Next Setup
          </button>
          <span className="text-xs text-cyan-400 font-bold bg-cyan-950/60 border border-cyan-800/60 px-3 py-1.5 rounded-lg flex items-center gap-1.5 animate-pulse">
            <Radio className="w-3.5 h-3.5" /> Engine Standing By for Valid Setup
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#111827]/95 backdrop-blur-md border border-cyan-500/30 rounded-xl p-5 shadow-2xl space-y-4 relative overflow-hidden">
      {/* Top Background Glow Effect */}
      <div
        className={`absolute -top-12 -right-12 w-40 h-40 rounded-full blur-3xl opacity-20 pointer-events-none ${
          hasActiveTrade ? (runningPnL >= 0 ? 'bg-emerald-500' : 'bg-rose-500') : 'bg-cyan-500'
        }`}
      />

      {/* Header Bar with Live Timestamps & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            {hasActiveTrade ? (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
              </span>
            ) : (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-50" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500" />
              </span>
            )}
            <h3 className="text-xs font-black uppercase tracking-wider font-mono flex items-center gap-1.5 text-white">
              {hasActiveTrade ? (
                <>
                  <Zap className="w-4 h-4 text-cyan-400" />
                  ACTIVE RUNNING POSITION TRACKER
                </>
              ) : (
                <>
                  <Radio className="w-4 h-4 text-cyan-400 animate-pulse" />
                  SMC TRADE SETUP RADAR (STANDBY)
                </>
              )}
            </h3>
          </div>

          <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700 font-mono font-bold">
            {symbol}
          </span>

          {hasActiveTrade && (
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono flex items-center gap-1 ${
                paperPosition?.direction === 'BUY'
                  ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/80'
                  : 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
              }`}
            >
              {paperPosition?.direction === 'BUY' ? (
                <TrendingUp className="w-3.5 h-3.5" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5" />
              )}
              ACTIVE POSITION: {paperPosition?.direction === 'BUY' ? 'BUY / BULLISH' : 'SELL / BEARISH'}
            </span>
          )}

          {signal && (
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono flex items-center gap-1 ${
                signal.direction === 'BULLISH'
                  ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/50'
                  : 'bg-rose-950/40 text-rose-300 border border-rose-800/50'
              }`}
            >
              {signal.direction === 'BULLISH' ? (
                <TrendingUp className="w-3.5 h-3.5" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5" />
              )}
              CURRENT SIGNAL: {signal.direction}
            </span>
          )}

          {!hasActiveTrade && (
            <span className="bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold">
              READY FOR EXECUTION
            </span>
          )}

          {isAutoScaledOut && (
            <span className="bg-amber-950/90 text-amber-300 border border-amber-600 px-2 py-0.5 rounded text-[10px] font-mono font-bold animate-pulse">
              ✂️ PARTIALLY CLOSED (TP1 HIT - SL @ BREAKEVEN)
            </span>
          )}

          {/* Mode Switcher Toggle */}
          {isOptionsAsset && (
            <button
              onClick={() => setIsOptionMode(!isOptionMode)}
              className={`text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full border transition-all flex items-center gap-1 shadow-sm ${
                isOptionMode
                  ? 'bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 text-cyan-300 border-cyan-500/50 shadow-cyan-500/10'
                  : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'
              }`}
            >
              <Sliders className="w-3 h-3 text-cyan-400" />
              {isOptionMode ? '⚡ OPTION PREMIUM MODE' : '📊 SPOT PRICE MODE'}
            </button>
          )}

          {/* Market Status Pill */}
          <span
            suppressHydrationWarning
            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border flex items-center gap-1 ${
              isMarketOpen
                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700'
                : 'bg-amber-950/80 text-amber-300 border-amber-700'
            }`}
          >
            {isMarketOpen ? (
              <Sun className="w-3 h-3 text-emerald-400" />
            ) : (
              <Moon className="w-3 h-3 text-amber-400" />
            )}
            {marketSessionLabel}
          </span>
        </div>

        {/* Timestamps in Header */}
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span
            className="bg-slate-900 border border-slate-800 px-2.5 py-1 rounded text-cyan-300 flex items-center gap-1 font-bold"
            suppressHydrationWarning
          >
            <Calendar className="w-3.5 h-3.5 text-cyan-400" />
            {hasActiveTrade
              ? `ENTRY: ${entryDate ? formatDateTimeIST(entryDate) : 'N/A'}`
              : `SETUP DETECTED: ${signal?.timestamp ? formatDateTimeIST(new Date(signal.timestamp)) : formatDateTimeIST(new Date())}`}
          </span>

          <span
            className="bg-slate-900 border border-slate-800 px-2.5 py-1 rounded text-amber-300 flex items-center gap-1 font-bold"
            suppressHydrationWarning
          >
            <Timer className="w-3.5 h-3.5 text-amber-400" />
            {hasActiveTrade
              ? (isMarketOpen ? `ELAPSED: ${formattedElapsed}` : `SESSION DURATION: 45m`)
              : 'STATUS: ENGINE STANDBY'}
          </span>
        </div>
      </div>

      {/* Option Strike Selector Banner (If Option Mode Active) */}
      {isOptionMode && !isCrypto && !isGold && optionData && (
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/60 to-slate-900 border border-indigo-500/40 rounded-xl p-3 font-mono space-y-2 text-xs shadow-inner">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="bg-cyan-500 text-slate-950 px-2 py-0.5 rounded text-[11px] font-black tracking-wide">
                RECOMMENDED CONTRACT
              </span>
              <strong className="text-white text-sm font-black tracking-wider">
                {optionData.recommendedStrike === activeStrike && optionData.contractName
                  ? optionData.contractName
                  : `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`}
              </strong>
              <span className="text-slate-400 text-[11px]">({optionData.expiryLabel})</span>
            </div>

            <div className="flex items-center gap-3 text-[11px]">
              <span className="text-slate-400">
                Delta: <strong className="text-cyan-300">{optionData.delta}</strong>
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400">
                Theta: <strong className="text-rose-400">{optionData.theta}/day</strong>
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400">
                IV: <strong className="text-amber-300">{optionData.iv}%</strong>
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                Margin: {currencySymbol}
                {totalMarginUsed.toLocaleString()} ({isCrypto ? 'No Cap' : '≤ ₹50k'})
              </span>
            </div>
          </div>

          {/* Locked Strike Display */}
          {lockedStrikeLabel && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[10px] text-slate-400 flex items-center gap-1 mr-1">
                <Radio className="w-3 h-3 text-cyan-400" /> Locked Strike:
              </span>
              <span className="px-2.5 py-0.5 rounded text-[10px] font-black bg-cyan-500 text-slate-950 shadow-sm ring-1 ring-cyan-400">
                {lockedStrikeLabel}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main PnL & Quantity Metrics Matrix */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 font-mono">
        {/* 1. Realized or Unrealized P&L or Standby Setup Asymmetry */}
        {(() => {
          const isClosed = isPositionCut && !!closedTradeSummary;
          if (!hasActiveTrade && !isClosed) {
            const spreadToCMP = currentCMP - spotEntryPrice;
            const plannedRisk = Math.abs(spotEntryPrice - originalSL);
            const projectedReward = Math.abs(tp2 - spotEntryPrice);
            const rrRatio = plannedRisk > 0 ? (projectedReward / plannedRisk).toFixed(1) : '2.5';

            return (
              <div className="bg-slate-900/90 border border-cyan-500/30 p-3.5 rounded-xl col-span-2 sm:col-span-2 relative overflow-hidden">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-cyan-400 uppercase tracking-wider block font-bold flex items-center gap-1">
                    <Radio className="w-3 h-3 text-cyan-400" /> SMC SETUP ASYMMETRY (STANDBY)
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-black px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                      1 : {rrRatio} R (Target R:R)
                    </span>
                  </div>
                </div>

                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl sm:text-3xl font-black tracking-tight text-cyan-300">
                    +2.5R POTENTIAL
                  </span>
                  <span className="text-sm font-bold text-slate-400">
                    (Ready to Execute)
                  </span>
                </div>
                <span className="text-[10px] text-slate-300 block mt-1.5 font-bold">
                  <span className="text-slate-400">
                    Live CMP: {nativeCurrency}{dp(currentCMP).toFixed(2)}
                  </span>
                  <span className="text-slate-500 mx-1">•</span>
                  <span className="text-cyan-300">
                    Optimal Entry: {nativeCurrency}{dp(spotEntryPrice).toFixed(2)}
                    {Math.abs(spreadToCMP) > 0.01 && ` (${spreadToCMP >= 0 ? '+' : ''}${dp(spreadToCMP).toFixed(2)} pts)`}
                  </span>
                </span>
              </div>
            );
          }

          const displayPnL = isClosed ? closedTradeSummary!.pnl : runningPnL;
          const displayR = isClosed ? closedTradeSummary!.r : runningRMultiple;
          const isProfitableDisplay = displayPnL >= 0;

          return (
            <div
              className={`p-3.5 rounded-xl border col-span-2 sm:col-span-2 relative overflow-hidden ${
                isClosed
                  ? 'bg-slate-900/90 border-slate-700/80 shadow-lg'
                  : isProfitableDisplay
                    ? 'bg-emerald-950/30 border-emerald-500/40'
                    : 'bg-rose-950/30 border-rose-500/40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                  {isClosed
                    ? `POSITION CLOSED • ${closedTradeSummary?.reason?.toUpperCase() || 'STOP LOSS HIT'}`
                    : isOptionMode && !isCrypto && !isGold
                      ? 'UNREALIZED RUNNING OPTION P&L'
                      : 'NET UNREALIZED RUNNING P&L'}
                </span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-xs font-black px-2 py-0.5 rounded ${
                      isProfitableDisplay
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}
                  >
                    {displayR >= 0 ? '+' : ''}
                    {displayR}R
                  </span>
                </div>
              </div>

              <div className="flex items-baseline gap-2 mt-1">
                <span
                  className={`text-2xl sm:text-3xl font-black tracking-tight ${
                    isProfitableDisplay ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {displayPnL >= 0 ? '+' : ''}
                  {currencySymbol}
                  {displayPnL.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span
                  className={`text-sm font-bold ${
                    isProfitableDisplay ? 'text-emerald-400/90' : 'text-rose-400/90'
                  }`}
                >
                  ({isClosed ? (displayPnL >= 0 ? '+' : '') : runningPnL >= 0 ? '+' : ''}
                  {returnPercentage}% {isCrypto ? 'ROE' : ''})
                </span>
              </div>

              {/* Accounting Breakdown: Price Move, Gross P&L, Fees */}
              <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-slate-800/80 text-[10px]">
                <div>
                  <span className="text-slate-400 block font-medium">PRICE MOVE</span>
                  <span className={`font-bold ${canonicalPriceMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {canonicalPriceMove >= 0 ? '+' : ''}{canonicalPriceMove.toFixed(2)} pts
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block font-medium">GROSS P&L</span>
                  <span className={`font-bold ${canonicalGrossPnlAccount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {canonicalGrossPnlAccount >= 0 ? '+' : ''}{currencySymbol}{canonicalGrossPnlAccount.toFixed(2)}
                    {isCrypto ? ` ($${canonicalGrossPnlQuote >= 0 ? '+' : ''}${canonicalGrossPnlQuote.toFixed(2)})` : ''}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block font-medium">FEES / CHARGES</span>
                  <span className="font-bold text-amber-400">
                    -{currencySymbol}{canonicalFees.toFixed(2)}
                  </span>
                </div>
              </div>

              <span className="text-[10px] text-slate-300 block mt-2 font-bold">
                {isClosed ? (
                  <span className="text-slate-400 block mt-0.5">
                    Exited @ {nativeCurrency}
                    {dp(closedTradeSummary.exitPrice).toFixed(2)} ({closedTradeSummary.reason}) •
                    Logged to Institutional Trade Journal
                  </span>
                ) : isOptionMode && !isCrypto && !isGold ? (
                  <>
                    <span className={priceDifference >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      Option LTP: {nativeCurrency}
                      {dp(effectiveCurrentPrice).toFixed(2)} (Entry: {nativeCurrency}
                      {dp(effectiveEntryPrice).toFixed(2)} | {priceDifference >= 0 ? '+' : ''}
                      {dp(priceDifference).toFixed(2)} pts)
                    </span>
                    <span className="text-slate-500 mx-1">•</span>
                    <span className="text-slate-400">
                      Spot CMP: {nativeCurrency}
                      {dp(currentCMP).toFixed(2)} ({isBull ? 'Long' : 'Short'} Entry:{' '}
                      {nativeCurrency}
                      {dp(spotEntryPrice).toFixed(2)})
                    </span>
                  </>
                ) : (
                  <>
                    <span className={canonicalPriceMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {isBull ? '🟢 LONG / BULLISH' : '🔻 SHORT / BEARISH'}:{' '}
                      {canonicalPriceMove >= 0 ? '+' : ''}
                      {dp(canonicalPriceMove).toFixed(2)} pts
                    </span>
                    <span className="text-slate-500 mx-1">•</span>
                    <span className="text-slate-400">
                      CMP: {nativeCurrency}
                      {dp(currentCMP).toFixed(2)} (Entry: {nativeCurrency}
                      {dp(spotEntryPrice).toFixed(2)})
                    </span>
                    <span className="text-slate-500 mx-1">•</span>
                    <span className="text-cyan-400">
                      Margin: {currencySymbol}{totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({effectiveLeverage}x)
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })()}

        {/* 2. Position Size & Strike Contract */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
            {hasActiveTrade
              ? isOptionMode && !isCrypto && !isGold
                ? 'ACTIVE STRIKE & QTY'
                : 'CONTRACT QUANTITY'
              : 'ORDER QUANTITY'}
          </span>
          <span className="text-xl font-black text-cyan-300 block mt-1">
            {totalQuantity} {isCrypto ? 'BTC' : isGold ? 'oz' : 'Qty'}
          </span>
          <span className="text-[10px] text-indigo-300 font-bold block mt-0.5 truncate">
            {isOptionMode && !isCrypto && !isGold
              ? `⚡ ${optionData?.recommendedStrike === activeStrike && optionData?.contractName ? optionData.contractName : `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`} (Locked)`
              : isCrypto
                ? `0.01 BTC Contract (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                : isGold
                  ? `${totalQuantity} oz Gold Spot (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                  : `${symbol === 'NIFTY' ? '1 Lot (65 Qty)' : '1 Lot'}`}
          </span>
        </div>

        {/* 3. Option Entry Premium */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
            {hasActiveTrade
              ? isOptionMode && !isCrypto && !isGold
                ? 'ENTRY PREMIUM (LOCKED)'
                : 'SPOT ENTRY (LOCKED)'
              : 'OPTIMAL ENTRY ZONE'}
          </span>
          <span className="text-xl font-black text-white block mt-1">
            {nativeCurrency}
            {dp(effectiveEntryPrice).toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">
            {isOptionMode && !isCrypto && !isGold
              ? `Spot: ${nativeCurrency}${dp(spotEntryPrice).toFixed(2)} | Margin: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : `${hasActiveTrade ? 'Margin Used' : 'Projected Margin'}: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}${isCrypto || isGold ? ` (${effectiveLeverage}x Leverage)` : ''}`}
          </span>
        </div>

        {/* 4. Active Stop Loss (With Trailing Profit Lock / BE Indicator) */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
              {!hasActiveTrade
                ? 'PLANNED STOP LOSS'
                : isProfitLocked
                  ? 'TRAILING SL (PROFIT LOCKED)'
                  : isOptionMode && !isCrypto && !isGold
                    ? 'OPTION SL PREMIUM'
                    : 'STOP LOSS'}
            </span>
            {hasActiveTrade && isProfitLocked ? (
              <span className="text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800/80 px-1.5 py-0.5 rounded font-bold">
                PROFIT LOCKED
              </span>
            ) : hasActiveTrade && isBreakevenActive ? (
              <span className="text-[9px] bg-cyan-950 text-cyan-400 border border-cyan-800/80 px-1.5 py-0.5 rounded font-bold">
                BE ACTIVE
              </span>
            ) : null}
          </div>
          <span
            className={`text-xl font-black block mt-1 ${
              hasActiveTrade && isProfitLocked
                ? 'text-emerald-400'
                : hasActiveTrade && isBreakevenActive
                  ? 'text-cyan-400'
                  : 'text-rose-400'
            }`}
          >
            {nativeCurrency}
            {dp(currentSL).toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">
            {hasActiveTrade && isProfitLocked
              ? `Locked Profit: +${currencySymbol}${lockedProfitAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (Risk Free)`
              : hasActiveTrade && isBreakevenActive
                ? `Max Risk: ${currencySymbol}0.00 (Risk Free)`
                : `Max Risk: -${currencySymbol}${maxRiskAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </span>
        </div>
      </div>

      {/* Target Progression Progress Bar */}
      <div className="bg-slate-900/80 border border-slate-800 p-3 rounded-lg space-y-1.5 font-mono">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-slate-400 flex items-center gap-1 font-bold">
            <Target className="w-3.5 h-3.5 text-cyan-400" />
            {isOptionMode && !isCrypto && !isGold
              ? 'OPTION PREMIUM TARGET ROADMAP:'
              : 'TARGET PROGRESSION & MARKET TIMELINE:'}
          </span>
          <div className="flex items-center gap-3 text-[10px]">
            <span className={isTP1Reached ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
              TP1: {nativeCurrency}
              {dp(tp1).toFixed(2)} ({isTP1Reached ? '✅ HIT' : '+100%'})
            </span>
            <span className="text-slate-600">•</span>
            <span className={isTP2Reached ? 'text-teal-300 font-bold' : 'text-slate-400'}>
              TP2: {nativeCurrency}
              {dp(tp2).toFixed(2)} ({isTP2Reached ? '🎯 HIT' : '+250%'})
            </span>
            <span className="text-slate-600">•</span>
            <span className={isTP3Reached ? 'text-purple-300 font-bold' : 'text-slate-400'}>
              TP3: {nativeCurrency}
              {dp(tp3).toFixed(2)} ({isTP3Reached ? '🏆 HIT' : '+400%'})
            </span>
          </div>
        </div>

        {/* Progress Fill Bar */}
        <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800 relative">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              isTP3Reached
                ? 'bg-gradient-to-r from-teal-400 to-purple-400'
                : isTP2Reached
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                  : isTP1Reached
                    ? 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                    : 'bg-cyan-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[9px] text-slate-500">
          <span>{hasActiveTrade ? `Session Entry: ${entryDate ? formatDateTimeIST(entryDate) : 'N/A'}` : 'Session Entry: Awaiting Execution'}</span>
          <span className="text-cyan-400 font-bold">
            {hasActiveTrade
              ? `${progressPercent.toFixed(1)}% to Target (${isTP3Reached ? 'TP3 HIT' : isTP2Reached ? 'TP2 HIT' : isTP1Reached ? 'TP1 HIT' : 'TP2'})`
              : '0.0% to Target (Standby - Armed)'}
          </span>
          <span>{hasActiveTrade ? `Session Target Exit: ${estCloseDate ? formatDateTimeIST(estCloseDate) : 'N/A'}` : 'Target Exit: Estimated 45m - 2h'}</span>
        </div>
      </div>

      {/* Scaled Out Status Pill */}
      {isAutoScaledOut && !isPositionCut && (
        <div className="bg-emerald-950/60 border border-emerald-500/50 p-2.5 rounded-lg font-mono flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-emerald-300 font-bold">
            <Award className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              ✨ 50% {isCrypto ? 'CRYPTO' : isOptionMode ? 'OPTION' : 'SPOT'} CONTRACTS BOOKED (+
              {currencySymbol}
              {scaledOutPnL.toFixed(2)} Secured) | Remaining 50% Running Risk-Free to TP2!
            </span>
          </div>
          <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded border border-emerald-500/30">
            SL @ BREAKEVEN
          </span>
        </div>
      )}

      {/* Fast Action Controls Bar */}
      {isPositionCut && !!closedTradeSummary ? (
        <div className="w-full bg-slate-900/90 border border-slate-800 p-3 rounded-xl flex flex-wrap items-center justify-between gap-3 font-mono text-xs shadow-lg">
          <div className="flex items-center gap-2 text-slate-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              Position exited &amp; permanently logged in{' '}
              <strong>Institutional Trade Journal</strong>.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReopenTrade}
              className="text-xs text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg transition-all font-bold"
            >
              Track Next Setup
            </button>
            <span className="text-[11px] text-cyan-400 font-bold bg-cyan-950/80 px-2.5 py-1 rounded border border-cyan-800/60">
              Awaiting Next Institutional SMC Signal
            </span>
          </div>
        </div>
      ) : hasActiveTrade ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 font-mono text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {/* Move to Breakeven Toggle */}
            <button
              onClick={handleToggleBreakeven}
              className={`px-3 py-1.5 rounded-lg border font-bold flex items-center gap-1.5 transition-all ${
                isBreakevenActive || isAutoScaledOut
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/20'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              {isBreakevenActive || isAutoScaledOut
                ? 'SL At Breakeven (0 Risk)'
                : 'Move SL to Breakeven'}
            </button>

            {/* Dynamic Trailing Stop Loss Toggle */}
            <button
              onClick={handleToggleTrailing}
              className={`px-3 py-1.5 rounded-lg border font-bold flex items-center gap-1.5 transition-all ${
                isTrailingSLActive
                  ? 'bg-amber-400 text-slate-950 border-amber-300 shadow-md shadow-amber-400/20'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              {isTrailingSLActive
                ? `Trailing SL Active (${currencySymbol}${dp(trailingSL).toFixed(2)})`
                : 'Enable Trailing SL'}
            </button>

            {/* Manual 50% Scale Out Button */}
            {!isAutoScaledOut && (
              <button
                onClick={() => handleCutTrade('Manual 50% Scale Out', effectiveCurrentPrice, 0.5)}
                className="bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition-all"
              >
                <Award className="w-3.5 h-3.5" />
                Scale Out 50% Now
              </button>
            )}
          </div>

          {/* Immediate Market Exit Button */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleCutTrade('Manual Market Cut @ Current Price')}
              className="bg-rose-500 hover:bg-rose-400 text-slate-950 font-black px-4 py-1.5 rounded-lg font-mono flex items-center gap-1.5 shadow-lg shadow-rose-500/20 transition-all text-xs"
            >
              <XCircle className="w-4 h-4" />⚡ Exit Trade @ Market ({nativeCurrency}
              {dp(effectiveCurrentPrice).toFixed(2)})
            </button>
          </div>
        </div>
      ) : (
        <div className="w-full bg-slate-900/90 border border-slate-800 p-3 rounded-xl flex flex-wrap items-center justify-between gap-3 font-mono text-xs shadow-lg">
          <div className="flex items-center gap-2 text-slate-300">
            <Radio className="w-4 h-4 text-cyan-400 shrink-0 animate-pulse" />
            <span>
              SMC Setup Armed • Optimal Entry: <strong className="text-white">{nativeCurrency}{dp(spotEntryPrice).toFixed(2)}</strong> | Target R:R: <strong className="text-cyan-300">1:2.5R</strong> | Max Risk: <strong className="text-rose-400">{currencySymbol}{maxRiskAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {bot && (
              <button
                type="button"
                onClick={handleToggleBot}
                disabled={isTogglingBot}
                className={`px-3 py-1.5 rounded-lg font-mono text-xs font-bold border flex items-center gap-1.5 transition-all ${
                  bot.isActive
                    ? 'bg-emerald-950/80 text-emerald-300 border-emerald-600/60 hover:bg-emerald-900/80'
                    : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                }`}
                title={
                  bot.isActive
                    ? 'Bot is ACTIVE: monitoring signals automatically'
                    : 'Bot is INACTIVE: click to activate auto-monitoring'
                }
              >
                <Bot className="w-3.5 h-3.5" />
                {isTogglingBot ? 'Updating...' : bot.isActive ? '🤖 Bot: ACTIVE' : '🤖 Bot: OFF (Enable)'}
              </button>
            )}

            <button
              type="button"
              onClick={handleExecutePaperOrder}
              disabled={isPlacingOrder || (!isOptionsAsset && !isBull)}
              className={`font-black px-4 py-1.5 rounded-lg font-mono flex items-center gap-1.5 shadow-lg transition-all text-xs ${
                !isOptionsAsset && !isBull
                  ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                  : 'bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-slate-950 shadow-cyan-500/20'
              }`}
              title={
                !isOptionsAsset && !isBull
                  ? 'Spot instruments are long-only. Spot short selling is prohibited.'
                  : 'Execute paper order at current market price'
              }
            >
              <Zap className="w-4 h-4" />
              {isPlacingOrder
                ? 'Executing...'
                : !isOptionsAsset && !isBull
                  ? 'Spot Short Selling Forbidden (Long-Only)'
                  : isOptionsAsset
                    ? `Execute Option ${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'} @ ₹${dp(effectiveCurrentPrice).toFixed(2)}`
                    : `Execute Paper Trade @ Market (${nativeCurrency}${dp(currentCMP).toFixed(2)})`}
            </button>
          </div>
        </div>
      )}

      {/* Action Toast Banner */}
      {manualCloseToast && (
        <div className="bg-slate-900 border border-cyan-500 p-2.5 rounded-lg text-xs font-mono text-cyan-300 animate-in fade-in flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{manualCloseToast}</span>
        </div>
      )}
    </div>
  );
};
