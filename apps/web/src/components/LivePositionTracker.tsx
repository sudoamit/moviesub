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
} from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface LivePositionTrackerProps {
  symbol: string;
  signal: ISignalSetup | null;
  livePrice: number;
  onClosePosition?: (exitPrice: number, pnl: number, r: number, reason: string) => void;
}

interface RunningPaperPosition {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice?: number;
  entryTime?: string;
  averageEntryPrice?: number;
  openedAt?: string;
}

const formatDateTimeIST = (date: Date) => {
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
function getMarketAwareTimestamps(symbol: string, signalTimestamp?: Date | string | number) {
  const isCrypto = symbol === 'BTCUSDT';
  const isGold = symbol === 'XAUUSD' || symbol === 'GOLD';
  const now = new Date();

  if (isCrypto) {
    const entry = signalTimestamp
      ? new Date(signalTimestamp)
      : new Date(now.getTime() - 25 * 60000);
    const estClose = new Date(entry.getTime() + 45 * 60000);
    return {
      entryDate: entry,
      estCloseDate: estClose,
      isMarketOpen: true,
      marketSessionLabel: '24/7 LIVE CRYPTO SESSION',
      isNSE: false,
    };
  }

  if (isGold) {
    const entry = signalTimestamp
      ? new Date(signalTimestamp)
      : new Date(now.getTime() - 20 * 60000);
    const estClose = new Date(entry.getTime() + 60 * 60000);
    return {
      entryDate: entry,
      estCloseDate: estClose,
      isMarketOpen: true,
      marketSessionLabel: '23/5 LIVE GOLD COMMODITY (COMEX / LONDON FIX)',
      isNSE: false,
    };
  }

  // Indian NSE Market (09:15 AM to 03:30 PM IST)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHours = istNow.getUTCHours();
  const istMinutes = istNow.getUTCMinutes();
  const istDay = istNow.getUTCDay(); // 0 = Sun, 6 = Sat

  const isWeekday = istDay >= 1 && istDay <= 5;
  const currentMinInDay = istHours * 60 + istMinutes;
  const marketOpenMin = 9 * 60 + 15; // 09:15 AM IST
  const marketCloseMin = 15 * 60 + 30; // 03:30 PM IST

  const isMarketOpen =
    isWeekday && currentMinInDay >= marketOpenMin && currentMinInDay <= marketCloseMin;

  let entryDate = new Date(now);
  let estCloseDate = new Date(now);

  if (signalTimestamp) {
    entryDate = new Date(signalTimestamp);
    estCloseDate = new Date(entryDate.getTime() + 45 * 60000);
  } else if (isMarketOpen) {
    entryDate = new Date(now.getTime() - 30 * 60000);
    estCloseDate = new Date(entryDate.getTime() + 45 * 60000);
  } else {
    const entryIST = new Date(now);
    entryIST.setUTCHours(9, 45, 0, 0); // 03:15 PM IST
    entryDate = entryIST;

    const closeIST = new Date(now);
    closeIST.setUTCHours(10, 0, 0, 0); // 03:30 PM IST
    estCloseDate = closeIST;
  }

  return {
    entryDate,
    estCloseDate,
    isMarketOpen,
    marketSessionLabel: isMarketOpen
      ? 'LIVE NSE SESSION (09:15 - 15:30 IST)'
      : 'NSE MARKET CLOSED (Session: 09:15 - 15:30 IST)',
    isNSE: true,
  };
}

export const LivePositionTracker: React.FC<LivePositionTrackerProps> = ({
  symbol,
  signal,
  livePrice,
  onClosePosition,
}) => {
  const isCrypto =
    symbol === 'BTCUSDT' ||
    symbol.toUpperCase().includes('BTC') ||
    symbol.toUpperCase().includes('ETH');
  const isGold = symbol === 'XAUUSD' || symbol === 'GOLD' || symbol.toUpperCase().includes('XAU');
  const currencySymbol = isCrypto || isGold ? '$' : '₹';

  // Toggle between Option Premium Mode (default for Indian markets) and Spot Mode
  const [isOptionMode, setIsOptionMode] = useState<boolean>(!isCrypto && !isGold);

  useEffect(() => {
    setIsOptionMode(!isCrypto && !isGold);
  }, [isCrypto, isGold]);

  const [optionData, setOptionData] = useState<any>(null);

  const direction = signal?.direction || 'BEARISH';
  const isBull = direction === 'BULLISH';
  const positionLockKey = `${symbol}_${direction}`;
  const executionEntryTimeStorageKey = `quant_running_entry_time_${positionLockKey}`;
  const [paperPosition, setPaperPosition] = useState<RunningPaperPosition | null>(null);
  const [lockedExecutionEntryTime, setLockedExecutionEntryTime] = useState<string>(
    '2026-09-03T09:15:00.000Z',
  );

  useEffect(() => {
    let isMounted = true;

    const fetchPaperPosition = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/paper-trading/portfolio');
        const data = await res.json();
        const expectedSide = direction === 'BULLISH' ? 'BUY' : 'SELL';
        const positions = Array.isArray(data?.openPositions) ? data.openPositions : [];
        const found =
          positions.find(
            (p: RunningPaperPosition) => p.symbol === symbol && p.direction === expectedSide,
          ) || positions.find((p: RunningPaperPosition) => p.symbol === symbol);

        if (!isMounted) return;
        setPaperPosition(found || null);

        const authoritativeEntryTime = found?.entryTime || found?.openedAt;
        if (authoritativeEntryTime) {
          setLockedExecutionEntryTime(authoritativeEntryTime);
          if (typeof window !== 'undefined') {
            localStorage.setItem(executionEntryTimeStorageKey, authoritativeEntryTime);
          }
        }
      } catch {}
    };

    fetchPaperPosition();
    const interval = setInterval(fetchPaperPosition, 1500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [symbol, direction, executionEntryTimeStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (paperPosition?.entryTime || paperPosition?.openedAt) return;
    const saved = localStorage.getItem(executionEntryTimeStorageKey);
    if (saved) {
      setLockedExecutionEntryTime(saved);
      return;
    }

    const now = new Date().toISOString();
    localStorage.setItem(executionEntryTimeStorageKey, now);
    setLockedExecutionEntryTime(now);
  }, [executionEntryTimeStorageKey, paperPosition?.entryTime, paperPosition?.openedAt]);

  // Market-Aware Timestamps use actual execution/open time, never signal candle time.
  const { entryDate, estCloseDate, isMarketOpen, marketSessionLabel, isNSE } = useMemo(() => {
    const authoritativeEntryTime =
      paperPosition?.entryTime || paperPosition?.openedAt || lockedExecutionEntryTime;
    return getMarketAwareTimestamps(symbol, authoritativeEntryTime);
  }, [symbol, paperPosition?.entryTime, paperPosition?.openedAt, lockedExecutionEntryTime]);

  // Elapsed Seconds Counter
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(2700);

  useEffect(() => {
    if (!isMarketOpen && isNSE) {
      setElapsedSeconds(2700);
      return;
    }
    const timer = setInterval(() => {
      const diffSec = Math.max(0, Math.floor((Date.now() - entryDate.getTime()) / 1000));
      setElapsedSeconds(diffSec);
    }, 1000);
    return () => clearInterval(timer);
  }, [entryDate, isMarketOpen, isNSE]);

  const formattedElapsed = useMemo(() => {
    const hrs = Math.floor(elapsedSeconds / 3600);
    const mins = Math.floor((elapsedSeconds % 3600) / 60);
    const secs = elapsedSeconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }, [elapsedSeconds]);

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
      return price >= 1500 && price <= 5000;
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
      const isCut =
        localStorage.getItem(cutStorageKey) === 'true' ||
        localStorage.getItem(symbolCutKey) === 'true' ||
        Boolean(
          signal &&
          (signal.state === 'TP2_HIT' || signal.state === 'TP3_HIT' || signal.state === 'SL_HIT'),
        );

      setIsPositionCut(isCut);

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

  // Initial spot entry should strictly match signal's optimal entry price (or live price if entered at market)
  const initialSpotCandidate = isSaneSpot(symbol, rawSignalOptimal)
    ? rawSignalOptimal
    : isSaneSpot(symbol, rawLivePrice)
      ? rawLivePrice
      : symbol === 'BTCUSDT'
        ? 78200
        : symbol === 'XAUUSD' || symbol === 'GOLD'
          ? 2885.5
          : symbol === 'BANKNIFTY'
            ? 57400
            : 24060;

  const [lockedSpotEntry, setLockedSpotEntry] = useState<number>(initialSpotCandidate);

  const lockedSpotRef = React.useRef<number>(lockedSpotEntry);

  const spotEntryPrice =
    lockedSpotRef.current > 0 && isSaneSpot(symbol, lockedSpotRef.current)
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
      const initialOpt = savedOpt ? Number(savedOpt) : 0;
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
  ]);

  // Fetch Live Option Smart Strike Data & Locked Entry Premium
  useEffect(() => {
    if (isCrypto) return;
    let isMounted = true;

    const fetchOptionData = async () => {
      try {
        // 1. Fetch live market option data at current CMP
        const resLive = await fetch(
          `http://localhost:3001/api/options/smart-strike?symbol=${symbol}&direction=${direction}&spotPrice=${currentCMP}&strike=${activeStrike}`,
        );
        const dataLive = await resLive.json();
        if (isMounted && dataLive && dataLive.contractName) {
          setOptionData(dataLive);
        }

        // 2. Lock initial entry premium calculated strictly at spotEntryPrice if not already locked
        if (!lockedEntryRef.current || lockedEntryRef.current === 0) {
          const resEntry = await fetch(
            `http://localhost:3001/api/options/smart-strike?symbol=${symbol}&direction=${direction}&spotPrice=${spotEntryPrice}&strike=${activeStrike}`,
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
  }, [symbol, direction, currentCMP, spotEntryPrice, activeStrike, isCrypto, lockStorageKey]);

  // Base Standard Sizing: 65 Qty (1 Lot) for NIFTY, 15 Qty (1 Lot) for BANKNIFTY
  const lotSize = symbol === 'NIFTY' ? 65 : symbol === 'BANKNIFTY' ? 15 : isCrypto ? 0.2 : 100;
  const activeQty = isAutoScaledOut ? lotSize * 0.5 : lotSize;
  const numericQty = activeQty;
  const totalQuantity = isCrypto ? activeQty.toFixed(4) : activeQty.toLocaleString();

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
  const effectiveEntryPrice = isOptionMode && !isCrypto ? optionEntryPremium : spotEntryPrice;
  const effectiveCurrentPrice = isOptionMode && !isCrypto ? liveOptionPremium : currentCMP;

  // Strict Directional Stop Loss Geometry Validator (Bearish SL strictly > Entry, Bullish SL strictly < Entry)
  const safeInitialSL = React.useMemo(() => {
    const rawSL = Number(signal?.stopLoss);
    if (isOptionMode && !isCrypto) return optionStopLoss;

    // Tight sniper SL defaults: BTC max 180 pts, NIFTY max 20 pts, BANKNIFTY max 55 pts
    const defaultRisk = isCrypto
      ? 160.0
      : symbol === 'NIFTY'
        ? 20.0
        : symbol === 'BANKNIFTY'
          ? 55.0
          : spotEntryPrice * 0.004;

    if (isBull) {
      if (rawSL > 0 && rawSL < spotEntryPrice) {
        const dist = spotEntryPrice - rawSL;
        // Clamp excessive SL on BTC to tight sniper range (max 220 pts)
        if (isCrypto && dist > 250) return Number((spotEntryPrice - 180.0).toFixed(2));
        return rawSL;
      }
      return Number((spotEntryPrice - defaultRisk).toFixed(2));
    } else {
      if (rawSL > 0 && rawSL > spotEntryPrice) {
        const dist = rawSL - spotEntryPrice;
        // Clamp excessive SL on BTC to tight sniper range (max 220 pts)
        if (isCrypto && dist > 250) return Number((spotEntryPrice + 180.0).toFixed(2));
        return rawSL;
      }
      return Number((spotEntryPrice + defaultRisk).toFixed(2));
    }
  }, [signal?.stopLoss, isOptionMode, isCrypto, optionStopLoss, isBull, spotEntryPrice, symbol]);

  const originalSL = safeInitialSL;
  const riskPerUnit = Math.abs(effectiveEntryPrice - originalSL);

  // Dynamic Trailing Stop Loss Calculation
  const trailingSL = React.useMemo(() => {
    if (!isTrailingSLActive || riskPerUnit <= 0) return originalSL;
    if (isOptionMode && !isCrypto) {
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
  ]);

  const currentSL = isTrailingSLActive
    ? trailingSL
    : isBreakevenActive || isAutoScaledOut
      ? effectiveEntryPrice
      : originalSL;

  const isProfitLocked =
    isOptionMode && !isCrypto
      ? currentSL > effectiveEntryPrice
      : isBull
        ? currentSL > effectiveEntryPrice
        : currentSL < effectiveEntryPrice;

  // USD to INR conversion rate for crypto (1 USD ≈ ₹87.00)
  const USD_INR_RATE = 87.0;

  const rawLockedProfit = isProfitLocked
    ? Math.abs(effectiveEntryPrice - currentSL) * numericQty
    : 0;
  const lockedProfitAmount = Number(
    (isCrypto ? rawLockedProfit * USD_INR_RATE : rawLockedProfit).toFixed(2),
  );

  const rawMaxRisk = numericQty * Math.abs(effectiveEntryPrice - originalSL);
  const maxRiskAmount = Number((isCrypto ? rawMaxRisk * USD_INR_RATE : rawMaxRisk).toFixed(2));

  // Guaranteed Directional Take Profit Roadmap (Strictly < Entry for BEARISH, > Entry for BULLISH)
  const validTP1 = isBull
    ? Number(signal?.takeProfits?.tp1) > spotEntryPrice
      ? Number(signal?.takeProfits?.tp1)
      : Number((spotEntryPrice + riskPerUnit * 1.5).toFixed(2))
    : Number(signal?.takeProfits?.tp1) < spotEntryPrice && Number(signal?.takeProfits?.tp1) > 0
      ? Number(signal?.takeProfits?.tp1)
      : Number((spotEntryPrice - riskPerUnit * 1.5).toFixed(2));

  const validTP2 = isBull
    ? Number(signal?.takeProfits?.tp2) > spotEntryPrice
      ? Number(signal?.takeProfits?.tp2)
      : Number((spotEntryPrice + riskPerUnit * 2.5).toFixed(2))
    : Number(signal?.takeProfits?.tp2) < spotEntryPrice && Number(signal?.takeProfits?.tp2) > 0
      ? Number(signal?.takeProfits?.tp2)
      : Number((spotEntryPrice - riskPerUnit * 2.5).toFixed(2));

  const validTP3 = isBull
    ? Number(signal?.takeProfits?.tp3) > spotEntryPrice
      ? Number(signal?.takeProfits?.tp3)
      : Number((spotEntryPrice + riskPerUnit * 4.0).toFixed(2))
    : Number(signal?.takeProfits?.tp3) < spotEntryPrice && Number(signal?.takeProfits?.tp3) > 0
      ? Number(signal?.takeProfits?.tp3)
      : Number((spotEntryPrice - riskPerUnit * 4.0).toFixed(2));

  const tp1 = isOptionMode && !isCrypto ? optionTP1 : validTP1;
  const tp2 = isOptionMode && !isCrypto ? optionTP2 : validTP2;
  const tp3 = isOptionMode && !isCrypto ? optionTP3 : validTP3;

  // Live Running P&L Calculation
  const priceDifference =
    isOptionMode && !isCrypto
      ? effectiveCurrentPrice - effectiveEntryPrice
      : isBull
        ? effectiveCurrentPrice - effectiveEntryPrice
        : effectiveEntryPrice - effectiveCurrentPrice;

  const rawPnL = priceDifference * numericQty;
  const inrPnL = isCrypto ? rawPnL * USD_INR_RATE : rawPnL;
  const runningPnL = Number((inrPnL + scaledOutPnL).toFixed(2));

  // Margin Used with 100x leverage for BTC
  const totalMarginUsed = isCrypto
    ? Number(((effectiveEntryPrice * numericQty * USD_INR_RATE) / 100).toFixed(2))
    : Number((effectiveEntryPrice * numericQty).toFixed(2));

  const runningRMultiple = riskPerUnit > 0 ? Number((priceDifference / riskPerUnit).toFixed(2)) : 0;
  const returnPercentage =
    totalMarginUsed > 0
      ? Number(((runningPnL / totalMarginUsed) * 100).toFixed(2))
      : effectiveEntryPrice > 0
        ? Number(((priceDifference / effectiveEntryPrice) * 100).toFixed(2))
        : 0;

  // Progress towards Targets
  const totalTargetDistance = Math.abs(tp2 - effectiveEntryPrice);
  const currentProgressDistance = Math.max(0, priceDifference);
  const progressPercent = Math.min(
    100,
    Math.max(
      0,
      totalTargetDistance > 0 ? (currentProgressDistance / totalTargetDistance) * 100 : 0,
    ),
  );

  // Authentic Spot & Option Stop Loss Evaluation (Strict directional geometric safety)
  const isSpotSLHit = isBull
    ? currentSL < spotEntryPrice && currentCMP > 0 && currentCMP <= currentSL
    : currentSL > spotEntryPrice && currentCMP > 0 && currentCMP >= currentSL;
  const isOptionSLHit =
    isOptionMode &&
    !isCrypto &&
    optionData?.optionLtp > 0 &&
    optionStopLoss > 0 &&
    liveOptionPremium > 0 &&
    liveOptionPremium <= currentSL;
  const isSLReached = isOptionMode && !isCrypto ? isOptionSLHit : isSpotSLHit;

  const spotTP3 = validTP3;
  const isSpotTP3Hit = isBull
    ? spotTP3 > spotEntryPrice && currentCMP >= spotTP3
    : spotTP3 < spotEntryPrice && currentCMP <= spotTP3;
  const isOptionTP3Hit =
    isOptionMode && !isCrypto && optionTP3 > 0 && liveOptionPremium > 0 && liveOptionPremium >= tp3;
  const isTP3Reached = isOptionMode && !isCrypto ? isOptionTP3Hit : isSpotTP3Hit;

  const spotTP2 = validTP2;
  const isSpotTP2Hit = isBull
    ? spotTP2 > spotEntryPrice && currentCMP >= spotTP2
    : spotTP2 < spotEntryPrice && currentCMP <= spotTP2;
  const isOptionTP2Hit =
    isOptionMode && !isCrypto && optionTP2 > 0 && liveOptionPremium > 0 && liveOptionPremium >= tp2;
  const isTP2Reached = isOptionMode && !isCrypto ? isOptionTP2Hit : isSpotTP2Hit;

  const spotTP1 = validTP1;
  const isSpotTP1Hit = isBull
    ? spotTP1 > spotEntryPrice && currentCMP >= spotTP1
    : spotTP1 < spotEntryPrice && currentCMP <= spotTP1;
  const isOptionTP1Hit =
    isOptionMode && !isCrypto && optionTP1 > 0 && liveOptionPremium > 0 && liveOptionPremium >= tp1;
  const isTP1Reached = isOptionMode && !isCrypto ? isOptionTP1Hit : isSpotTP1Hit;

  const autoCutExecutedRef = React.useRef<string | null>(null);

  const handleCutTrade = async (reason: string, exitP?: number, partialRatio: number = 1.0) => {
    const isValidExitPrice = (price: number) =>
      isOptionMode && !isCrypto ? isSaneOptionPremium(symbol, price) : isSaneSpot(symbol, price);

    let finalExitPrice = exitP && isValidExitPrice(exitP) ? exitP : effectiveCurrentPrice;
    if (!isValidExitPrice(finalExitPrice)) {
      finalExitPrice = effectiveEntryPrice;
    }
    const finalDiff =
      isOptionMode && !isCrypto
        ? finalExitPrice - effectiveEntryPrice
        : isBull
          ? finalExitPrice - effectiveEntryPrice
          : effectiveEntryPrice - finalExitPrice;

    const closedUnits = numericQty * partialRatio;
    const rawClosedPnL = finalDiff * closedUnits;
    const finalPnL = Number((isCrypto ? rawClosedPnL * USD_INR_RATE : rawClosedPnL).toFixed(2));
    const finalR =
      riskPerUnit > 0
        ? Number((finalDiff / riskPerUnit).toFixed(2))
        : reason.toLowerCase().includes('stop')
          ? -1.0
          : 0;

    if (partialRatio < 1.0) {
      setIsAutoScaledOut(true);
      setIsBreakevenActive(true);
      setScaledOutPnL((prev) => prev + finalPnL);
      if (typeof window !== 'undefined') {
        localStorage.setItem(scaleoutStorageKey, 'true');
        localStorage.setItem(scaleoutPnlStorageKey, String(finalPnL));
      }
      setManualCloseToast(
        `✂️ Partial Scale-Out Executed: 50% booked @ ${currencySymbol}${finalExitPrice.toFixed(2)} (+${currencySymbol}${finalPnL.toFixed(2)} / ${finalR}R). SL moved to BREAKEVEN (0 Risk)!`,
      );
      setTimeout(() => setManualCloseToast(null), 8000);
      return;
    }

    setIsPositionCut(true);
    const isManualCut =
      reason.toLowerCase().includes('manual') ||
      reason.toLowerCase().includes('cut') ||
      reason.toLowerCase().includes('exit');

    const summary = {
      exitPrice: finalExitPrice,
      pnl: finalPnL + scaledOutPnL,
      r: finalR,
      reason,
      isManual: isManualCut,
      closedAt: new Date().toISOString(),
    };
    setClosedTradeSummary(summary);
    if (typeof window !== 'undefined') {
      localStorage.setItem(cutStorageKey, 'true');
      localStorage.setItem(symbolCutKey, 'true');
      localStorage.setItem(cutSummaryStorageKey, JSON.stringify(summary));
      window.dispatchEvent(new CustomEvent('quant_trade_closed', { detail: { symbol } }));
    }

    if (onClosePosition) {
      onClosePosition(finalExitPrice, finalPnL + scaledOutPnL, finalR, reason);
    }

    // If an authoritative paper trading position is running, close it via paper-trading API
    if (paperPosition && (paperPosition as any).id) {
      try {
        await fetch('http://localhost:3001/api/paper-trading/close-position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionId: (paperPosition as any).id,
            reason,
          }),
        });
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('quant_trade_closed', { detail: { symbol } }));
        }
      } catch (err) {}
    }

    setManualCloseToast(
      `⚡ Position Exited: ${reason} @ ${currencySymbol}${finalExitPrice.toFixed(2)} | Realized: ${
        finalPnL + scaledOutPnL >= 0 ? '+' : ''
      }${currencySymbol}${(finalPnL + scaledOutPnL).toFixed(2)} (${finalR}R)`,
    );
    setTimeout(() => setManualCloseToast(null), 8000);
  };

  // Automatic UI state transition when Stop Loss or Target (TP2 or TP3) is breached in real-time
  useEffect(() => {
    if (isPositionCut) return;
    if (
      !signal ||
      signal.grade === 'NO_TRADE' ||
      (signal as any).direction === 'NEUTRAL' ||
      signal.score === 0
    )
      return;

    if (isSLReached && autoCutExecutedRef.current !== `SL_${symbol}_${direction}`) {
      autoCutExecutedRef.current = `SL_${symbol}_${direction}`;
      handleCutTrade(
        isTrailingSLActive
          ? 'Trailing Stop Loss Hit (Capital Protected)'
          : 'Stop Loss Hit (Automatic Exit)',
        currentSL,
      );
    } else if (isTP3Reached && autoCutExecutedRef.current !== `TP3_${symbol}_${direction}`) {
      autoCutExecutedRef.current = `TP3_${symbol}_${direction}`;
      handleCutTrade('Target 3 Achieved (4.0R Runner Exit)', tp3);
    } else if (isTP2Reached && autoCutExecutedRef.current !== `TP2_${symbol}_${direction}`) {
      autoCutExecutedRef.current = `TP2_${symbol}_${direction}`;
      handleCutTrade('Target 2 Achieved (2.5R Full TP Exit)', tp2);
    }
  }, [
    isSLReached,
    isTP3Reached,
    isTP2Reached,
    isPositionCut,
    symbol,
    direction,
    isTrailingSLActive,
    currentSL,
    tp2,
    tp3,
    signal,
  ]);

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
    isPositionCut ||
    isTP2Reached ||
    isTP3Reached ||
    Boolean(
      signal &&
      (signal.state === 'SL_HIT' ||
        signal.state === 'TP2_HIT' ||
        signal.state === 'TP1_HIT' ||
        signal.state === 'TP3_HIT'),
    );

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
          runningPnL >= 0 ? 'bg-emerald-500' : 'bg-rose-500'
        }`}
      />

      {/* Header Bar with Live Timestamps & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            </span>
            <h3 className="text-xs font-black uppercase tracking-wider font-mono flex items-center gap-1.5 text-white">
              <Zap className="w-4 h-4 text-cyan-400" />
              ACTIVE RUNNING POSITION TRACKER
            </h3>
          </div>

          <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700 font-mono font-bold">
            {symbol}
          </span>

          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono flex items-center gap-1 ${
              isBull
                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/80'
                : 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
            }`}
          >
            {isBull ? (
              <TrendingUp className="w-3.5 h-3.5" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" />
            )}
            {isOptionMode && !isCrypto
              ? `${optionData?.contractName || (isBull ? `${symbol} CE` : `${symbol} PE`)}`
              : `${direction} SPOT`}
          </span>

          {/* Mode Switcher Toggle */}
          {!isCrypto && (
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
            ENTRY: {formatDateTimeIST(entryDate)}
          </span>

          <span
            className="bg-slate-900 border border-slate-800 px-2.5 py-1 rounded text-amber-300 flex items-center gap-1 font-bold"
            suppressHydrationWarning
          >
            <Timer className="w-3.5 h-3.5 text-amber-400" />
            {isMarketOpen ? `ELAPSED: ${formattedElapsed}` : `SESSION DURATION: 45m`}
          </span>
        </div>
      </div>

      {/* Option Strike Selector Banner (If Option Mode Active) */}
      {isOptionMode && !isCrypto && optionData && (
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/60 to-slate-900 border border-indigo-500/40 rounded-xl p-3 font-mono space-y-2 text-xs shadow-inner">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="bg-cyan-500 text-slate-950 px-2 py-0.5 rounded text-[11px] font-black tracking-wide">
                RECOMMENDED CONTRACT
              </span>
              <strong className="text-white text-sm font-black tracking-wider">
                {optionData.contractName}
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
        {/* 1. Realized or Unrealized P&L */}
        {(() => {
          const isClosed = isPositionCut && !!closedTradeSummary;
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
                    : isOptionMode && !isCrypto
                      ? 'UNREALIZED RUNNING OPTION P&L'
                      : 'UNREALIZED RUNNING SPOT P&L'}
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
              <span className="text-[10px] text-slate-300 block mt-1.5 font-bold">
                {isClosed ? (
                  <span className="text-slate-400 block mt-0.5">
                    Exited @ {currencySymbol}
                    {closedTradeSummary.exitPrice.toFixed(2)} ({closedTradeSummary.reason}) • Logged
                    to Institutional Trade Journal
                  </span>
                ) : isOptionMode && !isCrypto ? (
                  <>
                    <span className={priceDifference >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      Option LTP: {currencySymbol}
                      {effectiveCurrentPrice.toFixed(2)} (Entry: {currencySymbol}
                      {effectiveEntryPrice.toFixed(2)} | {priceDifference >= 0 ? '+' : ''}
                      {priceDifference.toFixed(2)} pts)
                    </span>
                    <span className="text-slate-500 mx-1">•</span>
                    <span className="text-slate-400">
                      Spot CMP: {currencySymbol}
                      {currentCMP.toFixed(2)} ({isBull ? 'Long' : 'Short'} Entry: {currencySymbol}
                      {spotEntryPrice.toFixed(2)})
                    </span>
                  </>
                ) : (
                  <>
                    <span className={priceDifference >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {isBull ? '🟢 LONG / BULLISH' : '🔻 SHORT / BEARISH'}:{' '}
                      {priceDifference >= 0 ? '+' : ''}
                      {priceDifference.toFixed(2)} pts
                    </span>
                    <span className="text-slate-500 mx-1">•</span>
                    <span className="text-slate-400">
                      CMP: {currencySymbol}
                      {currentCMP.toFixed(2)} (Entry: {currencySymbol}
                      {spotEntryPrice.toFixed(2)})
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
            {isOptionMode && !isCrypto && !isGold ? 'ACTIVE STRIKE & QTY' : 'CONTRACT QUANTITY'}
          </span>
          <span className="text-xl font-black text-cyan-300 block mt-1">
            {totalQuantity} {isCrypto ? 'BTC' : isGold ? 'oz' : 'Qty'}
          </span>
          <span className="text-[10px] text-indigo-300 font-bold block mt-0.5 truncate">
            {isOptionMode && !isCrypto && !isGold
              ? `⚡ ${optionData?.contractName || `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`} (Locked)`
              : isCrypto
                ? `0.2000 BTC Contract (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                : isGold
                  ? `10.0 oz Gold Spot (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                  : `${symbol === 'NIFTY' ? '1 Lot (65 Qty)' : '1 Lot'}`}
          </span>
        </div>

        {/* 3. Option Entry Premium */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
            {isOptionMode && !isCrypto ? 'ENTRY PREMIUM (LOCKED)' : 'SPOT ENTRY (LOCKED)'}
          </span>
          <span className="text-xl font-black text-white block mt-1">
            {currencySymbol}
            {effectiveEntryPrice.toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">
            {isOptionMode && !isCrypto
              ? `Spot: ${currencySymbol}${spotEntryPrice.toFixed(2)} | Margin: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : `Margin Used: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}${isCrypto ? ' (100x Leverage)' : ''}`}
          </span>
        </div>

        {/* 4. Active Stop Loss (With Trailing Profit Lock / BE Indicator) */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              {isProfitLocked
                ? 'TRAILING SL (PROFIT LOCKED)'
                : isOptionMode && !isCrypto
                  ? 'OPTION SL PREMIUM'
                  : 'STOP LOSS'}
            </span>
            {isProfitLocked ? (
              <span className="text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800/80 px-1.5 py-0.5 rounded font-bold">
                PROFIT LOCKED
              </span>
            ) : isBreakevenActive ? (
              <span className="text-[9px] bg-cyan-950 text-cyan-400 border border-cyan-800/80 px-1.5 py-0.5 rounded font-bold">
                BE ACTIVE
              </span>
            ) : null}
          </div>
          <span
            className={`text-xl font-black block mt-1 ${
              isProfitLocked
                ? 'text-emerald-400'
                : isBreakevenActive
                  ? 'text-cyan-400'
                  : 'text-rose-400'
            }`}
          >
            {currencySymbol}
            {currentSL.toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">
            {isProfitLocked
              ? `Locked Profit: +${currencySymbol}${lockedProfitAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (Risk Free)`
              : isBreakevenActive
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
            {isOptionMode && !isCrypto
              ? 'OPTION PREMIUM TARGET ROADMAP:'
              : 'TARGET PROGRESSION & MARKET TIMELINE:'}
          </span>
          <div className="flex items-center gap-3 text-[10px]">
            <span className={isTP1Reached ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
              TP1: {currencySymbol}
              {tp1.toFixed(2)} ({isTP1Reached ? '✅ HIT' : '+100%'})
            </span>
            <span className="text-slate-600">•</span>
            <span className={isTP2Reached ? 'text-teal-300 font-bold' : 'text-slate-400'}>
              TP2: {currencySymbol}
              {tp2.toFixed(2)} ({isTP2Reached ? '🎯 HIT' : '+250%'})
            </span>
            <span className="text-slate-600">•</span>
            <span className="text-slate-400">
              TP3: {currencySymbol}
              {tp3.toFixed(2)} (+400%)
            </span>
          </div>
        </div>

        {/* Progress Fill Bar */}
        <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800 relative">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              isTP2Reached
                ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                : isTP1Reached
                  ? 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                  : 'bg-cyan-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[9px] text-slate-500">
          <span>Session Entry: {formatDateTimeIST(entryDate)}</span>
          <span className="text-cyan-400 font-bold">
            {progressPercent.toFixed(1)}% to Full Target (TP2)
          </span>
          <span>Session Target Exit: {formatDateTimeIST(estCloseDate)}</span>
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
      {isPositionCut ? (
        <div className="w-full bg-slate-900/90 border border-slate-800 p-3 rounded-xl flex flex-wrap items-center justify-between gap-3 font-mono text-xs shadow-lg">
          <div className="flex items-center gap-2 text-slate-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              Position exited &amp; permanently logged in{' '}
              <strong>Institutional Trade Journal</strong>.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-cyan-400 font-bold bg-cyan-950/80 px-2.5 py-1 rounded border border-cyan-800/60">
              Awaiting Next Institutional SMC Signal
            </span>
          </div>
        </div>
      ) : (
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
                ? `Trailing SL Active (${currencySymbol}${trailingSL.toFixed(2)})`
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
              <XCircle className="w-4 h-4" />⚡ Exit Trade @ Market ({currencySymbol}
              {effectiveCurrentPrice.toFixed(2)})
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
