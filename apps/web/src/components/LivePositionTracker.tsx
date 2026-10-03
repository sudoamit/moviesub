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
  AlertCircle,
  Calendar,
  Timer,
  Moon,
  Sun,
  Flame,
  Radio,
  Sliders,
  Bot,
  Radar,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  ISignalSetup,
  calculateRiskDistance,
  calculateTargetR,
  validateTargetGeometry,
  DEFAULT_STRATEGY_RR_RATIOS,
  DEFAULT_OPTION_RR_RATIOS,
  TradingLifecycleState,
  PlannedTradeSetup,
  ActualExecutedTrade,
  shouldDisplayLiveTradeMetrics,
  resolveTradingLifecycleState,
  calculateExecutedPositionPnL,
  calculateExecutedPositionR,
  checkExecutionEligibility,
  isInstrumentLongOnly,
} from '@quant/shared';

interface LivePositionTrackerProps {
  symbol: string;
  timeframe?: string;
  selectedStrategy?: string;
  onSelectStrategy?: (strategy: any) => void;
  signal: ISignalSetup | null;
  livePrice: number;
  activePosition?: RunningPaperPosition | any | null;
  activeExecution?: any | null;
  onClosePosition?: ((positionId: string) => void) | ((exitPrice: number, pnl: number, r: number, reason: string) => void) | any;
}

interface RunningPaperPosition {
  id?: string;
  priceStatus?: 'LIVE' | 'STALE';
  priceStaleReason?: string;
  symbol: string;
  contractSymbol?: string;
  direction: 'BUY' | 'SELL';
  quantity?: number;
  entryPrice?: number;
  stopLoss?: number;
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
  timeframe = '15m',
  selectedStrategy = 'SMC',
  onSelectStrategy,
  signal,
  livePrice,
  activePosition,
  activeExecution: rawActiveExecution,
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

