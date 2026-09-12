import {
  Direction,
  ICandle,
  IBacktestTrade,
  ISignalSetup,
  SignalState,
  isLongPosition,
  normalizeDirection,
  hasInstrument,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  MarginMode,
  IResolvedMarginModel,
  resolveMarginModel,
} from '@quant/shared';
import {
  IEntryExecutionSnapshot,
  IExecutionEvent,
  IPartialExitPolicy,
  IPartialFillRecord,
  ITradeStateUpdate,
  PositionLot,
  PositionStatus,
} from './types';
import { TradeAccountingEngine } from './trade-accounting-engine';

export const DEFAULT_PARTIAL_EXIT_POLICY: IPartialExitPolicy = {
  tp1Ratio: 0.3, // 30% scale-out at TP1
  tp2Ratio: 0.3, // 30% scale-out at TP2
  tp3Ratio: 0.4, // 40% runner to TP3
  moveStopToBreakevenOnTp1: true,
  trailStopOnTp2: true,
  trailStopOffsetR: 1.0,
  autoDeriveTargets: true,
  defaultRMultiples: { r1: 1.5, r2: 2.5, r3: 4.0 },
};

export class TradeLifecycleManager {
  /**
   * Validates partial exit ratios to guarantee exact 100% position allocation
   */
  static validatePartialExitPolicy(policy: IPartialExitPolicy): { isValid: boolean; reason?: string } {
    if (!policy) {
      return { isValid: false, reason: 'POLICY_MISSING' };
    }
    if (policy.tp1Ratio < 0 || policy.tp2Ratio < 0 || policy.tp3Ratio < 0) {
      return { isValid: false, reason: 'RATIOS_NEGATIVE' };
    }
    const sum = Number((policy.tp1Ratio + policy.tp2Ratio + policy.tp3Ratio).toFixed(4));
    if (sum !== 1.0) {
      return { isValid: false, reason: `RATIOS_DO_NOT_SUM_TO_ONE (sum=${sum})` };
    }
    return { isValid: true };
  }

