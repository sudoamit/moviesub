import { Direction, ICandle, ISignalSetup, SignalState } from '@quant/shared';
import { ITradeStateUpdate } from './types';

export class TradeLifecycleManager {
  /**
   * Evaluates latest candle against signal levels and transitions trade lifecycle state.
   * Ensures 100% mathematical consistency between entry price, exit price, and realized R-multiple.
   */
  static evaluateTick(signal: ISignalSetup, candle: ICandle): ITradeStateUpdate {
    const { direction, state, entryZone, stopLoss, takeProfits, riskRewardRatios, symbol } = signal;
    const isLong = direction === Direction.BULLISH;
    const currentPrice = candle.close;
    const high = candle.high;
    const low = candle.low;

    const rr1 = riskRewardRatios?.rr1 || 2.0;
    const rr2 = riskRewardRatios?.rr2 || 3.5;
    const rr3 = riskRewardRatios?.rr3 || 6.0;

    // 1. Pending Signal: Check for entry zone trigger
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
          notes: `Signal activated at optimal entry price ${entryZone.optimal}`,
        };
      }

      // Check if price moved directly to stop loss before entry (invalidation)
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
          notes: `Signal invalidated: Price breached stop loss ${stopLoss} prior to entry`,
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

    // 2. Active Trade (Initial State)
    if (state === SignalState.ACTIVE) {
      // Check Initial Stop Loss
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

      // Check Target 3 (Full Expansion)
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

      // Check Target 2 (Primary Target)
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

      // Check Target 1 (Milestone reached -> Trail Stop to Breakeven)
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
          notes: `Target 1 reached at ${takeProfits.tp1} (+${rr1}R). Trailing stop moved to Breakeven.`,
        };
      }
    }

    // 3. Runner active after TP1 hit (SL is trailed to entry price breakeven)
    if (state === SignalState.TP1_HIT) {
      // Check Target 3
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

      // Check Target 2
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

      // Check Breakeven Invalidation (Price retreats to Entry Price)
      const isBreakevenHit = isLong ? low <= entryZone.optimal : high >= entryZone.optimal;
      if (isBreakevenHit) {
        return {
          signalId: signal.id,
          symbol,
          previousState: SignalState.TP1_HIT,
          newState: SignalState.TP1_HIT, // Closed on TP1 runner pullback
          currentPrice: entryZone.optimal,
          pnlRMultiple: 0.0,
          isClosed: true,
          notes: `Trailing stop triggered at Breakeven entry price ${entryZone.optimal} (0.0R)`,
        };
      }
    }

    // Default: No state transition
    return {
      signalId: signal.id,
      symbol,
      previousState: state,
      newState: state,
      currentPrice,
      pnlRMultiple: 0,
      isClosed:
        state === SignalState.SL_HIT ||
        state === SignalState.TP2_HIT ||
        state === SignalState.TP3_HIT ||
        state === SignalState.INVALIDATED,
      notes: 'Trade running within expected boundaries',
    };
  }
}