  const effectiveStrategy = (signal?.strategy || signal?.strategyMode || selectedStrategy || 'SMC').toUpperCase();
  const isSaiyanStrategy = effectiveStrategy.includes('SAIYAN');
  const activeStrategyLabel = isSaiyanStrategy ? 'Saiyan OCC' : 'SMC';

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
      const currentStrat = (selectedStrategy || signal?.strategy || 'SMC').toUpperCase();
      const match = bots.find(
        (b: any) =>
          ((b.symbol === symbol ||
            b.symbol === `${symbol}_SPOT` ||
            b.symbol.toUpperCase().replace(/_SPOT$/, '') === norm ||
            ((symbol === 'GOLD' || symbol === 'XAUUSD') && (b.symbol === 'XAUUSD' || b.symbol === 'GOLD'))) &&
          (b.strategy?.toUpperCase() === currentStrat || (currentStrat.includes('SAIYAN') && b.strategy?.toUpperCase().includes('SAIYAN')))),
      ) || bots.find(
        (b: any) =>
          b.symbol === symbol ||
          b.symbol === `${symbol}_SPOT` ||
          b.symbol.toUpperCase().replace(/_SPOT$/, '') === norm ||
          ((symbol === 'GOLD' || symbol === 'XAUUSD') && (b.symbol === 'XAUUSD' || b.symbol === 'GOLD')),
      );
      setBot(match || null);
    } catch {}
  }, [symbol, selectedStrategy, signal?.strategy]);

  useEffect(() => {
    fetchBot();
  }, [fetchBot]);

  const handleUpdateBotStrategy = async (newStrat: string) => {
    if (!bot) return;
    try {
      const res = await fetch(`${API_BASE}/api/algo-bots/${bot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: newStrat }),
      });
      if (res.ok) {
        const updated = await res.json();
        setBot(updated);
        if (onSelectStrategy && (newStrat === 'SAIYAN_OCC' || newStrat === 'SMC' || newStrat === 'HYBRID')) {
          onSelectStrategy(newStrat as any);
        }
        setManualCloseToast(`✓ Bot '${updated.name}' strategy updated to ${updated.strategy}`);
        setTimeout(() => setManualCloseToast(null), 5000);
      }
    } catch (err: any) {
      setManualCloseToast(`Failed to update bot strategy: ${err.message}`);
      setTimeout(() => setManualCloseToast(null), 5000);
    }
  };

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
            ? `🤖 Bot '${updated.name}' ACTIVATED (Strategy: ${updated.strategy || 'SMC'}, Auto-Execute: ${updated.autoExecutePaper ? 'ON' : 'OFF'})`
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

  // Canonical Domain Execution Eligibility:
  // Spot instruments (BTCUSDT_SPOT, etc.) are strictly LONG-ONLY.
  // Bearish setups on spot instruments are not eligible for execution.
  const { executionEligible, canExecute, reason: executionIneligibilityReason } = useMemo(() => {
    return checkExecutionEligibility({
      symbol,
      direction: effectiveDirection,
      isOptionMode,
      instrumentType: (signal as any)?.instrumentType,
    });
  }, [symbol, effectiveDirection, isOptionMode, signal]);

  const isSpotInstrument = isInstrumentLongOnly({
    symbol,
    isOptionMode,
    instrumentType: (signal as any)?.instrumentType,
  });
  const isExecutionBlocked = !canExecute;
  const positionLockKey = `${symbol}_${effectiveDirection}`;
  const executionEntryTimeStorageKey = `quant_running_entry_time_${positionLockKey}`;

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

  // Authoritative Position Source of Truth: ONLY an open backend position is treated as an active trade.
  // A detected SMC setup is NOT a trade until order execution and position creation.
  const isPositionActive = Boolean(
    paperPosition &&
      (paperPosition.status === 'OPEN' ||
        paperPosition.status === 'PARTIALLY_CLOSED' ||
        paperPosition.status === 'ACTIVE' ||
        (!paperPosition.status && Number(paperPosition.entryPrice) > 0 && !isPositionCut)),
  );
  const hasActiveTrade = isPositionActive;
  const [isPlacingOrder, setIsPlacingOrder] = useState<boolean>(false);
  const [orderRejectionReason, setOrderRejectionReason] = useState<string | null>(null);

  const [accountCapital, setAccountCapital] = useState<number>(0);

  const fetchPaperPosition = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/paper-trading/portfolio`);
      if (!res.ok) return;
      const data = await res.json();
      if (Number(data?.initialCapital) > 0) setAccountCapital(Number(data.initialCapital));
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
          // The BTC perpetual is a separate instrument from BTC spot (and vice versa).
          (p.symbol === 'BTCUSDT_PERP') === (symbol.toUpperCase() === 'BTCUSDT_PERP') &&
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
  const spotStorageKey = `quant_locked_spot_entry_v2_${setupKey}`;
  const strikeStorageKey = `quant_locked_strike_v2_${setupKey}`;

  // Initial spot entry should strictly match paper position entry (if open) or signal's optimal entry price
  const paperEntryPrice = paperPosition ? Number(paperPosition.entryPrice) : null;
  const initialSpotCandidate =
    paperEntryPrice && isSaneSpot(symbol, paperEntryPrice)
      ? paperEntryPrice
      : isSaneSpot(symbol, rawSignalOptimal)
        ? rawSignalOptimal
        : isSaneSpot(symbol, rawLivePrice)
          ? rawLivePrice
          : 0; // No fabricated spot: without a position, signal or live price there is no entry candidate.

  const [lockedSpotEntry, setLockedSpotEntry] = useState<number>(initialSpotCandidate);

  const lockedSpotRef = React.useRef<number>(lockedSpotEntry);

  // 1. Authoritative Current Market Price (CMP) strictly from live provider feed
  const currentCMP =
    livePrice && isSaneSpot(symbol, livePrice)
      ? livePrice
      : rawLivePrice && isSaneSpot(symbol, rawLivePrice)
        ? rawLivePrice
        : 0;

  // 2. Strategy Underlying Trigger Price (distinct from current live spot)
  const underlyingTriggerPrice =
    paperEntryPrice && isSaneSpot(symbol, paperEntryPrice)
      ? paperEntryPrice
      : isSaneSpot(symbol, rawSignalOptimal)
        ? rawSignalOptimal
        : lockedSpotEntry > 0 && isSaneSpot(symbol, lockedSpotEntry)
          ? lockedSpotEntry
          : currentCMP;

  // spotEntryPrice alias for trade-math calculations
  const spotEntryPrice = underlyingTriggerPrice;

  // Compute and Freeze Active Strike Price so it NEVER automatically switches mid-trade
  const defaultStrike = useMemo(() => {
    if (symbol === 'NIFTY') return Math.round(spotEntryPrice / 50) * 50;
    if (symbol === 'BANKNIFTY') return Math.round(spotEntryPrice / 100) * 100;
    return Math.round(spotEntryPrice);
  }, [symbol, spotEntryPrice]);

  const [lockedStrike, setLockedStrike] = useState<number>(defaultStrike);

  const activeStrike = lockedStrike || defaultStrike;
  const strikeKey = String(activeStrike);
  const lockStorageKey = `quant_locked_opt_entry_v2_${setupKey}_${strikeKey}`;

  // Lock Initial Entry Prices so they NEVER change during a running trade
  const [lockedEntryPremium, setLockedEntryPremium] = useState<number>(0);

  const lockedEntryRef = React.useRef<number>(lockedEntryPremium);
  useEffect(() => {
    lockedEntryRef.current = lockedEntryPremium;
  }, [lockedEntryPremium]);

  // PLANNED vs ACTUAL: once an option position exists, every value comes from the filled position
  // (actual fill premium, initial stop, targets). Before a fill, values are the backend's planned levels.
  const filledOptionPosition: any =
    paperPosition && isOptionMode && !isCrypto && !isGold ? paperPosition : null;
  const optionEntryPremium = filledOptionPosition
    ? Number(filledOptionPosition.entryPrice) || 0
    : lockedEntryRef.current > 0
      ? lockedEntryRef.current
      : lockedEntryPremium > 0
        ? lockedEntryPremium
        : optionData?.plannedEntryPremium || 0; // No fabricated premium: 0 means no planned premium yet.

  // While an option position is open, everything shown about "the contract" is the HELD contract: its own
  // server-valued premium, strike and type. The smart-strike recommendation follows the latest signal and can be
  // a different strike (e.g. holding 22550 PE while 22500 PE is recommended), so it must not be mixed in.
  const heldOptionContract: string | null = filledOptionPosition?.contractSymbol || null;
  const heldOptionMatch = heldOptionContract ? heldOptionContract.match(/(\d+(?:\.\d+)?)\s+(CE|PE)/i) : null;
  const displayStrike = heldOptionMatch ? Number(heldOptionMatch[1]) : activeStrike;
  const displayOptType = heldOptionMatch ? heldOptionMatch[2].toUpperCase() : isBull ? 'CE' : 'PE';
  const displayContract: string =
    heldOptionContract ||
    (optionData?.recommendedStrike === activeStrike && optionData?.contractName
      ? optionData.contractName
      : `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`);
  // Greeks / expiry from the recommendation are only valid when it is the held contract.
  const optionDataMatchesHeld = !heldOptionContract || optionData?.contractName === heldOptionContract;

  const liveOptionPremium = filledOptionPosition
    ? Number(filledOptionPosition.currentPrice) || optionEntryPremium
    : optionData?.optionLtp || optionEntryPremium;

  // 3. Trigger Condition Evaluation
  // For Options: entry triggers strictly according to Option Premium within +/- 1% of Planned Entry Premium.
  // In SSR / before option data loads, falls back to underlying trigger level.
  const isOptionTriggerSatisfied =
    isOptionsAsset &&
    (optionEntryPremium > 0 && liveOptionPremium > 0
      ? Math.abs(liveOptionPremium - optionEntryPremium) / optionEntryPremium <= 0.01
      : currentCMP > 0 && underlyingTriggerPrice > 0 && (isBull ? currentCMP >= underlyingTriggerPrice : currentCMP <= underlyingTriggerPrice));

  const isSpotTriggerSatisfied =
    !isOptionsAsset &&
    (isBull
      ? currentCMP > 0 && underlyingTriggerPrice > 0 && currentCMP >= underlyingTriggerPrice
      : currentCMP > 0 && underlyingTriggerPrice > 0 && currentCMP <= underlyingTriggerPrice);

  const isTriggerSatisfied =
    hasActiveTrade || (isOptionsAsset ? isOptionTriggerSatisfied : isSpotTriggerSatisfied);

  // "Ready for execution" means the setup CAN be executed (manually, with the button). Whether the bot places it
  // automatically depends on the bot's own settings; list every reason it will not, so the card never implies an
  // automatic trade that is not going to happen.
  const autoTradeBlockers: string[] = (() => {
    if (!bot) return ['No bot is configured for this symbol'];
    const reasons: string[] = [];
    if (!bot.isActive) reasons.push('the bot is switched off');
    if (!bot.autoExecutePaper) reasons.push('auto-trading is OFF for this bot (paused)');
    const botStrategy = String(bot.strategy || 'SMC').toUpperCase().includes('SAIYAN') ? 'SAIYAN_OCC' : 'SMC';
    const signalStrategy = effectiveStrategy.includes('SAIYAN') ? 'SAIYAN_OCC' : 'SMC';
    if (signal && botStrategy !== signalStrategy) {
      reasons.push(`the bot trades ${botStrategy === 'SMC' ? 'SMC' : 'Saiyan'} signals, this is a ${signalStrategy === 'SMC' ? 'SMC' : 'Saiyan'} signal`);
    }
    const score = Number((signal as any)?.score);
    const minScore = Number(bot.minScore);
    if (Number.isFinite(score) && Number.isFinite(minScore) && score < minScore) {
      reasons.push(`signal score ${score} is below the bot minimum of ${minScore}`);
    }
    return reasons;
  })();

  // Spot / futures / options market entries fill at the live market price. Once price has run so far toward TP1
  // that TP1 keeps less than half of the setup's planned R, or has already breached stop or TP1, the entry is missed:
  // executing now would be a chase with an unacceptable risk/reward degradation.
  const entryMissedReason: string | null = (() => {
    // An active filled position or already closed position is never a missed entry
    if (hasActiveTrade || paperPosition?.status === 'CLOSED' || !signal || !executionEligible) return null;

    // 1. Options setup missed entry evaluation
    if (isOptionsAsset) {
      const plannedSpotEntry = Number((signal as any)?.entryZone?.optimal) || 0;
      const spotSl = Number(signal?.stopLoss) || 0;
      const spotTp1 = Number((signal as any)?.takeProfits?.tp1 ?? (signal as any)?.tp1) || 0;

      // Check underlying spot boundary invalidations if CMP is available
      if (currentCMP > 0 && plannedSpotEntry > 0 && spotSl > 0 && spotTp1 > 0) {
        if (isBull) {
          if (currentCMP <= spotSl) {
            return `Underlying spot (${nativeCurrency}${currentCMP}) hit stop loss (${nativeCurrency}${spotSl}) before option entry was filled.`;
          }
          if (currentCMP >= spotTp1) {
            return `Underlying spot (${nativeCurrency}${currentCMP}) reached TP1 (${nativeCurrency}${spotTp1}) before option entry was filled.`;
          }
        } else {
          if (currentCMP >= spotSl) {
            return `Underlying spot (${nativeCurrency}${currentCMP}) hit stop loss (${nativeCurrency}${spotSl}) before option entry was filled.`;
          }
          if (currentCMP <= spotTp1) {
            return `Underlying spot (${nativeCurrency}${currentCMP}) reached TP1 (${nativeCurrency}${spotTp1}) before option entry was filled.`;
          }
        }
      }

      // Check option premium runaway or targets if option premium quotes exist
      if (optionEntryPremium > 0 && liveOptionPremium > 0) {
        // If option premium has surged >= 5% above planned entry, entry is missed (avoid chasing premium)
        if (liveOptionPremium >= optionEntryPremium * 1.05) {
          return `Option premium (${currencySymbol}${liveOptionPremium}) moved > 5% above planned entry (${currencySymbol}${optionEntryPremium}, +${(((liveOptionPremium - optionEntryPremium) / optionEntryPremium) * 100).toFixed(1)}%). Chasing entry is prohibited.`;
        }
        // If option TP1 is reached before fill
        if (optionData?.plannedTp1 && liveOptionPremium >= optionData.plannedTp1) {
          return `Option premium (${currencySymbol}${liveOptionPremium}) reached Target 1 (${currencySymbol}${optionData.plannedTp1}) before entry.`;
        }
        // If option Stop Loss is breached before fill
        if (optionData?.plannedSl && liveOptionPremium <= optionData.plannedSl) {
          return `Option premium (${currencySymbol}${liveOptionPremium}) hit Stop Loss (${currencySymbol}${optionData.plannedSl}) before entry.`;
        }
      }
      return null;
    }

    // 2. Spot / crypto / linear setup missed entry evaluation
    if (!(currentCMP > 0)) return null;
    const plannedEntry = Number((signal as any)?.entryZone?.optimal) || 0;
    const sl = Number(signal?.stopLoss) || 0;
    const tp1Level = Number((signal as any)?.takeProfits?.tp1 ?? (signal as any)?.tp1) || 0;
    if (!(plannedEntry > 0 && sl > 0 && tp1Level > 0)) return null;
    // Only judge well-formed setups (stop and TP1 on opposite sides of the planned entry).
    const wellFormed = isBull ? sl < plannedEntry && tp1Level > plannedEntry : sl > plannedEntry && tp1Level < plannedEntry;
    if (!wellFormed) return null;
    const risk = isBull ? currentCMP - sl : sl - currentCMP;
    const reward = isBull ? tp1Level - currentCMP : currentCMP - tp1Level;
    const plannedRr = Math.abs(tp1Level - plannedEntry) / Math.abs(plannedEntry - sl);
    const minRr = plannedRr * 0.5;
    if (risk <= 0) return `Price ${currentCMP} is already beyond the stop ${sl}.`;
    if (reward <= 0) return `Price ${currentCMP} is already beyond TP1 ${tp1Level}.`;
    // Price still inside the signal's own entry zone is a valid entry, not a chase.
    const zMin = Number((signal as any)?.entryZone?.min) || 0;
    const zMax = Number((signal as any)?.entryZone?.max) || 0;
    const insideEntryZone = zMin > 0 && zMax >= zMin && currentCMP >= zMin && currentCMP <= zMax;
    if (!insideEntryZone && reward / risk < minRr) {
      return `Price ${currentCMP} has moved ${Math.abs(currentCMP - plannedEntry).toFixed(2)} away from the planned entry ${plannedEntry}: TP1 would pay only ${(reward / risk).toFixed(2)}R of a planned ${plannedRr.toFixed(2)}R.`;
    }
    return null;
  })();
  const isEntryMissed = entryMissedReason !== null;

  const distanceToTrigger = isOptionsAsset
    ? optionEntryPremium > 0 && liveOptionPremium > 0
      ? Math.abs(liveOptionPremium - optionEntryPremium)
      : 0
    : currentCMP > 0 && underlyingTriggerPrice > 0
      ? Math.abs(currentCMP - underlyingTriggerPrice)
      : 0;

  // Options: the backend decides eligibility (it requires a live option quote from the execution feed).
  // Fail closed until the backend has explicitly said the contract is eligible.
  const isBackendOptionEligible = !isOptionsAsset || optionData?.executionEligible === true;
  // Why a setup is NOT ELIGIBLE: structurally (spot long-only) or operationally (no live option quote).
  const isStructurallyIneligible = !executionEligible;
  const operationalIneligibilityReason: string =
    optionData?.ineligibilityReasons?.[0] || 'No live option quote from the execution feed.';

  // The latest bot execution for a symbol can belong to an earlier setup (e.g. a finished trade). It only
  // describes THIS setup when it was produced by this signal (same signal candle time and direction), or when
  // it is backing the currently open position. Otherwise a stale EXECUTED/FAILED record would override the
  // current signal's state (e.g. show READY FOR EXECUTION on a bearish, non-executable spot setup).
  const activeExecution = useMemo(() => {
    const exec: any = rawActiveExecution;
    if (!exec) return null;
    if (hasActiveTrade) return exec;
    const sigTime =
      typeof (signal as any)?.canonicalCandleTime === 'number'
        ? (signal as any).canonicalCandleTime
        : signal?.timestamp
          ? new Date(signal.timestamp).getTime()
          : null;
    // An EXECUTED record with no open position is a finished (or orphaned) trade: it can never describe a
    // setup that has not been traded.
    if (exec.state === 'EXECUTED') return null;
    const execTime = exec.signalTimestamp ? new Date(exec.signalTimestamp).getTime() : null;
    if (sigTime !== null && execTime !== null && sigTime !== execTime) return null;
    if (exec.direction && signal?.direction && String(exec.direction) !== String(signal.direction)) return null;
    return exec;
  }, [rawActiveExecution, hasActiveTrade, signal]);

  // Strict Authoritative Trading Lifecycle State Model
  const lifecycleState: TradingLifecycleState = useMemo(() => {
    return resolveTradingLifecycleState({
      hasActivePosition: hasActiveTrade,
      positionStatus: paperPosition?.status,
      isPositionClosed: isPositionCut && Boolean(closedTradeSummary),
      isPlacingOrder: isPlacingOrder || activeExecution?.state === 'EXECUTING' || activeExecution?.state === 'RESERVED',
      executionState: activeExecution?.state,
      orderRejectionReason:
        orderRejectionReason ||
        (activeExecution?.state === 'FAILED_FINAL' || activeExecution?.state === 'FAILED_RETRYABLE'
          ? activeExecution?.failureReason || activeExecution?.failureReasonCode || 'Broker Rejected Order'
          : null),
      hasSignal: Boolean(signal),
      isTriggerSatisfied,
      // Structural ineligibility (e.g. a spot short) applies immediately. Operational ineligibility
      // (no live option feed) only blocks once the trigger is met: until then the setup is WAITING,
      // and it can never become READY without the backend's eligibility.
      executionEligible: executionEligible && !isEntryMissed && (!isTriggerSatisfied || isBackendOptionEligible),
      canExecute: canExecute && !isEntryMissed && (!isTriggerSatisfied || isBackendOptionEligible),
    });
  }, [
    hasActiveTrade,
    paperPosition?.status,
    isPositionCut,
    closedTradeSummary,
    isPlacingOrder,
    activeExecution?.state,
    activeExecution?.failureReason,
    activeExecution?.failureReasonCode,
    orderRejectionReason,
    signal,
    isTriggerSatisfied,
    executionEligible,
    canExecute,
    isBackendOptionEligible,
    isEntryMissed,
  ]);

  const canDisplayLiveMetrics = shouldDisplayLiveTradeMetrics(lifecycleState);

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
        // Only a real signal defines a setup worth locking; never persist values for a signal-less view.
        if (signal) localStorage.setItem(spotStorageKey, String(validSpot));
      }

      lockedSpotRef.current = validSpot;
      setLockedSpotEntry(validSpot);

      const savedStrike = localStorage.getItem(strikeStorageKey);
      const validStrike =
        savedStrike && Number(savedStrike) > 0 ? Number(savedStrike) : defaultStrike;
      setLockedStrike(validStrike);
      if (validStrike > 0 && signal) {
        localStorage.setItem(strikeStorageKey, String(validStrike));
      }

      const savedOpt = localStorage.getItem(lockStorageKey);
      let initialOpt = savedOpt ? Number(savedOpt) : 0;
      // Sanity check: If NIFTY entry premium is corrupted with inflated ITM value (> 350) or stale scraper quote (< 10)
      if (symbol === 'NIFTY' && (initialOpt > 350 || (initialOpt > 0 && initialOpt < 10.0))) {
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
  ]);

  const [isRefreshingScan, setIsRefreshingScan] = useState<boolean>(false);

  const handleForceRescan = async () => {
    setIsRefreshingScan(true);
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('quant_rescan_requested', {
            detail: { symbol, reason: 'MANUAL_RESCAN_REQUEST' },
          }),
        );
      }
    } catch {}
    setTimeout(() => {
      setIsRefreshingScan(false);
    }, 1000);
  };

  // When an entry is missed, immediately purge locked setup parameters from localStorage and notify scanner
  useEffect(() => {
    if (isEntryMissed && !hasActiveTrade && typeof window !== 'undefined') {
      localStorage.removeItem(spotStorageKey);
      localStorage.removeItem(strikeStorageKey);
      localStorage.removeItem(lockStorageKey);
      setLockedSpotEntry(0);
      setLockedEntryPremium(0);
      lockedSpotRef.current = 0;
      lockedEntryRef.current = 0;

      window.dispatchEvent(
        new CustomEvent('quant_rescan_requested', {
          detail: { symbol, reason: 'ENTRY_MISSED' },
        }),
      );
    }
  }, [isEntryMissed, hasActiveTrade, spotStorageKey, strikeStorageKey, lockStorageKey, symbol]);

  // Periodic background check to look for a new setup while in missed entry standby
  useEffect(() => {
    if (!isEntryMissed || hasActiveTrade || typeof window === 'undefined') return;
    const interval = setInterval(() => {
      window.dispatchEvent(
        new CustomEvent('quant_rescan_requested', {
          detail: { symbol, reason: 'POLL_NEW_SETUP' },
        }),
      );
    }, 15000);
    return () => clearInterval(interval);
  }, [isEntryMissed, hasActiveTrade, symbol]);

  // Fetch Live Option Smart Strike Data & Locked Entry Premium
  useEffect(() => {
    if (!isOptionsAsset) return;
    let isMounted = true;

    const fetchOptionData = async () => {
      try {
        // 1. Fetch the option setup. The backend uses its own live spot; only the strategy trigger is sent.
        const triggerParam =
          underlyingTriggerPrice > 0 ? `&underlyingTriggerPrice=${underlyingTriggerPrice}` : '';
        const resLive = await fetch(
          `${API_BASE}/api/options/smart-strike?symbol=${symbol}&direction=${direction}${triggerParam}&strike=${activeStrike}&triggerMode=OPTION_PREMIUM`,
        );
        const dataLive = await resLive.json();
        if (isMounted && dataLive && (dataLive.contractName || dataLive.underlyingSymbol)) {
          setOptionData(dataLive);
        }

        // 2. Lock initial entry premium calculated strictly at trigger scenario
        const plannedPremium = dataLive?.plannedEntryPremium || dataLive?.optionEntryPremium;
        if (!lockedEntryRef.current || lockedEntryRef.current === 0) {
          if (plannedPremium && plannedPremium > 0) {
            lockedEntryRef.current = plannedPremium;
            setLockedEntryPremium(plannedPremium);
            if (typeof window !== 'undefined') {
              localStorage.setItem(lockStorageKey, String(plannedPremium));
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
  }, [symbol, direction, currentCMP, underlyingTriggerPrice, activeStrike, isOptionsAsset, lockStorageKey]);

  // Base Standard Sizing: 65 Qty (1 Lot) for NIFTY, 15 Qty (1 Lot) for BANKNIFTY, 0.01 for BTC, 1 for Gold/Equities
  // BTC perpetual: sized by risk like the perp bot - PERP_RISK_PERCENT of capital lost at the stop,
  // floored to the 0.001 BTC contract step and capped at 5 BTC. Falls back to 0.01 BTC until capital is known.
  const PERP_RISK_PERCENT = 0.5;
  const perpRiskQty = (() => {
    if (symbol.toUpperCase() !== 'BTCUSDT_PERP' || accountCapital <= 0) return 0;
    const entry = Number((signal as any)?.entryZone?.optimal) || 0;
    const sl = Number(signal?.stopLoss) || 0;
    const fx = (paperPosition as any)?.fxRateUsed ?? 92.5;
    const riskPerBtcInr = Math.abs(entry - sl) * fx;
    if (!(entry > 0) || !(sl > 0) || riskPerBtcInr <= 0) return 0;
    const qty = Math.floor(((accountCapital * PERP_RISK_PERCENT) / 100 / riskPerBtcInr) * 1000) / 1000;
    return Math.min(5, qty);
  })();
  const lotSize =
    symbol === 'NIFTY'
      ? 65
      : symbol === 'BANKNIFTY'
        ? 15
        : perpRiskQty > 0
          ? perpRiskQty
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

  // Authoritative strategy target configuration and R-multiples strictly sourced from strategy/backend
  const authoritativeRR1 = isOptionMode && !isCrypto && !isGold
    ? (optionData?.rr1 ?? signal?.rr1 ?? DEFAULT_OPTION_RR_RATIOS.rr1)
    : (signal?.rr1 ?? signal?.riskRewardRatios?.rr1 ?? DEFAULT_STRATEGY_RR_RATIOS.rr1);
  const authoritativeRR2 = isOptionMode && !isCrypto && !isGold
    ? (optionData?.rr2 ?? signal?.rr2 ?? DEFAULT_OPTION_RR_RATIOS.rr2)
    : (signal?.rr2 ?? signal?.riskRewardRatios?.rr2 ?? DEFAULT_STRATEGY_RR_RATIOS.rr2);
  const authoritativeRR3 = isOptionMode && !isCrypto && !isGold
    ? (optionData?.rr3 ?? signal?.rr3 ?? DEFAULT_OPTION_RR_RATIOS.rr3)
    : (signal?.rr3 ?? signal?.riskRewardRatios?.rr3 ?? DEFAULT_STRATEGY_RR_RATIOS.rr3);
  const authoritativeMaxR = isOptionMode && !isCrypto && !isGold
    ? (optionData?.maxPotentialR ?? signal?.maxPotentialR ?? DEFAULT_OPTION_RR_RATIOS.maxPotentialR)
    : (signal?.maxPotentialR ?? DEFAULT_STRATEGY_RR_RATIOS.maxPotentialR);

  // Stop Loss & Targets in NIFTY/BANKNIFTY Option Premium. The browser never invents option levels:
  // actual levels come from the position, planned levels from the backend smart-strike response.
  const optionStopLoss = filledOptionPosition
    ? Number(filledOptionPosition.initialStopLoss ?? filledOptionPosition.stopLoss) || 0
    : Number(optionData?.plannedStopPremium ?? optionData?.optionStopLoss) || 0;
  const optionRiskDistance =
    optionEntryPremium > 0 && optionStopLoss > 0 ? Math.abs(optionEntryPremium - optionStopLoss) : 0;

  const optionTP1 = filledOptionPosition
    ? Number(filledOptionPosition.target1) || 0
    : Number(optionData?.targets?.tp1 ?? optionData?.optionTarget1) || 0;
  const optionTP2 = filledOptionPosition
    ? Number(filledOptionPosition.target2) || 0
    : Number(optionData?.targets?.tp2 ?? optionData?.optionTarget2) || 0;
  const optionTP3 = filledOptionPosition
    ? Number(filledOptionPosition.target3) || 0
    : Number(optionData?.targets?.tp3 ?? optionData?.optionTarget3) || 0;
  // Active Effective Parameters (Option Mode vs Spot Mode)
  const effectiveEntryPrice = isOptionMode && !isCrypto && !isGold ? optionEntryPremium : spotEntryPrice;
  const effectiveCurrentPrice = isOptionMode && !isCrypto && !isGold ? liveOptionPremium : currentCMP;

  // STOPS ARE NEVER INVENTED OR TRAILED IN THE BROWSER.
  // - Filled position: the server's stops. initialStopLoss anchors risk/R; stopLoss is the live stop the server
  //   actually enforces (it moves only on the server: fee-adjusted breakeven after TP1, TP1 after TP2).
  // - Planned setup: the strategy's own stop, unmodified (option setups use the backend's planned premium stop).
  //   The server validates its geometry at order time; the browser does not clamp or default it.
  const stopSourcePosition: any = paperPosition || null;
  const plannedSL =
    isOptionMode && !isCrypto && !isGold ? optionStopLoss : Number(signal?.stopLoss) || 0;
  const serverInitialSL = stopSourcePosition
    ? Number(stopSourcePosition.initialStopLoss ?? stopSourcePosition.stopLoss) || 0
    : 0;
  const serverCurrentSL = stopSourcePosition ? Number(stopSourcePosition.stopLoss) || 0 : 0;

  const safeInitialSL = serverInitialSL > 0 ? serverInitialSL : plannedSL;
  const originalSL = safeInitialSL;
  const riskPerUnit = Math.abs(effectiveEntryPrice - originalSL);

  const currentSL = serverCurrentSL > 0 ? serverCurrentSL : originalSL;
  // "At breakeven" reflects the SERVER's stop (moved by the monitor after TP1 or via the breakeven endpoint).
  // Options are always bought, so their protected side is "above entry" regardless of the signal direction.
  const isLongForStop = isOptionMode && !isCrypto && !isGold ? true : isBull;
  const isBreakevenActive =
    Boolean(stopSourcePosition) &&
    currentSL > 0 &&
    effectiveEntryPrice > 0 &&
    (isLongForStop ? currentSL >= effectiveEntryPrice : currentSL <= effectiveEntryPrice);

  const isProfitLocked =
    isOptionMode && !isCrypto && !isGold
      ? currentSL > effectiveEntryPrice
      : isBull
        ? currentSL > effectiveEntryPrice
        : currentSL < effectiveEntryPrice;

  // FX rates from backend running position (Gold: USD/INR 87.5, BTC: USDT/INR 92.5)
  const cryptoFxRate = (paperPosition as any)?.fxRateUsed ?? (isGold ? 87.5 : isCrypto ? 92.5 : 1.0);

  // Read leverage from localStorage or default (1x for BTC spot & Indian indices, 5x for Gold CFD and BTC perp).
  // BTC spot never uses the saved leverage; the BTC perpetual does (capped at its 50x maximum).
  const isPerp = symbol.toUpperCase() === 'BTCUSDT_PERP';
  const defaultLeverage = isGold || isPerp ? 5 : 1;
  const [activeLeverage, setActiveLeverage] = React.useState<number>(defaultLeverage);
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('quant_risk_leverage');
      if (saved && !isNaN(Number(saved)) && Number(saved) > 1 && (!isCrypto || isPerp)) {
        setActiveLeverage(isPerp ? Math.min(50, Number(saved)) : Number(saved));
      } else {
        setActiveLeverage(defaultLeverage);
      }
    }
  }, [defaultLeverage, isCrypto, isPerp]);

  // Perp: the open position's leverage, else the saved leverage setting (1-50x), else the 5x default.
  const effectiveLeverage = isPerp
    ? ((paperPosition as any)?.leverage ? Number((paperPosition as any).leverage) : activeLeverage)
    : isCrypto
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

  // Single authoritative source of truth for targets: consume backend strategy prices
  const minTargetDist = isGold ? 12.0 : isCrypto ? 120.0 : 15.0;
  const targetRisk = Math.max(minTargetDist, riskPerUnit);

  const rawTP1 = Number(signal?.tp1 ?? signal?.takeProfits?.tp1);
  const rawTP2 = Number(signal?.tp2 ?? signal?.takeProfits?.tp2);
  const rawTP3 = Number(signal?.tp3 ?? signal?.takeProfits?.tp3);

  const validTP1 =
    rawTP1 > 0
      ? rawTP1
      : isBull
        ? Number((spotEntryPrice + targetRisk * authoritativeRR1).toFixed(2))
        : Number((spotEntryPrice - targetRisk * authoritativeRR1).toFixed(2));

  const validTP2 =
    rawTP2 > 0
      ? rawTP2
      : isBull
        ? Number((spotEntryPrice + targetRisk * authoritativeRR2).toFixed(2))
        : Number((spotEntryPrice - targetRisk * authoritativeRR2).toFixed(2));

  const validTP3 =
    rawTP3 > 0
      ? rawTP3
      : isBull
        ? Number((spotEntryPrice + targetRisk * authoritativeRR3).toFixed(2))
        : Number((spotEntryPrice - targetRisk * authoritativeRR3).toFixed(2));

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

  // P&L and R Multiple: Permitted and calculated ONLY for actual executed positions
  const runningPnL = canDisplayLiveMetrics
    ? (acct?.netPnlAccount !== undefined
        ? Number(acct.netPnlAccount)
        : (paperPosition as any)?.unrealizedPnL !== undefined
          ? Number((paperPosition as any).unrealizedPnL)
          : fallbackPnL)
    : 0;

  const runningRMultiple = canDisplayLiveMetrics
    ? ((paperPosition as any)?.unrealizedR !== undefined
        ? Number((paperPosition as any).unrealizedR)
        : riskPerUnit > 0
          ? Number((priceDifference / riskPerUnit).toFixed(2))
          : 0)
    : 0;

  const returnPercentage = canDisplayLiveMetrics && totalMarginUsed > 0
    ? Number(((runningPnL / totalMarginUsed) * 100).toFixed(2))
    : canDisplayLiveMetrics && effectiveEntryPrice > 0
      ? Number(((priceDifference / effectiveEntryPrice) * 100).toFixed(2))
      : 0;

  // 1. PLANNED SETUP (Calculated internally for order validation & execution planning, NEVER shown as active trade performance)
  const plannedSetup: PlannedTradeSetup = useMemo(() => {
    return {
      symbol,
      contractSymbol: isOptionMode && !isCrypto && !isGold
        ? (optionData?.contractName || `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`)
        : symbol,
      direction: effectiveDirection,
      underlyingTriggerPrice,
      currentSpotPrice: currentCMP,
      distanceToTrigger,
      isTriggerSatisfied,
      executionEligible,
      canExecute,
      plannedEntryPrice: effectiveEntryPrice,
      plannedStopLoss: safeInitialSL,
      plannedTargets: {
        tp1,
        tp2,
        tp3,
      },
      plannedQuantity: numericQty,
      plannedRiskAmount: maxRiskAmount,
      expiry: optionData?.expiryLabel,
      strike: activeStrike,
      optionType: isBull ? 'CE' : 'PE',
      status: lifecycleState,
    };
  }, [
    symbol,
    isOptionMode,
    isCrypto,
    isGold,
    optionData?.contractName,
    optionData?.expiryLabel,
    activeStrike,
    isBull,
    effectiveDirection,
    underlyingTriggerPrice,
    currentCMP,
    distanceToTrigger,
    isTriggerSatisfied,
    executionEligible,
    canExecute,
    effectiveEntryPrice,
    safeInitialSL,
    tp1,
    tp2,
    tp3,
    numericQty,
    maxRiskAmount,
    lifecycleState,
  ]);

  // 2. ACTUAL EXECUTED TRADE (Populated strictly from executed backend position/fill evidence)
  const actualTrade: ActualExecutedTrade | null = useMemo(() => {
    if (!hasActiveTrade || !paperPosition) return null;

    const executedEntry = Number(paperPosition.entryPrice || paperPosition.averageEntryPrice || effectiveEntryPrice);
    const executedStop = paperPosition.stopLoss ? Number(paperPosition.stopLoss) : currentSL;
    const executedQty = Number(paperPosition.quantity || numericQty);
    const currentPrice = effectiveCurrentPrice;

    // Realized or Unrealized P&L strictly computed from executed parameters
    const calculatedPnL = calculateExecutedPositionPnL({
      executedEntryPrice: executedEntry,
      currentPrice,
      executedQuantity: executedQty,
      direction: effectiveDirection,
      fxRate: isCrypto || isGold ? cryptoFxRate : 1.0,
    });

    const livePnL = acct?.netPnlAccount !== undefined
      ? Number(acct.netPnlAccount)
      : paperPosition.unrealizedPnL !== undefined
        ? Number(paperPosition.unrealizedPnL)
        : calculatedPnL;

    const liveR = (paperPosition as any)?.unrealizedR !== undefined
      ? Number((paperPosition as any).unrealizedR)
      : calculateExecutedPositionR({
          executedEntryPrice: executedEntry,
          executedStopLoss: executedStop,
          currentPrice,
          direction: effectiveDirection,
        });

    const pnlPct = totalMarginUsed > 0
      ? Number(((livePnL / totalMarginUsed) * 100).toFixed(2))
      : executedEntry > 0
        ? Number((((currentPrice - executedEntry) / executedEntry) * 100).toFixed(2))
        : 0;

    const posRisk = Number((Math.abs(executedEntry - executedStop) * executedQty * (isCrypto || isGold ? cryptoFxRate : 1.0)).toFixed(2));

    return {
      positionId: paperPosition.id || 'POS-ACTIVE',
      tradeId: paperPosition.id || (paperPosition as any).executionId || 'TRD-LIVE',
      symbol,
      contractSymbol: paperPosition.contractSymbol || (isOptionMode ? `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}` : symbol),
      direction: effectiveDirection,
      executedEntryPrice: executedEntry,
      executedStopLoss: executedStop,
      executedTargets: {
        tp1,
        tp2,
        tp3,
      },
      executedQuantity: executedQty,
      currentPrice,
      filledAt: paperPosition.entryTime || paperPosition.openedAt || new Date().toISOString(),
      status: (paperPosition.status as any) || 'ACTIVE',
      currentPnL: livePnL,
      pnlPercent: pnlPct,
      currentR: liveR,
      positionRisk: posRisk,
      canonicalRR: authoritativeRR2,
      marginUsed: totalMarginUsed,
      isProfitLocked,
      isBreakevenActive,
    };
  }, [
    hasActiveTrade,
    paperPosition,
    effectiveEntryPrice,
    currentSL,
    numericQty,
    effectiveCurrentPrice,
    effectiveDirection,
    isCrypto,
    isGold,
    cryptoFxRate,
    acct?.netPnlAccount,
    totalMarginUsed,
    authoritativeRR2,
    tp1,
    tp2,
    tp3,
    symbol,
    isOptionMode,
    activeStrike,
    isBull,
    isProfitLocked,
    isBreakevenActive,
  ]);

  // Development-only reconciliation check between frontend fallback and backend authoritative accounting
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && acct) {
      if (acct.netPnlAccount !== undefined && Math.abs(fallbackPnL - Number(acct.netPnlAccount)) > 5.0) {
        console.warn(
          `[FINANCIAL TRUTH RECONCILIATION] Backend net PnL (₹${acct.netPnlAccount}) differs from frontend fallback (₹${fallbackPnL}). Consuming authoritative backend value.`,
        );
      }
      if (
        (paperPosition as any)?.usedMargin !== undefined &&
        Math.abs(fallbackMargin - Number((paperPosition as any).usedMargin)) > 5.0
      ) {
        console.warn(
          `[FINANCIAL TRUTH RECONCILIATION] Backend margin used (₹${(paperPosition as any).usedMargin}) differs from frontend fallback (₹${fallbackMargin}). Consuming authoritative backend value.`,
        );
      }
    }
  }, [acct, fallbackPnL, fallbackMargin, paperPosition]);

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

  // Exits are priced by the backend from the validated live quote; the browser never sends an exit price.
  const handleCutTrade = async (reason: string, partialRatio: number = 1.0) => {
    if (!paperPosition || !(paperPosition as any).id) {
      setManualCloseToast('No active backend position to close.');
      setTimeout(() => setManualCloseToast(null), 4000);
      return;
    }

    const posId = (paperPosition as any).id;

    // Partial Scale-Out Cut (< 1.0)
    if (partialRatio < 1.0) {
      try {
        const res = await fetch(`${API_BASE}/api/paper-trading/positions/${posId}/scale-out`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ratio: partialRatio, reason }),
        });

        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.message || 'Scale out request failed');
        }

        const scaleOut = await res.json().catch(() => ({}));
        const legs = Array.isArray(scaleOut?.partialLegs) ? scaleOut.partialLegs : [];
        const filledAt = Number(legs[legs.length - 1]?.fillPrice);

        setIsAutoScaledOut(true);
        if (typeof window !== 'undefined') {
          localStorage.setItem(scaleoutStorageKey, 'true');
          window.dispatchEvent(
            new CustomEvent('quant_trade_scaleout', {
              detail: { symbol, positionId: posId, ratio: partialRatio, exitPrice: filledAt },
            }),
          );
        }

        setManualCloseToast(
          Number.isFinite(filledAt) && filledAt > 0
            ? `✨ Scaled out ${scaleOut.partialQty ?? ''} @ ${currencySymbol}${filledAt.toFixed(2)}. Runner active.`
            : `✨ Scale-out submitted.`,
        );
        setTimeout(() => setManualCloseToast(null), 6000);
        return;
      } catch (err: any) {
        setManualCloseToast(`SCALE OUT FAILED: ${err.message}`);
        setTimeout(() => setManualCloseToast(null), 8000);
        return;
      }
    }

    // Full Market Cut / Exit (100%)
    try {
      const res = await fetch(`${API_BASE}/api/paper-trading/positions/${posId}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
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
          new CustomEvent('quant_trade_closed', {
            detail: { ...summary, symbol, positionId: posId },
          }),
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

  // SL / TP3 exits are executed only by the backend position monitor at the validated live quote.
  // The browser never auto-closes (it would record the exit at the SL/TP level instead of the real fill).

  const handleExecutePaperOrder = async () => {
    if (isPlacingOrder) return;
    // Only a setup the lifecycle model marks READY (trigger satisfied AND execution eligible) may be sent.
    if (lifecycleState !== 'ready') {
      setOrderRejectionReason(
        lifecycleState === 'not_eligible'
          ? entryMissedReason || optionData?.ineligibilityReasons?.[0] || executionIneligibilityReason || 'Setup is not eligible for execution.'
          : 'Setup is not ready: the trigger condition has not been met.',
      );
      return;
    }
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

        // The server fills at its validated option quote. The premium shown to the user is sent only as a
        // sanity reference: the server rejects the order if the live premium has moved more than 5% from it.
        const referencePremium = liveOptionPremium;
        if (!(referencePremium > 0)) {
          throw new Error('No option premium available for this contract. Execution blocked.');
        }

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
          price: referencePremium,
          stopLoss: optionStopLoss,
          target1: optionTP1,
          target2: optionTP2,
          target3: optionTP3,
          leverage: 1,
          signalId: signal?.id,
        };
      } else {
        // Spot Equity / Crypto / Commodity (Long-Only); the BTC perpetual can also go short.
        if (!canExecute || (!isBull && !isPerp)) {
          throw new Error(
            executionIneligibilityReason ||
              `EXECUTION BLOCKED: Spot instrument '${symbol}' is long-only. Short selling spot is not permitted by exchange rules. BUY entries only.`,
          );
        }

        if (isSpotInstrument && effectiveLeverage > 1) {
          throw new Error(
            `Order Rejected [LEVERAGE_EXCEEDS_MAX]: Instrument ${symbol} does not support ${effectiveLeverage}x leverage. Maximum allowable leverage is 1x.`,
          );
        }

        payload = {
          symbol,
          direction: isPerp && !isBull ? 'SELL' : 'BUY',
          quantity: numericQty,
          orderType: 'MARKET',
          stopLoss: safeInitialSL,
          target1: tp1,
          target2: tp2,
          target3: tp3,
          leverage: effectiveLeverage,
          signalId: signal?.id,
          // Planned entry: the server refuses the order if price has run too far from it (chased entry).
          signalPrice: Number((signal as any)?.entryZone?.optimal) || undefined,
          instrumentType: 'SPOT',
        };
      }

      // Idempotency: one key per setup + attempt. Double clicks, retries and a second tab for the SAME setup send
      // the same key, so the server returns the existing position instead of opening a duplicate. The attempt
      // number advances only after a rejection, so a genuinely rejected order can be retried.
      const attemptKey = `quant_order_attempt_${setupKey}_${isOptionsAsset ? activeStrike : 'spot'}`;
      let attempt = 1;
      try {
        attempt = Number(localStorage.getItem(attemptKey)) || 1;
      } catch {}
      payload.idempotencyKey = `ui:${setupKey}:${isOptionsAsset ? activeStrike : 'spot'}:a${attempt}`;

      setOrderRejectionReason(null);
      const res = await fetch(`${API_BASE}/api/paper-trading/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errorMsg = errJson.message || 'Failed to place paper order';
        try {
          localStorage.setItem(attemptKey, String(attempt + 1));
        } catch {}
        setOrderRejectionReason(errorMsg);
        throw new Error(errorMsg);
      }

      setOrderRejectionReason(null);
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
      setOrderRejectionReason(err.message || 'Order Execution Failed');
      setManualCloseToast(`Order Execution Failed: ${err.message}`);
      setTimeout(() => setManualCloseToast(null), 8000);
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const handleReopenTrade = () => {
    setOrderRejectionReason(null);
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

  // Moves the stop to fee-adjusted breakeven ON THE SERVER; the displayed stop updates from the position.
  const handleToggleBreakeven = async () => {
    const posId = (paperPosition as any)?.id;
    if (!posId || isBreakevenActive) return;
    try {
      const res = await fetch(`${API_BASE}/api/paper-trading/positions/${posId}/breakeven`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Could not move stop to breakeven');
      setManualCloseToast(
        `🛡️ Server stop moved to fee-adjusted breakeven: ${currencySymbol}${Number(body.stopLoss).toFixed(2)}`,
      );
    } catch (err: any) {
      setManualCloseToast(`BREAKEVEN NOT SET: ${err.message}`);
    }
    setTimeout(() => setManualCloseToast(null), 6000);
  };

  const lockedStrikeLabel = useMemo(() => {
    if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') return '';
    return `${displayStrike} ${displayOptType}`;
  }, [displayStrike, displayOptType, symbol]);

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


  // No strategy signal and no position: there is no setup to show. Rendering one here used to display a
  // default BULLISH direction with a previously locked strike (e.g. "NIFTY 24200 CE" at spot 22,729).
  if (!signal && !hasActiveTrade && !(isPositionCut && closedTradeSummary)) {
    return (
      <div className="bg-[#111827]/95 border border-slate-800 rounded-xl p-5 font-mono">
        <div className="flex items-center gap-2 text-slate-300 text-xs font-bold uppercase tracking-wider">
          <Radio className="w-4 h-4 text-slate-500" />
          {activeStrategyLabel.toUpperCase()} • {symbol}
        </div>
        <p className="mt-2 text-sm text-slate-400">
          No active {activeStrategyLabel} signal for {symbol}. A trade setup appears here once the strategy produces one.
        </p>
      </div>
    );
  }

  // If entry was missed, remove that entry and render the dedicated "Scanning for New Setup" screen
  if (isEntryMissed && !hasActiveTrade) {
    return (
      <div className="bg-[#111827]/95 backdrop-blur-md border border-amber-500/40 rounded-xl p-6 shadow-2xl space-y-5 relative overflow-hidden font-mono">
        {/* Glow effect */}
        <div className="absolute -top-12 -right-12 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Radar className="w-5 h-5 text-amber-400 animate-spin" style={{ animationDuration: '4s' }} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-white text-sm font-black tracking-wide">
                  {symbol} • {activeStrategyLabel}
                </span>
                <span className="bg-amber-950/80 text-amber-300 border border-amber-800 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                  Entry Missed — Setup Removed
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Timeframe: <span className="text-cyan-300 font-semibold">{timeframe}</span> | Session:{' '}
                <span className={isMarketOpen ? 'text-emerald-400' : 'text-amber-400'}>{marketSessionLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleForceRescan}
              disabled={isRefreshingScan}
              className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 active:scale-95 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingScan ? 'animate-spin' : ''}`} />
              {isRefreshingScan ? 'Scanning...' : 'Scan For Setup Now'}
            </button>
          </div>
        </div>

        {/* Missed Entry Invalidation Banner & Explanation */}
        <div className="bg-amber-950/30 border border-amber-600/30 rounded-lg p-3.5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1 text-xs">
            <div className="text-amber-200 font-bold">
              Entry Window Invalidated — No-Chase Rule Enforced
            </div>
            <p className="text-slate-300 leading-relaxed font-sans">
              {entryMissedReason} To protect capital and preserve statistical edge, previous entry parameters have been purged. The engine is actively scanning for a fresh setup.
            </p>
          </div>
        </div>

        {/* Live Market Scanning Radar & Telemetry */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Authoritative Live CMP</span>
            <div className="text-xl font-black text-white flex items-center gap-1.5">
              <span>{nativeCurrency}{currentCMP > 0 ? currentCMP.toLocaleString() : '---'}</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            </div>
            <span className="text-[10px] text-slate-500">Live ticks streaming continuously</span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Scanner Engine</span>
            <div className="text-base font-bold text-cyan-300 flex items-center gap-1.5">
              <Radio className="w-4 h-4 text-cyan-400 animate-pulse" />
              <span>{isSaiyanStrategy ? 'Saiyan OCC Flow' : 'SMC Order Block & FVG'}</span>
            </div>
            <span className="text-[10px] text-cyan-500/80">Listening for multi-timeframe alignment</span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Next Setup State</span>
            <div className="text-base font-bold text-amber-300 flex items-center gap-1.5">
              <Search className="w-4 h-4 text-amber-400" />
              <span>SEARCHING FOR NEW SETUP</span>
            </div>
            <span className="text-[10px] text-slate-400">Auto-evaluating on new candle formations</span>
          </div>
        </div>

        {/* High-tech Radar Scanning Animation Strip */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
            </span>
            <span className="text-cyan-300 font-medium">Scanner Active:</span>
            <span>Watching liquidity sweeps & candle closures for {symbol}...</span>
          </div>
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            Status: STANDBY_SEEKING_SETUP
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
                  ACTIVE TRADE
                </>
              ) : lifecycleState === 'pending_order' ? (
                <>
                  <Clock className="w-4 h-4 text-amber-400 animate-spin" />
                  ORDER PENDING / SUBMITTED
                </>
              ) : lifecycleState === 'rejected' ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  ORDER REJECTED
                </>
              ) : lifecycleState === 'not_eligible' ? (
                <>
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                  {activeStrategyLabel.toUpperCase()} • {isStructurallyIneligible ? 'NO TRADE' : 'NOT ELIGIBLE'}
                </>
              ) : (
                <>
                  <Radio className="w-4 h-4 text-cyan-400" />
                  {activeStrategyLabel.toUpperCase()} TRADE SETUP
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
              {actualTrade?.tradeId ? ` • ID: ${actualTrade.tradeId.slice(-8)}` : ''}
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
            lifecycleState === 'not_eligible' ? (
              <span className="bg-slate-800 text-amber-300 border border-amber-700/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-amber-400" />
                {isEntryMissed ? 'ENTRY MISSED (PRICE MOVED AWAY)' : isStructurallyIneligible ? 'NO TRADE (SPOT LONG-ONLY)' : 'NOT ELIGIBLE (NO LIVE OPTION QUOTE)'}
              </span>
            ) : lifecycleState === 'rejected' ? (
              <span className="bg-rose-950/90 text-rose-300 border border-rose-700/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-rose-400" />
                ORDER REJECTED
              </span>
            ) : lifecycleState === 'pending_order' ? (
              <span className="bg-amber-950/90 text-amber-300 border border-amber-600 px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1 animate-pulse">
                <Clock className="w-3 h-3 text-amber-400" />
                ORDER PENDING
              </span>
            ) : lifecycleState !== 'ready' ? (
              <span className="bg-amber-950/80 text-amber-300 border border-amber-800/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1">
                <Clock className="w-3 h-3 text-amber-400" />
                {!isTriggerSatisfied ? 'POTENTIAL SETUP (WAITING FOR TRIGGER)' : 'POTENTIAL SETUP'}
              </span>
            ) : (
              <span className="bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1">
                <Zap className="w-3 h-3 text-cyan-400" />
                READY FOR EXECUTION
              </span>
            )
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
              : lifecycleState === 'pending_order'
                ? 'STATUS: ORDER SUBMITTED'
                : lifecycleState === 'rejected'
                  ? 'STATUS: ORDER REJECTED'
                  : lifecycleState === 'not_eligible'
                    ? (isEntryMissed ? 'STATUS: ENTRY MISSED' : isStructurallyIneligible ? 'STATUS: NOT ELIGIBLE (LONG-ONLY)' : 'STATUS: NOT ELIGIBLE (NO LIVE OPTION QUOTE)')
                    : lifecycleState === 'ready'
                      ? 'STATUS: READY FOR EXECUTION'
                      : 'STATUS: POTENTIAL SETUP'}
          </span>
        </div>
      </div>

      {/* Option Strike Selector Banner (If Option Mode Active) */}
      {isOptionMode && !isCrypto && !isGold && optionData && (
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/60 to-slate-900 border border-indigo-500/40 rounded-xl p-3 font-mono space-y-2 text-xs shadow-inner">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="bg-cyan-500 text-slate-950 px-2 py-0.5 rounded text-[11px] font-black tracking-wide">
                {heldOptionContract ? 'ACTIVE CONTRACT' : 'RECOMMENDED CONTRACT'}
              </span>
              <strong className="text-white text-sm font-black tracking-wider">{displayContract}</strong>
              <span className="text-slate-400 text-[11px]">
                ({optionDataMatchesHeld ? optionData.expiryLabel : (filledOptionPosition?.expiry || 'expiry n/a')})
              </span>
            </div>

            <div className="flex items-center gap-3 text-[11px]">
              {optionDataMatchesHeld && (
                <>
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
                </>
              )}
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                {isOptionMode ? 'Premium Outlay' : 'Margin'}: {currencySymbol}
                {totalMarginUsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({isCrypto ? 'No Cap' : '≤ ₹50k'})
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
        {/* 1. Realized/Unrealized P&L (Active Trade) or Clean Potential Setup Details */}
        {(() => {
          const isClosed = isPositionCut && !!closedTradeSummary;
          if (!hasActiveTrade && !isClosed) {
            const isNotEligible = lifecycleState === 'not_eligible';
            return (
              <div
                className={`p-3.5 rounded-xl col-span-2 sm:col-span-2 relative overflow-hidden ${
                  isNotEligible
                    ? 'bg-slate-900/90 border border-amber-500/40 shadow-amber-950/20 shadow-lg'
                    : lifecycleState === 'rejected'
                      ? 'bg-slate-900/90 border border-rose-500/40 shadow-rose-950/20 shadow-lg'
                      : lifecycleState === 'pending_order'
                        ? 'bg-slate-900/90 border border-amber-500/40 shadow-amber-950/20 shadow-lg'
                        : 'bg-slate-900/90 border border-cyan-500/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[10px] uppercase tracking-wider block font-bold flex items-center gap-1 ${
                      isNotEligible
                        ? 'text-amber-400'
                        : lifecycleState === 'rejected'
                          ? 'text-rose-400'
                          : lifecycleState === 'pending_order'
                            ? 'text-amber-400'
                            : 'text-cyan-400'
                    }`}
                  >
                    {isNotEligible ? (
                      <>
                        <ShieldAlert className="w-3 h-3 text-amber-400" />
                        {activeStrategyLabel.toUpperCase()} NO TRADE
                      </>
                    ) : lifecycleState === 'rejected' ? (
                      <>
                        <AlertTriangle className="w-3 h-3 text-rose-400" />
                        ORDER REJECTED
                      </>
                    ) : lifecycleState === 'pending_order' ? (
                      <>
                        <Clock className="w-3 h-3 text-amber-400 animate-spin" />
                        ORDER PENDING EXECUTION
                      </>
                    ) : (
                      <>
                        <Radio className="w-3 h-3 text-cyan-400" />
                        {activeStrategyLabel.toUpperCase()} POTENTIAL SETUP
                      </>
                    )}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                        isNotEligible
                          ? 'bg-slate-800 text-amber-300 border-amber-700/80'
                          : lifecycleState === 'rejected'
                            ? 'bg-rose-950/80 text-rose-300 border-rose-700/80'
                            : lifecycleState === 'pending_order'
                              ? 'bg-amber-950/80 text-amber-300 border-amber-700/80 animate-pulse'
                              : lifecycleState !== 'ready'
                                ? 'bg-amber-950/80 text-amber-300 border-amber-700/80'
                                : 'bg-emerald-950/80 text-emerald-300 border-emerald-700/80'
                      }`}
                    >
                      {isNotEligible
                        ? 'NOT ELIGIBLE'
                        : lifecycleState === 'rejected'
                          ? 'REJECTED'
                          : lifecycleState === 'pending_order'
                            ? 'ORDER SUBMITTED'
                            : lifecycleState === 'ready'
                              ? 'READY FOR EXECUTION'
                              : !isTriggerSatisfied
                                ? 'WAITING FOR TRIGGER'
                                : 'POTENTIAL SETUP'}
                    </span>
                  </div>
                </div>

                {isNotEligible && isEntryMissed ? (
                  <div className="mt-2 space-y-1.5 font-mono">
                    <div className="text-white text-base font-black tracking-wide flex items-center gap-2">
                      <span>{symbol}</span>
                      <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800 px-2 py-0.5 rounded">
                        ENTRY MISSED
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed font-sans">
                      {entryMissedReason} Waiting for a new setup - chasing the market would mean a larger stop and a smaller reward.
                    </p>
                  </div>
                ) : isNotEligible && !isStructurallyIneligible ? (
                  <div className="mt-2 space-y-1.5 font-mono">
                    <div className="text-white text-base font-black tracking-wide flex items-center gap-2">
                      <span>{optionData?.contractName || `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`}</span>
                      <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800 px-2 py-0.5 rounded">
                        NOT ELIGIBLE
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed font-sans">
                      Trigger reached, but this contract cannot be executed: {operationalIneligibilityReason}
                    </p>
                  </div>
                ) : isNotEligible ? (
                  <div className="mt-2 space-y-1.5 font-mono">
                    <div className="text-white text-base font-black tracking-wide flex items-center gap-2">
                      <span>{symbol}</span>
                      <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800 px-2 py-0.5 rounded">
                        LONG-ONLY SPOT
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed font-sans">
                      {effectiveDirection === 'BEARISH' ? 'Bearish signal detected.' : 'Signal detected.'}{' '}
                      <span className="text-white font-semibold">{symbol}</span> supports{' '}
                      <span className="text-emerald-400 font-semibold">LONG</span> positions only.
                    </p>
                    <p className="text-[11px] text-amber-300/90">
                      This {effectiveDirection.toLowerCase()} setup is not eligible for execution.
                    </p>
                  </div>
                ) : (
                  <div className="mt-2 space-y-1">
                    <div className="text-white text-lg font-black tracking-wide flex items-center gap-2">
                      <span>
                        {isOptionMode && !isCrypto && !isGold
                          ? (optionData?.contractName || `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'}`)
                          : symbol.toUpperCase() === 'BTCUSDT_PERP'
                            ? `${symbol} Perpetual`
                            : `${symbol} Spot`}
                      </span>
                      {isOptionMode && !isCrypto && !isGold && optionData?.expiryLabel && (
                        <span className="text-slate-400 text-xs font-normal">
                          (Expiry: {optionData.expiryLabel})
                        </span>
                      )}
                    </div>

                    {lifecycleState === 'rejected' ? (
                      <div className="text-rose-400 text-xs font-bold pt-1">
                        Rejection Reason: {orderRejectionReason || activeExecution?.failureReason || 'Broker rejected order'}
                      </div>
                    ) : lifecycleState === 'pending_order' ? (
                      <div className="text-amber-300 text-xs font-bold flex items-center gap-2 pt-1">
                        <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                        <span>Order submitted to broker • Awaiting fill confirmation and position creation...</span>
                      </div>
                    ) : (
                      <div className="text-slate-400 text-xs">
                        Strategy signal detected • Position will be created once order is executed.
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-2.5 border-t border-slate-800/90 font-mono text-[11px]">
                  <div>
                    <span className="text-slate-500 text-[10px] block uppercase font-bold">UNDERLYING TRIGGER</span>
                    <strong className="text-amber-300 text-xs block">
                      {isCrypto || isGold ? '$' : '₹'}{dp(underlyingTriggerPrice).toFixed(2)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 text-[10px] block uppercase font-bold">
                      {isOptionMode && !isCrypto && !isGold ? 'OPTION ENTRY' : 'PLANNED ENTRY'}
                    </span>
                    <strong className="text-emerald-300 text-xs block">
                      {nativeCurrency}{dp(effectiveEntryPrice).toFixed(2)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 text-[10px] block uppercase font-bold">
                      {isNotEligible ? 'INVALIDATION' : 'STOP'}
                    </span>
                    <strong className="text-rose-400 text-xs block">
                      {nativeCurrency}{dp(safeInitialSL).toFixed(2)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 text-[10px] block uppercase font-bold">
                      {isNotEligible ? 'ELIGIBILITY' : 'QUANTITY'}
                    </span>
                    <strong className={`text-xs block ${isNotEligible ? 'text-amber-400' : 'text-white'}`}>
                      {isNotEligible ? 'INELIGIBLE' : `${totalQuantity} ${isCrypto ? 'BTC' : isGold ? 'oz' : 'Qty'}`}
                    </strong>
                  </div>
                </div>
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
                      ? 'ACTIVE TRADE • UNREALIZED OPTION P&L'
                      : 'ACTIVE TRADE • NET UNREALIZED P&L'}
                </span>
                <div className="flex items-center gap-1.5">
                  {!isClosed && paperPosition?.priceStatus === 'STALE' && (
                    <span
                      title={`No validated live quote: ${paperPosition?.priceStaleReason ?? 'unknown reason'}. P&L uses the last stored price.`}
                      className="text-[10px] font-bold px-2 py-0.5 rounded border border-amber-500/50 bg-amber-950/60 text-amber-300"
                    >
                      PRICE STALE
                    </span>
                  )}
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
                  {actualTrade?.canonicalRR && (
                    <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">
                      Target R:R 1:{actualTrade.canonicalRR.toFixed(1)}
                    </span>
                  )}
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
                    {actualTrade?.tradeId && (
                      <>
                        <span className="text-slate-500 mx-1">•</span>
                        <span className="text-cyan-400">
                          Trade ID: {actualTrade.tradeId.slice(-8)}
                        </span>
                      </>
                    )}
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
                    {actualTrade?.tradeId && (
                      <>
                        <span className="text-slate-500 mx-1">•</span>
                        <span className="text-cyan-400">
                          Trade ID: {actualTrade.tradeId.slice(-8)}
                        </span>
                      </>
                    )}
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
              : !canExecute
                ? 'EXECUTION ELIGIBILITY'
                : 'PLANNED QUANTITY'}
          </span>
          <span className={`text-xl font-black block mt-1 ${!canExecute && !hasActiveTrade ? 'text-amber-400 text-sm' : 'text-cyan-300'}`}>
            {!canExecute && !hasActiveTrade ? 'NOT ELIGIBLE' : `${totalQuantity} ${isCrypto ? 'BTC' : isGold ? 'oz' : 'Qty'}`}
          </span>
          <span className="text-[10px] text-indigo-300 font-bold block mt-0.5 truncate">
            {hasActiveTrade
              ? isOptionMode && !isCrypto && !isGold
                ? `⚡ ${displayContract} (Locked)`
                : isCrypto
                  ? `${totalQuantity} BTC ${isPerp ? `Perp ${isBull ? 'Long' : 'Short'} ${effectiveLeverage}x` : 'Contract'} (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                  : isGold
                    ? `${totalQuantity} oz Gold Spot (${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })} Margin)`
                    : `${symbol === 'NIFTY' ? '1 Lot (65 Qty)' : '1 Lot'}`
              : !canExecute
                ? `${symbol} Spot Long-Only`
                : isOptionMode && !isCrypto && !isGold
                  ? `${symbol} ${activeStrike} ${isBull ? 'CE' : 'PE'} (1 Lot • 65 Qty)`
                  : isCrypto
                    ? (isPerp ? `${totalQuantity} BTC Perp ${isBull ? 'Long' : 'Short'} @ ${effectiveLeverage}x` : '0.01 BTC Order Size')
                    : isGold
                      ? `${totalQuantity} oz Gold Order Size`
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
              : isOptionMode && !isCrypto && !isGold
                ? 'PLANNED OPTION ENTRY'
                : 'PLANNED ENTRY'}
          </span>
          <span className="text-xl font-black text-white block mt-1">
            {nativeCurrency}
            {dp(effectiveEntryPrice).toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">
            {hasActiveTrade
              ? isOptionMode && !isCrypto && !isGold
                ? `Underlying: ${nativeCurrency}${dp(spotEntryPrice).toFixed(2)} | Outlay: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `Margin Used: ${currencySymbol}${totalMarginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}${isCrypto || isGold ? ` (${effectiveLeverage}x Leverage)` : ''}`
              : isOptionMode && !isCrypto && !isGold
                ? `Trigger Band: ₹${(optionEntryPremium * 0.99).toFixed(2)} - ₹${(optionEntryPremium * 1.01).toFixed(2)} (±1%) | Underlying Trigger: ${nativeCurrency}${dp(underlyingTriggerPrice).toFixed(2)}`
                : `Underlying Trigger: ${nativeCurrency}${dp(underlyingTriggerPrice).toFixed(2)}`}
          </span>
        </div>

        {/* 4. Active Stop Loss (With Trailing Profit Lock / BE Indicator) */}
        <div className="bg-slate-900/90 border border-slate-800 p-3.5 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
              {!hasActiveTrade
                ? 'PLANNED STOP'
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
                : hasActiveTrade
                  ? `Position Risk: ${currencySymbol}${maxRiskAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : `Invalidation Level: ${nativeCurrency}${dp(safeInitialSL).toFixed(2)}`}
          </span>
        </div>
      </div>

      {/* Target Progression Progress Bar — DISPLAYED ONLY FOR ACTUAL ACTIVE OR CLOSED TRADES */}
      {canDisplayLiveMetrics && (
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
                {dp(tp1).toFixed(2)} ({isTP1Reached ? '✅ HIT' : `+${authoritativeRR1.toFixed(1)}R`})
              </span>
              <span className="text-slate-600">•</span>
              <span className={isTP2Reached ? 'text-teal-300 font-bold' : 'text-slate-400'}>
                TP2: {nativeCurrency}
                {dp(tp2).toFixed(2)} ({isTP2Reached ? '🎯 HIT' : `+${authoritativeRR2.toFixed(1)}R`})
              </span>
              <span className="text-slate-600">•</span>
              <span className={isTP3Reached ? 'text-purple-300 font-bold' : 'text-slate-400'}>
                TP3: {nativeCurrency}
                {dp(tp3).toFixed(2)} ({isTP3Reached ? '🏆 HIT' : `+${authoritativeRR3.toFixed(1)}R`})
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
            <span>Session Entry: {entryDate ? formatDateTimeIST(entryDate) : 'N/A'}</span>
            <span className="text-cyan-400 font-bold">
              {`${progressPercent.toFixed(1)}% to Target (${isTP3Reached ? 'TP3 HIT' : isTP2Reached ? 'TP2 HIT' : isTP1Reached ? 'TP1 HIT' : 'TP2'})`}
            </span>
            <span>Session Target Exit: {estCloseDate ? formatDateTimeIST(estCloseDate) : 'N/A'}</span>
          </div>
        </div>
      )}

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

            {/* Manual 50% Scale Out Button */}
            {!isAutoScaledOut && (
              <button
                onClick={() => handleCutTrade('Manual 50% Scale Out', 0.5)}
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
              {isOptionMode && !isCrypto && !isGold ? (
                <>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${
                    !canExecute
                      ? 'bg-slate-800 text-amber-300 border border-slate-700'
                      : !isTriggerSatisfied
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  }`}>
                    {!canExecute
                      ? 'NOT ELIGIBLE FOR SPOT EXECUTION'
                      : !isTriggerSatisfied
                        ? 'WAITING FOR TRIGGER'
                        : 'TRIGGER SATISFIED'}
                  </span>
                  Current {symbol}: <strong className="text-white">₹{dp(currentCMP).toFixed(2)}</strong> | Option LTP: <strong className="text-white">₹{dp(liveOptionPremium).toFixed(2)}</strong> | Planned Entry: <strong className="text-cyan-300">₹{dp(optionEntryPremium).toFixed(2)} (±1%)</strong> | Distance: <strong className="text-cyan-300">₹{dp(distanceToTrigger).toFixed(2)}</strong> | Contract: <strong className="text-indigo-300">{displayContract}</strong> | Qty: <strong className="text-white">{numericQty} Qty</strong>
                </>
              ) : (
                <>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${
                    !canExecute || isEntryMissed
                      ? 'bg-slate-800 text-amber-300 border border-slate-700'
                      : !isTriggerSatisfied
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  }`}>
                    {!canExecute
                      ? 'NOT ELIGIBLE FOR SPOT EXECUTION'
                      : isEntryMissed
                        ? 'ENTRY MISSED'
                        : !isTriggerSatisfied
                          ? 'WAITING FOR TRIGGER'
                          : 'TRIGGER SATISFIED'}
                  </span>
                  Current {symbol}: <strong className="text-white">{nativeCurrency}{dp(currentCMP).toFixed(2)}</strong> | Planned Entry: <strong className="text-amber-300">{nativeCurrency}{dp(underlyingTriggerPrice).toFixed(2)}</strong> | Planned Stop: <strong className="text-rose-300">{nativeCurrency}{dp(safeInitialSL).toFixed(2)}</strong> | Qty: <strong className="text-white">{canExecute ? numericQty : '0'}</strong>
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {bot && (
              <div className="flex items-center gap-1.5">
                <select
                  value={bot.strategy?.toUpperCase().includes('SAIYAN') ? 'SAIYAN_OCC' : 'SMC'}
                  onChange={(e) => handleUpdateBotStrategy(e.target.value)}
                  className="bg-slate-950 border border-slate-700 text-cyan-300 text-[11px] font-bold rounded px-2 py-1 focus:outline-none focus:border-cyan-500 cursor-pointer"
                  title="Change bot strategy (SMC vs Saiyan OCC)"
                >
                  <option value="SMC">Bot: SMC</option>
                  <option value="SAIYAN_OCC">Bot: Saiyan</option>
                </select>
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
                      ? bot.autoExecutePaper
                        ? 'Bot is ACTIVE and auto-trading: qualifying signals are placed in the paper account automatically'
                        : 'Bot is ACTIVE but auto-trading is OFF: it does not place trades; use the Execute button to trade manually'
                      : 'Bot is INACTIVE: click to activate'
                  }
                >
                  <Bot className="w-3.5 h-3.5" />
                  {isTogglingBot
                    ? 'Updating...'
                    : bot.isActive
                      ? `Active · Auto ${bot.autoExecutePaper ? 'ON' : 'OFF'}`
                      : 'Off'}
                </button>
              </div>
            )}

            {/* A non-executable setup (e.g. a bearish signal on long-only spot) has no trade, so nothing is
                shown here: no execute button and no "no execution" notice. */}
            {!canExecute || isEntryMissed ? null : (
              <button
                type="button"
                onClick={handleExecutePaperOrder}
                disabled={isPlacingOrder || !isTriggerSatisfied}
                className={`font-black px-4 py-1.5 rounded-lg font-mono flex items-center gap-1.5 shadow-lg transition-all text-xs ${
                  !isTriggerSatisfied
                    ? 'bg-amber-950/60 text-amber-300 border border-amber-800/80 cursor-not-allowed'
                    : 'bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-slate-950 shadow-cyan-500/20'
                }`}
                title={
                  !isTriggerSatisfied
                    ? isOptionsAsset
                      ? `Order cannot be executed until option premium reaches the trigger level (₹${dp(optionEntryPremium).toFixed(2)} ±1%).`
                      : `Order cannot be executed until market price reaches the trigger level (${nativeCurrency}${dp(underlyingTriggerPrice).toFixed(2)}).`
                    : 'Execute paper order'
                }
              >
                {isPlacingOrder ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    Routing Order...
                  </>
                ) : !isTriggerSatisfied ? (
                  <>
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    {isOptionsAsset
                      ? `WAITING FOR OPTION TRIGGER (₹${dp(optionEntryPremium).toFixed(2)} ±1%)`
                      : `WAITING FOR TRIGGER (${nativeCurrency}${dp(underlyingTriggerPrice).toFixed(2)})`}
                  </>
                ) : isOptionsAsset ? (
                  <>
                    <Zap className="w-4 h-4" />
                    Execute Option {symbol} {activeStrike} {isBull ? 'CE' : 'PE'} @ ₹{dp(optionEntryPremium).toFixed(2)}
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" />
                    Execute Paper Trade @ Market ({nativeCurrency}{dp(currentCMP).toFixed(2)})
                  </>
                )}
              </button>
            )}
          </div>
          {canExecute && !isEntryMissed && (
            <div
              className={`w-full text-[11px] ${autoTradeBlockers.length ? 'text-amber-300' : 'text-emerald-300'}`}
              data-testid="auto-trade-status"
            >
              {autoTradeBlockers.length
                ? `Manual only: this setup will NOT be traded automatically (${autoTradeBlockers.join('; ')}). Use the Execute button to place it yourself.`
                : 'Auto-trade ON: the bot places this setup automatically when the trigger is reached.'}
            </div>
          )}
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