  /**
   * Initializes an explicit, immutable PositionLot from an activated setup
   */
  static createPositionLot(
    signal: ISignalSetup,
    executionPrice: number,
    quantity: number,
    executionTime: number,
    orderId?: string,
    entryFee = 0,
    entrySlippage = 0,
    policy: IPartialExitPolicy = DEFAULT_PARTIAL_EXIT_POLICY,
  ): PositionLot {
    const tradeId = signal.id || `trade_${signal.symbol}_${executionTime}`;
    const isLong = isLongPosition(signal.direction);

    // Strict validation of stopLoss (no silent synthetic risk creation)
    if (typeof signal.stopLoss !== 'number' || !Number.isFinite(signal.stopLoss) || signal.stopLoss <= 0) {
      throw new Error(`INVALID_SIGNAL_STOP_LOSS: Signal for trade '${tradeId}' must provide a valid positive stopLoss, got ${signal.stopLoss}`);
    }

    const initialStopLoss = signal.stopLoss;
    if (isLong && initialStopLoss >= executionPrice) {
      throw new Error(
        `INVALID_POSITION_PROTECTION: Stop loss (${initialStopLoss}) for LONG position must be strictly below execution price (${executionPrice})`,
      );
    }
    if (!isLong && initialStopLoss <= executionPrice) {
      throw new Error(
        `INVALID_POSITION_PROTECTION: Stop loss (${initialStopLoss}) for SHORT position must be strictly above execution price (${executionPrice})`,
      );
    }

    const riskDistance = Math.abs(executionPrice - initialStopLoss);
    const rawTp1 = signal.takeProfits?.tp1;
    const rawTp2 = signal.takeProfits?.tp2;
    const rawTp3 = signal.takeProfits?.tp3;

    const r1Mult = policy.defaultRMultiples?.r1 ?? 1.5;
    const r2Mult = policy.defaultRMultiples?.r2 ?? 2.5;
    const r3Mult = policy.defaultRMultiples?.r3 ?? 4.0;

    let tp1: number;
    if (typeof rawTp1 === 'number' && Number.isFinite(rawTp1) && (isLong ? rawTp1 > executionPrice : rawTp1 < executionPrice)) {
      tp1 = rawTp1;
    } else if (policy.autoDeriveTargets) {
      tp1 = isLong
        ? Number((executionPrice + riskDistance * r1Mult).toFixed(2))
        : Number(Math.max(0.01, executionPrice - riskDistance * r1Mult).toFixed(2));
    } else {
      throw new Error(
        `INVALID_SIGNAL_TAKE_PROFIT: Signal for trade '${tradeId}' has missing/invalid TP1 and autoDeriveTargets is disabled`,
      );
    }

    let tp2: number;
    if (typeof rawTp2 === 'number' && Number.isFinite(rawTp2) && (isLong ? rawTp2 > executionPrice : rawTp2 < executionPrice)) {
      tp2 = rawTp2;
    } else if (policy.autoDeriveTargets) {
      tp2 = isLong
        ? Number((executionPrice + riskDistance * r2Mult).toFixed(2))
        : Number(Math.max(0.01, executionPrice - riskDistance * r2Mult).toFixed(2));
    } else {
      tp2 = tp1;
    }

    let tp3: number;
    if (typeof rawTp3 === 'number' && Number.isFinite(rawTp3) && (isLong ? rawTp3 > executionPrice : rawTp3 < executionPrice)) {
      tp3 = rawTp3;
    } else if (policy.autoDeriveTargets) {
      tp3 = isLong
        ? Number((executionPrice + riskDistance * r3Mult).toFixed(2))
        : Number(Math.max(0.01, executionPrice - riskDistance * r3Mult).toFixed(2));
    } else {
      tp3 = tp2;
    }

    if (isLong) {
      if (tp1 <= executionPrice) {
        throw new Error(`INVALID_SIGNAL_TAKE_PROFIT: TP1 (${tp1}) for LONG position must be strictly above execution price (${executionPrice})`);
      }
    } else {
      if (tp1 >= executionPrice) {
        throw new Error(`INVALID_SIGNAL_TAKE_PROFIT: TP1 (${tp1}) for SHORT position must be strictly below execution price (${executionPrice})`);
      }
    }

    const entryEvent: IExecutionEvent = {
      eventId: `evt_entry_${executionTime}_${tradeId}`,
      tradeId,
      orderId,
      symbol: signal.symbol,
      eventType: 'ENTRY_FILLED',
      timestamp: executionTime,
      price: executionPrice,
      quantity,
      remainingQuantity: quantity,
      fees: entryFee,
      slippage: entrySlippage,
      reason: `Executed ${signal.direction} @ ${executionPrice}`,
    };

    const initialFill: IPartialFillRecord = {
      fillId: `fill_entry_${executionTime}_${tradeId}`,
      targetType: 'ENTRY',
      timestamp: executionTime,
      price: executionPrice,
      quantity,
      remainingQuantity: quantity,
      realizedPnl: 0,
      realizedR: 0,
      fee: entryFee,
      slippage: entrySlippage,
    };

    const signalTimestamp =
      signal.timestamp instanceof Date
        ? signal.timestamp.getTime()
        : typeof signal.timestamp === 'number'
          ? signal.timestamp
          : executionTime;

    const entrySnapshot: IEntryExecutionSnapshot = Object.freeze({
      entryPrice: executionPrice,
      referencePrice: signal.entryZone?.optimal || executionPrice,
      quantity,
      fee: entryFee,
      slippage: entrySlippage,
      signalTimestamp,
      executionTimestamp: executionTime,
      orderId,
      side: isLong ? 'BUY' : 'SELL',
      initialStopLoss: initialStopLoss,
      tp1,
      tp2,
      tp3,
    });

    return {
      id: `lot_${tradeId}_${executionTime}`,
      tradeId,
      symbol: signal.symbol,
      direction: signal.direction,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      entryPrice: executionPrice,
      entryTime: executionTime,
      initialStopLoss: initialStopLoss,
      currentStopLoss: initialStopLoss,
      tp1,
      tp2,
      tp3,
      realizedPnl: 0,
      unrealizedPnl: 0,
      realizedR: 0,
      status: 'OPEN',
      openedAt: executionTime,
      partialFills: [initialFill],
      events: [entryEvent],
      mae: 0,
      mfe: 0,
      entrySnapshot,
    };
  }

  static createCompletedTrade(
    lot: PositionLot,
    exitReason: SignalState,
    fillModel?: string,
    ambiguityMode?: string,
    tradeId = lot.tradeId,
    options?: {
      leverage?: number;
      marginMode?: MarginMode;
      initialMarginRate?: number;
      contractSize?: number;
      lotSize?: number;
      fxRate?: number;
    },
  ): IBacktestTrade {
    const firstFill = lot.partialFills[0];
    const lastFill = lot.partialFills[lot.partialFills.length - 1];
    const totalFees = lot.partialFills.reduce((sum, fill) => sum + fill.fee, 0);
    const totalSlippage = lot.partialFills.reduce((sum, fill) => sum + fill.slippage, 0);

    let instrument = hasInstrument(lot.symbol) ? getAuthoritativeInstrument(lot.symbol) : undefined;
    const contractSize = options?.contractSize ?? instrument?.contractSize ?? 1;
    const lotSize = options?.lotSize ?? instrument?.lotSize ?? 1;
    const quoteCurrency = instrument?.quoteCurrency || (instrument?.currency as any) || 'INR';
    const accountCurrency = 'INR';

    let fxRate = options?.fxRate;
    let fxTimestamp = lot.openedAt;
    let fxPair = `${quoteCurrency}/${accountCurrency}`;
    if (fxRate === undefined) {
      if (quoteCurrency === accountCurrency) {
        fxRate = 1.0;
      } else {
        // Strict fail-closed: throws if FX rate is unavailable for cross-currency instrument
        const fxResult = PointInTimeCurrencyConverter.getInstance().getRate(
          quoteCurrency,
          accountCurrency,
          lot.openedAt,
        );
        fxRate = fxResult.fxRate;
        fxTimestamp = fxResult.fxTimestamp;
        fxPair = fxResult.fxPair;
      }
    }

    let resolvedMarginModel: IResolvedMarginModel;
    if (instrument) {
      resolvedMarginModel = resolveMarginModel(instrument, {
        requestedLeverage: options?.leverage,
        venueOverride: {
          marginMode: options?.marginMode,
          initialMarginRate: options?.initialMarginRate,
        },
      });
    } else {
      const lev = options?.leverage ?? 1;
      const mMode: MarginMode = options?.marginMode ?? (lev > 1 ? 'ISOLATED' : 'SPOT');
      resolvedMarginModel = {
        marginMode: mMode,
        effectiveLeverage: Math.max(1, lev),
        initialMarginRate: options?.initialMarginRate ?? (mMode === 'SPOT' ? 1.0 : 1 / Math.max(1, lev)),
        maintenanceMarginRate: 0.05,
        liquidationModel: mMode === 'SPOT' ? 'SPOT_NONE' : 'ISOLATED_LINEAR',
      };
    }

    const leverage = resolvedMarginModel.effectiveLeverage;
    const marginMode = resolvedMarginModel.marginMode;

    const notionalCalc = TradeAccountingEngine.calculateNotional(
      lot.initialQuantity,
      lot.entryPrice,
      contractSize,
      fxRate,
    );
    const marginCalc = TradeAccountingEngine.calculateMargin(
      notionalCalc.notionalAccount,
      resolvedMarginModel,
    );

    const initialRisk = TradeAccountingEngine.calculateStopRisk(
      lot.entryPrice,
      lot.initialStopLoss,
      lot.initialQuantity,
      contractSize,
      fxRate,
    );
    const netPnl = Number((lot.realizedPnl - totalFees).toFixed(2));

    return {
      id: tradeId,
      direction: lot.direction,
      entryTime: new Date(lot.openedAt),
      entryPrice: lot.entryPrice,
      exitTime: new Date(lot.closedAt || lastFill?.timestamp || lot.openedAt),
      exitPrice: lastFill?.price || lot.entryPrice,
      stopLoss: lot.initialStopLoss,
      takeProfit: lot.tp2,
      positionSize: lot.initialQuantity,
      marginRequired: marginCalc.initialMarginRequired,
      initialMarginRequired: marginCalc.initialMarginRequired,
      maintenanceMarginRequired: marginCalc.maintenanceMarginRequired,
      positionNotionalQuote: notionalCalc.notionalQuote,
      positionNotionalAccount: notionalCalc.notionalAccount,
      accountCurrency,
      quoteCurrency,
      fxPair,
      fxRate,
      fxTimestamp,
      contractSize,
      lotSize,
      leverage,
      marginMode,
      riskAmount: Number(initialRisk.toFixed(2)),
      pnl: netPnl,
      pnlRMultiple: Number((netPnl / Math.max(1, initialRisk)).toFixed(2)),
      exitReason,
      signalTimestamp: new Date(lot.entrySnapshot?.signalTimestamp || lot.openedAt),
      orderCreatedAt: new Date(lot.entrySnapshot?.orderCreatedAt || lot.openedAt),
      orderSubmittedAt: new Date(lot.entrySnapshot?.orderSubmittedAt || lot.openedAt),
      entryFillTimestamp: new Date(lot.entrySnapshot?.executionTimestamp || lot.openedAt),
      entryReferencePrice: lot.entrySnapshot?.referencePrice || lot.entryPrice,
      entryFillPrice: lot.entrySnapshot?.entryPrice || lot.entryPrice,
      entryFees: lot.entrySnapshot?.fee ?? firstFill?.fee ?? 0,
      entrySlippage: lot.entrySnapshot?.slippage ?? firstFill?.slippage ?? 0,
      exitOrderTimestamp: new Date(lastFill?.timestamp || lot.closedAt || lot.openedAt),
      exitOrderCreatedAt: new Date(lastFill?.exitOrderCreatedAt || lastFill?.timestamp || lot.openedAt),
      exitOrderSubmittedAt: new Date(lastFill?.exitOrderSubmittedAt || lastFill?.timestamp || lot.openedAt),
      exitTriggerTimestamp: new Date(lastFill?.exitTriggerTimestamp || lastFill?.timestamp || lot.openedAt),
      exitFillTimestamp: new Date(lastFill?.exitFillTimestamp || lastFill?.timestamp || lot.openedAt),
      exitFillPrice: lastFill?.price || lot.entryPrice,
      exitFees: totalFees - (firstFill?.fee || 0),
      exitSlippage: totalSlippage - (firstFill?.slippage || 0),
      grossPnL: lot.realizedPnl,
      netPnL: netPnl,
      realizedR: Number((netPnl / Math.max(1, initialRisk)).toFixed(2)),
      fillModel,
      ambiguityMode,
      entrySnapshot: lot.entrySnapshot,
      resolvedMarginModel,
    };
  }

  /**
   * Authoritatively processes an exit fill on an active PositionLot from ExecutionSimulator.
   * Manages trade economics (P&L, realized R, remaining quantity), partial fills, breakeven stop moves, and trade completion.
   */
  static processExitFill(
    lot: PositionLot,
    fill: {
      fillId: string;
      orderId: string;
      targetType?: string;
      price: number;
      quantity: number;
      timestamp: number;
      fee?: number;
      slippage?: number;
      exitOrderCreatedAt?: number;
      exitOrderSubmittedAt?: number;
      exitTriggerTimestamp?: number;
      exitFillTimestamp?: number;
      segmentIndex?: number;
      segmentType?: string;
    },
    policy: IPartialExitPolicy = DEFAULT_PARTIAL_EXIT_POLICY,
    fillModel?: string,
    ambiguityMode?: string,
  ): {
    lot: PositionLot;
    completedTrade?: IBacktestTrade;
    isClosed: boolean;
    isBreakevenStopTriggered: boolean;
  } {
    const isLong = isLongPosition(lot.direction || lot.entrySnapshot?.side);
    const fillQty = fill.quantity;
    const chunkDiff = isLong
      ? fill.price - lot.entryPrice
      : lot.entryPrice - fill.price;
    const grossPnl = Number((chunkDiff * fillQty).toFixed(2));
    const initialRiskPerUnit = Math.max(
      0.0001,
      Math.abs(lot.entryPrice - lot.initialStopLoss),
    );
    const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

    lot.realizedPnl = Number((lot.realizedPnl + grossPnl).toFixed(2));
    lot.remainingQuantity = Number(
      Math.max(0, lot.remainingQuantity - fillQty).toFixed(4),
    );

    const targetType = (fill.targetType as any) || 'TP1';

    const newFillRecord: IPartialFillRecord = {
      fillId: fill.fillId,
      targetType: targetType as any,
      timestamp: fill.timestamp,
      price: fill.price,
      quantity: fillQty,
      remainingQuantity: lot.remainingQuantity,
      realizedPnl: grossPnl,
      realizedR: chunkR,
      fee: fill.fee || 0,
      slippage: fill.slippage || 0,
      exitOrderId: fill.orderId,
      exitOrderCreatedAt: fill.exitOrderCreatedAt,
      exitOrderSubmittedAt: fill.exitOrderSubmittedAt,
      exitTriggerTimestamp: fill.exitTriggerTimestamp,
      exitFillTimestamp: fill.exitFillTimestamp,
      segmentIndex: fill.segmentIndex,
      segmentType: fill.segmentType,
    };

    lot.partialFills = [...(lot.partialFills || []), newFillRecord];

    let completedTrade: IBacktestTrade | undefined;
    let isClosed = false;
    let isBreakevenStopTriggered = false;

    if (lot.remainingQuantity <= 0) {
      isClosed = true;
      lot.status = 'CLOSED';
      lot.closedAt = fill.timestamp;
      lot.unrealizedPnl = 0;

      const lastFill = lot.partialFills[lot.partialFills.length - 1];
      const exitReason =
        (lastFill?.targetType as string) === 'SL' ||
        (lastFill?.targetType as string) === 'STOP' ||
        lastFill?.targetType === 'STOP_LOSS'
          ? SignalState.SL_HIT
          : (lastFill?.targetType as string) === 'TP1'
          ? SignalState.TP1_HIT
          : (lastFill?.targetType as string) === 'TP2'
          ? SignalState.TP2_HIT
          : (lastFill?.targetType as string) === 'TP3'
          ? SignalState.TP3_HIT
          : SignalState.INVALIDATED;

      completedTrade = TradeLifecycleManager.createCompletedTrade(
        lot,
        exitReason,
        fillModel,
        ambiguityMode,
      );
    } else {
      lot.status = 'PARTIALLY_CLOSED';
      if (targetType === 'TP1' && policy.moveStopToBreakevenOnTp1) {
        lot.currentStopLoss = lot.entryPrice;
        isBreakevenStopTriggered = true;
      }
    }

    return {
      lot,
      completedTrade,
      isClosed,
      isBreakevenStopTriggered,
    };
  }

  /**
   * @deprecated Synthetic lifecycle tick evaluation is disabled for backtesting.
   * Backtesting MUST use ExecutionSimulator and FillModelEngine directly for authoritative order execution.
   */
  static evaluateLotTick(
    lot: PositionLot,
    candle: ICandle,
    policy: IPartialExitPolicy = DEFAULT_PARTIAL_EXIT_POLICY,
    candleTimestamp: number = candle.timestamp instanceof Date
      ? candle.timestamp.getTime()
      : typeof candle.timestamp === 'number'
        ? candle.timestamp
        : Date.now(),
    forBacktest: boolean = false,
  ): {
    lot: PositionLot;
    events: IExecutionEvent[];
    isClosed: boolean;
    state: SignalState;
  } {
    if (forBacktest) {
      throw new Error(
        'Synthetic lifecycle evaluation (evaluateLotTick) is deprecated and disabled for backtesting. Backtests must use ExecutionSimulator.',
      );
    }
    const isLong = isLongPosition(lot.direction || lot.entrySnapshot?.side);
    const high = candle.high;
    const low = candle.low;
    const close = candle.close;
    const newEvents: IExecutionEvent[] = [];

    // Track MAE / MFE
    const adversePrice = isLong
      ? Math.max(0, lot.entryPrice - low)
      : Math.max(0, high - lot.entryPrice);
    const favorablePrice = isLong
      ? Math.max(0, high - lot.entryPrice)
      : Math.max(0, lot.entryPrice - low);
    lot.mae = Math.max(lot.mae, adversePrice);
    lot.mfe = Math.max(lot.mfe, favorablePrice);

    // Compute live unrealized PnL on remaining quantity
    const unitPriceDiff = isLong ? close - lot.entryPrice : lot.entryPrice - close;
    lot.unrealizedPnl = Number((unitPriceDiff * lot.remainingQuantity).toFixed(2));

    const initialRiskPerUnit = Math.max(0.0001, Math.abs(lot.entryPrice - lot.initialStopLoss));

    if (lot.status === 'CLOSED' || lot.status === 'CANCELLED' || lot.remainingQuantity <= 0) {
      return { lot, events: [], isClosed: true, state: SignalState.EXPIRED };
    }

    // 1. Check Stop Loss / Trailing Stop first (conservative risk principle)
    const isStopHit = isLong ? low <= lot.currentStopLoss : high >= lot.currentStopLoss;
    if (isStopHit) {
      // Gap-aware exit price
      const exitPrice = isLong
        ? Math.min(lot.currentStopLoss, candle.open)
        : Math.max(lot.currentStopLoss, candle.open);
      const fillQty = lot.remainingQuantity;
      const chunkDiff = isLong ? exitPrice - lot.entryPrice : lot.entryPrice - exitPrice;
      const chunkPnl = Number((chunkDiff * fillQty).toFixed(2));
      const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

      lot.realizedPnl = Number((lot.realizedPnl + chunkPnl).toFixed(2));
      lot.remainingQuantity = 0;
      lot.unrealizedPnl = 0;
      lot.status = 'CLOSED';
      lot.closedAt = candleTimestamp;

      const stopEvent: IExecutionEvent = {
        eventId: `evt_sl_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'STOP_FILLED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        fees: 0,
        slippage: 0,
        reason: `Stop loss hit at ${exitPrice} (${chunkPnl >= 0 ? '+' : ''}${chunkPnl})`,
      };

      const closeEvent: IExecutionEvent = {
        eventId: `evt_close_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'POSITION_CLOSED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        fees: 0,
        slippage: 0,
        reason: 'Position fully closed on stop execution',
      };

      lot.partialFills.push({
        fillId: `fill_sl_${candleTimestamp}`,
        targetType: lot.currentStopLoss === lot.entryPrice ? 'TRAILING_STOP' : 'STOP_LOSS',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        realizedPnl: chunkPnl,
        realizedR: chunkR,
        fee: 0,
        slippage: 0,
      });

      lot.events.push(stopEvent, closeEvent);
      newEvents.push(stopEvent, closeEvent);

      // Recalculate total blended realized R
      const totalPnl = lot.realizedPnl;
      const totalInitialRisk = initialRiskPerUnit * lot.initialQuantity;
      lot.realizedR = Number((totalPnl / Math.max(0.01, totalInitialRisk)).toFixed(2));

      return {
        lot,
        events: newEvents,
        isClosed: true,
        state: lot.realizedPnl >= 0 ? SignalState.TP1_HIT : SignalState.SL_HIT,
      };
    }

    // 2. Check Target 3 (Full expansion runner)
    const hasAlreadyTp1 = lot.partialFills.some((f) => f.targetType === 'TP1');
    const hasAlreadyTp2 = lot.partialFills.some((f) => f.targetType === 'TP2');
    const isTp3Hit = isLong ? high >= lot.tp3 : low <= lot.tp3;

    if (isTp3Hit) {
      const exitPrice = isLong
        ? Math.max(lot.tp3, candle.open)
        : Math.min(lot.tp3, candle.open);
      const fillQty = lot.remainingQuantity;
      const chunkDiff = isLong ? exitPrice - lot.entryPrice : lot.entryPrice - exitPrice;
      const chunkPnl = Number((chunkDiff * fillQty).toFixed(2));
      const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

      lot.realizedPnl = Number((lot.realizedPnl + chunkPnl).toFixed(2));
      lot.remainingQuantity = 0;
      lot.unrealizedPnl = 0;
      lot.status = 'CLOSED';
      lot.closedAt = candleTimestamp;

      const tp3Event: IExecutionEvent = {
        eventId: `evt_tp3_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'TP3_FILLED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        fees: 0,
        slippage: 0,
        reason: `Target 3 reached at ${exitPrice} (+${chunkR}R)`,
      };

      const closeEvent: IExecutionEvent = {
        eventId: `evt_close_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'POSITION_CLOSED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        fees: 0,
        slippage: 0,
        reason: 'Position fully closed at Target 3',
      };

      lot.partialFills.push({
        fillId: `fill_tp3_${candleTimestamp}`,
        targetType: 'TP3',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: fillQty,
        remainingQuantity: 0,
        realizedPnl: chunkPnl,
        realizedR: chunkR,
        fee: 0,
        slippage: 0,
      });

      lot.events.push(tp3Event, closeEvent);
      newEvents.push(tp3Event, closeEvent);

      const totalInitialRisk = initialRiskPerUnit * lot.initialQuantity;
      lot.realizedR = Number((lot.realizedPnl / Math.max(0.01, totalInitialRisk)).toFixed(2));

      return { lot, events: newEvents, isClosed: true, state: SignalState.TP3_HIT };
    }

    // 3. Check Target 2 (Secondary Scale Out / Full Exit if TP3 not enabled)
    const isTp2Hit = isLong ? high >= lot.tp2 : low <= lot.tp2;
    if (isTp2Hit && !hasAlreadyTp2) {
      const exitPrice = isLong
        ? Math.max(lot.tp2, candle.open)
        : Math.min(lot.tp2, candle.open);
      const targetRatio = policy.tp3Ratio > 0 ? policy.tp2Ratio : 1.0;
      const scaleQty = Math.max(
        1,
        Math.min(lot.remainingQuantity, Math.round(lot.initialQuantity * targetRatio)),
      );
      const chunkDiff = isLong ? exitPrice - lot.entryPrice : lot.entryPrice - exitPrice;
      const chunkPnl = Number((chunkDiff * scaleQty).toFixed(2));
      const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

      lot.realizedPnl = Number((lot.realizedPnl + chunkPnl).toFixed(2));
      lot.remainingQuantity = Number((lot.remainingQuantity - scaleQty).toFixed(4));
      const isFullyClosed = lot.remainingQuantity <= 0;

      if (isFullyClosed) {
        lot.status = 'CLOSED';
        lot.closedAt = candleTimestamp;
        lot.unrealizedPnl = 0;
      } else {
        lot.status = 'PARTIALLY_CLOSED';
        if (policy.trailStopOnTp2) {
          lot.currentStopLoss = lot.tp1;
          const stopMoveEvt: IExecutionEvent = {
            eventId: `evt_stopmove_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
            tradeId: lot.tradeId,
            symbol: lot.symbol,
            eventType: 'STOP_MOVED',
            timestamp: candleTimestamp,
            price: lot.tp1,
            quantity: lot.remainingQuantity,
            remainingQuantity: lot.remainingQuantity,
            fees: 0,
            slippage: 0,
            reason: `Trailing stop moved to TP1 level ${lot.tp1}`,
          };
          lot.events.push(stopMoveEvt);
          newEvents.push(stopMoveEvt);
        }
      }

      const tp2Event: IExecutionEvent = {
        eventId: `evt_tp2_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'TP2_FILLED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: scaleQty,
        remainingQuantity: lot.remainingQuantity,
        fees: 0,
        slippage: 0,
        reason: `Target 2 reached: closed ${scaleQty} units @ ${exitPrice} (+${chunkR}R)`,
      };

      lot.partialFills.push({
        fillId: `fill_tp2_${candleTimestamp}`,
        targetType: 'TP2',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: scaleQty,
        remainingQuantity: lot.remainingQuantity,
        realizedPnl: chunkPnl,
        realizedR: chunkR,
        fee: 0,
        slippage: 0,
      });

      lot.events.push(tp2Event);
      newEvents.push(tp2Event);

      if (isFullyClosed) {
        const closeEvt: IExecutionEvent = {
          eventId: `evt_close_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
          tradeId: lot.tradeId,
          symbol: lot.symbol,
          eventType: 'POSITION_CLOSED',
          timestamp: candleTimestamp,
          price: exitPrice,
          quantity: scaleQty,
          remainingQuantity: 0,
          fees: 0,
          slippage: 0,
          reason: 'Position fully closed at Target 2',
        };
        lot.events.push(closeEvt);
        newEvents.push(closeEvt);
      }

      const totalInitialRisk = initialRiskPerUnit * lot.initialQuantity;
      lot.realizedR = Number((lot.realizedPnl / Math.max(0.01, totalInitialRisk)).toFixed(2));

      return {
        lot,
        events: newEvents,
        isClosed: isFullyClosed,
        state: SignalState.TP2_HIT,
      };
    }

    // 4. Check Target 1 (Partial scale out & breakeven stop adjustment)
    const isTp1Hit = isLong ? high >= lot.tp1 : low <= lot.tp1;
    if (isTp1Hit && !hasAlreadyTp1) {
      const exitPrice = isLong
        ? Math.max(lot.tp1, candle.open)
        : Math.min(lot.tp1, candle.open);
      const scaleQty = Math.max(
        1,
        Math.min(lot.remainingQuantity, Math.round(lot.initialQuantity * policy.tp1Ratio)),
      );
      const chunkDiff = isLong ? exitPrice - lot.entryPrice : lot.entryPrice - exitPrice;
      const chunkPnl = Number((chunkDiff * scaleQty).toFixed(2));
      const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

      lot.realizedPnl = Number((lot.realizedPnl + chunkPnl).toFixed(2));
      lot.remainingQuantity = Number((lot.remainingQuantity - scaleQty).toFixed(4));
      lot.status = 'PARTIALLY_CLOSED';

      if (policy.moveStopToBreakevenOnTp1) {
        lot.currentStopLoss = lot.entryPrice;
        const stopMoveEvt: IExecutionEvent = {
          eventId: `evt_stopmove_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
          tradeId: lot.tradeId,
          symbol: lot.symbol,
          eventType: 'STOP_MOVED',
          timestamp: candleTimestamp,
          price: lot.entryPrice,
          quantity: lot.remainingQuantity,
          remainingQuantity: lot.remainingQuantity,
          fees: 0,
          slippage: 0,
          reason: `Trailing stop moved to breakeven ${lot.entryPrice}`,
        };
        lot.events.push(stopMoveEvt);
        newEvents.push(stopMoveEvt);
      }

      const tp1Event: IExecutionEvent = {
        eventId: `evt_tp1_${candleTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
        tradeId: lot.tradeId,
        symbol: lot.symbol,
        eventType: 'TP1_FILLED',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: scaleQty,
        remainingQuantity: lot.remainingQuantity,
        fees: 0,
        slippage: 0,
        reason: `Target 1 scale-out: closed ${scaleQty} units @ ${exitPrice} (+${chunkR}R)`,
      };

      lot.partialFills.push({
        fillId: `fill_tp1_${candleTimestamp}`,
        targetType: 'TP1',
        timestamp: candleTimestamp,
        price: exitPrice,
        quantity: scaleQty,
        remainingQuantity: lot.remainingQuantity,
        realizedPnl: chunkPnl,
        realizedR: chunkR,
        fee: 0,
        slippage: 0,
      });

      lot.events.push(tp1Event);
      newEvents.push(tp1Event);

      const totalInitialRisk = initialRiskPerUnit * lot.initialQuantity;
      lot.realizedR = Number((lot.realizedPnl / Math.max(0.01, totalInitialRisk)).toFixed(2));

      return {
        lot,
        events: newEvents,
        isClosed: false,
        state: SignalState.TP1_HIT,
      };
    }

    return {
      lot,
      events: newEvents,
      isClosed: false,
      state: hasAlreadyTp1 ? SignalState.TP1_HIT : SignalState.ACTIVE,
    };
  }

  /**
   * Compatibility wrapper for signal evaluation against raw candles
   */
  static evaluateTick(signal: ISignalSetup, candle: ICandle): ITradeStateUpdate {
    const { direction, state, entryZone, stopLoss, takeProfits, riskRewardRatios, symbol } = signal;
    const isLong = isLongPosition(direction);
    const currentPrice = candle.close;
    const high = candle.high;
    const low = candle.low;

    const rr1 = riskRewardRatios?.rr1 || 1.5;
    const rr2 = riskRewardRatios?.rr2 || 2.5;
    const rr3 = riskRewardRatios?.rr3 || 4.0;

    // 1. Pending Signal
    if (state === SignalState.PENDING) {
      const isEntryHit = isLong
        ? low <= entryZone.max && high >= entryZone.min
        : high >= entryZone.min && low <= entryZone.max;

      if (isEntryHit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.PENDING,
          newState: SignalState.ACTIVE,
          currentPrice: entryZone.optimal,
          pnlRMultiple: 0,
          isClosed: false,
          notes: `Signal activated at entry price ${entryZone.optimal}`,
        };
      }

      const isInvalidBeforeEntry = isLong ? low <= stopLoss : high >= stopLoss;
      if (isInvalidBeforeEntry) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.PENDING,
          newState: SignalState.INVALIDATED,
          currentPrice,
          pnlRMultiple: 0,
          isClosed: true,
          notes: `Signal invalidated: Stop breach prior to entry`,
        };
      }

      return {
        signalId: signal.id,
        symbol,
        previousState: SignalState.PENDING,
        newState: SignalState.PENDING,
        currentPrice,
        pnlRMultiple: 0,
        isClosed: false,
        notes: 'Awaiting entry trigger',
      };
    }

    // 2. Active Trade
    if (state === SignalState.ACTIVE) {
      const isSlHit = isLong ? low <= stopLoss : high >= stopLoss;
      if (isSlHit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.ACTIVE,
          newState: SignalState.SL_HIT,
          currentPrice: stopLoss,
          pnlRMultiple: -1.0,
          isClosed: true,
          notes: `Initial Stop loss hit at ${stopLoss}`,
        };
      }

      const isTp3Hit = isLong ? high >= takeProfits.tp3 : low <= takeProfits.tp3;
      if (isTp3Hit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.ACTIVE,
          newState: SignalState.TP3_HIT,
          currentPrice: takeProfits.tp3,
          pnlRMultiple: rr3,
          isClosed: true,
          notes: `Target 3 reached at ${takeProfits.tp3} (+${rr3}R)`,
        };
      }

      const isTp2Hit = isLong ? high >= takeProfits.tp2 : low <= takeProfits.tp2;
      if (isTp2Hit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.ACTIVE,
          newState: SignalState.TP2_HIT,
          currentPrice: takeProfits.tp2,
          pnlRMultiple: rr2,
          isClosed: true,
          notes: `Target 2 reached at ${takeProfits.tp2} (+${rr2}R)`,
        };
      }

      const isTp1Hit = isLong ? high >= takeProfits.tp1 : low <= takeProfits.tp1;
      if (isTp1Hit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.ACTIVE,
          newState: SignalState.TP1_HIT,
          currentPrice: takeProfits.tp1,
          pnlRMultiple: rr1,
          isClosed: false,
          notes: `Target 1 reached at ${takeProfits.tp1} (+${rr1}R). Trailing stop to Breakeven.`,
        };
      }
    }

    // 3. Runner active after TP1 hit (SL is trailed to entry price breakeven)
    if (state === SignalState.TP1_HIT) {
      const isTp3Hit = isLong ? high >= takeProfits.tp3 : low <= takeProfits.tp3;
      if (isTp3Hit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.TP1_HIT,
          newState: SignalState.TP3_HIT,
          currentPrice: takeProfits.tp3,
          pnlRMultiple: rr3,
          isClosed: true,
          notes: `Target 3 reached at ${takeProfits.tp3} (+${rr3}R)`,
        };
      }

      const isTp2Hit = isLong ? high >= takeProfits.tp2 : low <= takeProfits.tp2;
      if (isTp2Hit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.TP1_HIT,
          newState: SignalState.TP2_HIT,
          currentPrice: takeProfits.tp2,
          pnlRMultiple: rr2,
          isClosed: true,
          notes: `Target 2 reached at ${takeProfits.tp2} (+${rr2}R)`,
        };
      }

      const isTrailingSlHit = isLong ? low <= entryZone.optimal : high >= entryZone.optimal;
      if (isTrailingSlHit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.TP1_HIT,
          newState: SignalState.TP1_HIT,
          currentPrice: entryZone.optimal,
          pnlRMultiple: rr1 * 0.3, // Partial gain locked from TP1
          isClosed: true,
          notes: `Trailing stop triggered at Breakeven entry price ${entryZone.optimal}`,
        };
      }
    }

    return {
      signalId: signal.id,
      symbol,
      previousState: state,
      newState: state,
      currentPrice,
      pnlRMultiple: 0,
      isClosed: false,
      notes: 'Trade active in runner phase',
    };
  }
}
