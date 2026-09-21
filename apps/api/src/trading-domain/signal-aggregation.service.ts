import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  AggregatedSignalResult,
  AggregationOptions,
  ConflictResolutionMode,
  ContributingSignalSummary,
  Direction,
  ISignalAggregationDomainService,
  MultiTimeframeConfluenceParams,
  MultiTimeframeConfluenceResult,
  StrategySignal,
} from '@quant/shared';

@Injectable()
export class SignalAggregationService implements ISignalAggregationDomainService {
  private readonly logger = new Logger(SignalAggregationService.name);

  /**
   * Applies exponential half-life decay to a signal's confidence:
   * C(t) = C_0 * 2^(-dt / halfLife)
   */
  applySignalDecay(signal: StrategySignal, referenceTime: Date = new Date()): number {
    const signalTime = new Date(signal.timestamp).getTime();
    const refTime = referenceTime.getTime();
    const elapsedMs = Math.max(0, refTime - signalTime);

    const halfLifeMs = signal.halfLifeMs ?? 300000; // default 5 minutes
    if (halfLifeMs <= 0 || !Number.isFinite(halfLifeMs)) {
      return signal.confidence;
    }

    const decayFactor = Math.pow(2, -elapsedMs / halfLifeMs);
    const decayedConfidence = signal.confidence * decayFactor;

    return Math.max(0, Math.min(1.0, decayedConfidence));
  }

  /**
   * Checks whether a signal has expired due to exceeding max age or dropping below confidence floor.
   */
  isSignalExpired(
    signal: StrategySignal,
    referenceTime: Date = new Date(),
    maxAgeMs?: number,
    minConfidenceFloor = 0.05,
  ): boolean {
    const signalTime = new Date(signal.timestamp).getTime();
    const refTime = referenceTime.getTime();
    const elapsedMs = Math.max(0, refTime - signalTime);

    const halfLifeMs = signal.halfLifeMs ?? 300000;
    const effectiveMaxAge = maxAgeMs ?? 4 * halfLifeMs; // 4 half-lives default

    if (elapsedMs > effectiveMaxAge) {
      return true;
    }

    const decayedConfidence = this.applySignalDecay(signal, referenceTime);
    return decayedConfidence < minConfidenceFloor;
  }

  /**
   * Aggregates multiple concurrent strategy signals for a symbol into a unified conviction decision.
   */
  aggregateSignals(
    signals: StrategySignal[],
    options: AggregationOptions = {},
  ): AggregatedSignalResult {
    const refTime = options.referenceTime ?? new Date();
    const mode: ConflictResolutionMode = options.resolutionMode ?? 'NET_POSITIONING';

    if (!Array.isArray(signals) || signals.length === 0) {
      return {
        symbol: 'UNKNOWN',
        action: 'NEUTRAL',
        netScore: 0,
        compositeConfidence: 0,
        resolutionMode: mode,
        conflictsDetected: false,
        contributingSignals: [],
        confluenceMultiplier: 1.0,
        reason: 'No strategy signals provided for aggregation',
      };
    }

    const symbol = signals[0].symbol;

    // Evaluate decay and expiration for each signal
    const contributingSummaries: ContributingSignalSummary[] = [];
    const activeSignals: StrategySignal[] = [];

    for (const s of signals) {
      const isExpired = this.isSignalExpired(
        s,
        refTime,
        options.maxSignalAgeMs,
        options.expirationConfidenceFloor,
      );
      const decayedConfidence = this.applySignalDecay(s, refTime);
      const ageSeconds = Math.max(0, Math.floor((refTime.getTime() - new Date(s.timestamp).getTime()) / 1000));

      contributingSummaries.push({
        signalId: s.signalId,
        strategyType: s.strategyType,
        direction: s.direction,
        rawConfidence: s.confidence,
        decayedConfidence,
        weight: s.weight ?? 1.0,
        priority: s.priority ?? 1,
        isExpired,
        ageSeconds,
      });

      if (!isExpired) {
        activeSignals.push(s);
      }
    }

    // If all signals have expired
    if (activeSignals.length === 0) {
      return {
        symbol,
        action: 'NEUTRAL',
        netScore: 0,
        compositeConfidence: 0,
        resolutionMode: mode,
        conflictsDetected: false,
        contributingSignals: contributingSummaries,
        confluenceMultiplier: 1.0,
        reason: 'All strategy signals have expired due to time decay or age thresholds',
      };
    }

    // Resolve conflict among active signals
    const conflictResult = this.resolveDirectionalConflict(activeSignals, mode, options);

    return {
      ...conflictResult,
      symbol,
      contributingSignals: contributingSummaries,
    };
  }

  /**
   * Resolves directional conflicts across signals using specified mode:
   * - NET_POSITIONING: weighted confidence delta with threshold
   * - PRIORITY_ARBITRATION: strategic priority hierarchy
   * - CANCEL_OUT: zero-tolerance opposing signal veto
   * - HTF_ALIGNMENT_ONLY: macro trend directional gate
   */
  resolveDirectionalConflict(
    signals: StrategySignal[],
    mode: ConflictResolutionMode = 'NET_POSITIONING',
    options: AggregationOptions = {},
  ): AggregatedSignalResult {
    const refTime = options.referenceTime ?? new Date();
    const threshold = options.netConvictionThreshold ?? 0.15;
    const symbol = signals[0]?.symbol ?? 'UNKNOWN';

    const isBuy = (d: any) => {
      const u = String(d).toUpperCase();
      return u === 'BUY' || u === 'BULLISH' || u === 'LONG';
    };
    const isSell = (d: any) => {
      const u = String(d).toUpperCase();
      return u === 'SELL' || u === 'BEARISH' || u === 'SHORT';
    };

    const buySignals = signals.filter((s) => isBuy(s.direction));
    const sellSignals = signals.filter((s) => isSell(s.direction));

    const hasBuy = buySignals.length > 0;
    const hasSell = sellSignals.length > 0;
    const conflictsDetected = hasBuy && hasSell;

    // Helper to calculate weighted confidence of a single direction
    const calcWeightedConfidence = (items: StrategySignal[]): number => {
      let sumWeighted = 0;
      let sumWeight = 0;
      for (const s of items) {
        const decayed = this.applySignalDecay(s, refTime);
        const w = s.weight ?? 1.0;
        sumWeighted += decayed * w;
        sumWeight += w;
      }
      return sumWeight > 0 ? sumWeighted / sumWeight : 0;
    };

    // Helper to derive consensus entry and exit levels
    const derivePriceLevels = (items: StrategySignal[]) => {
      const withEntry = items.filter((s) => s.entryPrice && s.entryPrice > 0);
      const withSL = items.filter((s) => s.stopLoss && s.stopLoss > 0);
      const withTP = items.filter((s) => s.takeProfit && s.takeProfit > 0);

      const avg = (arr: StrategySignal[], prop: 'entryPrice' | 'stopLoss' | 'takeProfit') =>
        arr.length > 0 ? arr.reduce((sum, s) => sum + (s[prop] || 0), 0) / arr.length : undefined;

      return {
        suggestedEntryPrice: avg(withEntry, 'entryPrice'),
        suggestedStopLoss: avg(withSL, 'stopLoss'),
        suggestedTakeProfit: avg(withTP, 'takeProfit'),
      };
    };

    // Case 1: Unanimous BUY
    if (hasBuy && !hasSell) {
      const conf = calcWeightedConfidence(buySignals);
      const levels = derivePriceLevels(buySignals);
      return {
        symbol,
        action: 'BUY',
        netScore: conf,
        compositeConfidence: conf,
        resolutionMode: mode,
        conflictsDetected: false,
        contributingSignals: [],
        confluenceMultiplier: 1.0,
        ...levels,
        reason: `Unanimous BUY consensus across ${buySignals.length} strategy signals`,
      };
    }

    // Case 2: Unanimous SELL
    if (hasSell && !hasBuy) {
      const conf = calcWeightedConfidence(sellSignals);
      const levels = derivePriceLevels(sellSignals);
      return {
        symbol,
        action: 'SELL',
        netScore: -conf,
        compositeConfidence: conf,
        resolutionMode: mode,
        conflictsDetected: false,
        contributingSignals: [],
        confluenceMultiplier: 1.0,
        ...levels,
        reason: `Unanimous SELL consensus across ${sellSignals.length} strategy signals`,
      };
    }

    // Case 3: Conflicting signals (both BUY and SELL present)
    const conflictDetails = `Conflict detected: ${buySignals.length} BUY vs ${sellSignals.length} SELL signals`;

    // 3A. CANCEL_OUT Mode: Immediate Neutralization
    if (mode === 'CANCEL_OUT') {
      return {
        symbol,
        action: 'NEUTRAL',
        netScore: 0,
        compositeConfidence: 0,
        resolutionMode: mode,
        conflictsDetected: true,
        conflictDetails,
        contributingSignals: [],
        confluenceMultiplier: 0,
        reason: `Opposing directional signals detected under CANCEL_OUT mode; trade suppressed. (${conflictDetails})`,
      };
    }

    // 3B. PRIORITY_ARBITRATION Mode: Strategic Precedence
    if (mode === 'PRIORITY_ARBITRATION') {
      const maxBuyPriority = Math.max(...buySignals.map((s) => s.priority ?? 1));
      const maxSellPriority = Math.max(...sellSignals.map((s) => s.priority ?? 1));

      if (maxBuyPriority > maxSellPriority) {
        const winningSignals = buySignals.filter((s) => (s.priority ?? 1) === maxBuyPriority);
        const conf = calcWeightedConfidence(winningSignals);
        const levels = derivePriceLevels(winningSignals);
        return {
          symbol,
          action: 'BUY',
          netScore: conf,
          compositeConfidence: conf,
          resolutionMode: mode,
          conflictsDetected: true,
          conflictDetails: `Priority arbitration: BUY priority (${maxBuyPriority}) overruled SELL priority (${maxSellPriority})`,
          contributingSignals: [],
          confluenceMultiplier: 1.0,
          ...levels,
          reason: `BUY executed via priority arbitration (${maxBuyPriority} > ${maxSellPriority})`,
        };
      } else if (maxSellPriority > maxBuyPriority) {
        const winningSignals = sellSignals.filter((s) => (s.priority ?? 1) === maxSellPriority);
        const conf = calcWeightedConfidence(winningSignals);
        const levels = derivePriceLevels(winningSignals);
        return {
          symbol,
          action: 'SELL',
          netScore: -conf,
          compositeConfidence: conf,
          resolutionMode: mode,
          conflictsDetected: true,
          conflictDetails: `Priority arbitration: SELL priority (${maxSellPriority}) overruled BUY priority (${maxBuyPriority})`,
          contributingSignals: [],
          confluenceMultiplier: 1.0,
          ...levels,
          reason: `SELL executed via priority arbitration (${maxSellPriority} > ${maxBuyPriority})`,
        };
      }
      // Tied priority: fall through to NET_POSITIONING
    }

    // 3C. HTF_ALIGNMENT_ONLY Mode
    if (mode === 'HTF_ALIGNMENT_ONLY' && options.htfBias) {
      const bias = String(options.htfBias).toUpperCase();
      if (bias === 'BUY' && buySignals.length > 0) {
        const conf = calcWeightedConfidence(buySignals);
        const levels = derivePriceLevels(buySignals);
        return {
          symbol,
          action: 'BUY',
          netScore: conf,
          compositeConfidence: conf,
          resolutionMode: mode,
          conflictsDetected: true,
          conflictDetails: `HTF trend bias (${bias}) selected BUY signals and filtered out ${sellSignals.length} opposing SELL signals`,
          contributingSignals: [],
          confluenceMultiplier: 1.0,
          ...levels,
          reason: `BUY executed: aligned with higher-timeframe trend bias (${bias})`,
        };
      } else if (bias === 'SELL' && sellSignals.length > 0) {
        const conf = calcWeightedConfidence(sellSignals);
        const levels = derivePriceLevels(sellSignals);
        return {
          symbol,
          action: 'SELL',
          netScore: -conf,
          compositeConfidence: conf,
          resolutionMode: mode,
          conflictsDetected: true,
          conflictDetails: `HTF trend bias (${bias}) selected SELL signals and filtered out ${buySignals.length} opposing BUY signals`,
          contributingSignals: [],
          confluenceMultiplier: 1.0,
          ...levels,
          reason: `SELL executed: aligned with higher-timeframe trend bias (${bias})`,
        };
      }
    }

    // 3D. NET_POSITIONING Mode (Default & Tie-breaker)
    let totalBuyWeight = 0;
    for (const s of buySignals) {
      totalBuyWeight += (s.weight ?? 1.0) * this.applySignalDecay(s, refTime);
    }

    let totalSellWeight = 0;
    for (const s of sellSignals) {
      totalSellWeight += (s.weight ?? 1.0) * this.applySignalDecay(s, refTime);
    }

    const combinedWeight = totalBuyWeight + totalSellWeight;
    const netScore = combinedWeight > 0 ? (totalBuyWeight - totalSellWeight) / combinedWeight : 0;

    if (netScore >= threshold) {
      const levels = derivePriceLevels(buySignals);
      return {
        symbol,
        action: 'BUY',
        netScore,
        compositeConfidence: Math.abs(netScore) * calcWeightedConfidence(buySignals),
        resolutionMode: mode,
        conflictsDetected: true,
        conflictDetails: `Net positioning BUY: Net ${netScore.toFixed(3)} >= threshold ${threshold}`,
        contributingSignals: [],
        confluenceMultiplier: 1.0,
        ...levels,
        reason: `BUY consensus via net positioning (Net Score: ${netScore.toFixed(3)} >= ${threshold})`,
      };
    } else if (netScore <= -threshold) {
      const levels = derivePriceLevels(sellSignals);
      return {
        symbol,
        action: 'SELL',
        netScore,
        compositeConfidence: Math.abs(netScore) * calcWeightedConfidence(sellSignals),
        resolutionMode: mode,
        conflictsDetected: true,
        conflictDetails: `Net positioning SELL: Net ${netScore.toFixed(3)} <= -${threshold}`,
        contributingSignals: [],
        confluenceMultiplier: 1.0,
        ...levels,
        reason: `SELL consensus via net positioning (Net Score: ${netScore.toFixed(3)} <= -${threshold})`,
      };
    } else {
      return {
        symbol,
        action: 'NEUTRAL',
        netScore,
        compositeConfidence: 0,
        resolutionMode: mode,
        conflictsDetected: true,
        conflictDetails: `Indecisive net score ${netScore.toFixed(3)} within [-${threshold}, ${threshold}]`,
        contributingSignals: [],
        confluenceMultiplier: 0,
        reason: `Signals neutralized: Net score ${netScore.toFixed(3)} does not meet conviction threshold of ${threshold}`,
      };
    }
  }

  /**
   * Multi-timeframe confluence scoring: combines HTF institutional trend bias with LTF trigger.
   */
  calculateMultiTimeframeConfluence(
    params: MultiTimeframeConfluenceParams,
  ): MultiTimeframeConfluenceResult {
    const {
      htfSignal,
      ltfSignal,
      alignmentBoost = 0.5,
      counterTrendPenalty = 0.5,
      strictAlignment = false,
    } = params;

    const htfDir = String(htfSignal.direction).toUpperCase();
    const ltfDir = String(ltfSignal.direction).toUpperCase();

    const isAligned = htfDir === ltfDir;

    if (isAligned) {
      const confluenceMultiplier = 1.0 + alignmentBoost * htfSignal.confidence;
      const finalConfidence = Math.min(1.0, ltfSignal.confidence * confluenceMultiplier);

      return {
        isAligned: true,
        compositeDirection: ltfDir as 'BUY' | 'SELL',
        confluenceMultiplier,
        finalConfidence,
        status: 'ALIGNED',
        details: `Aligned with HTF trend (${htfDir}). Confidence boosted from ${ltfSignal.confidence.toFixed(2)} to ${finalConfidence.toFixed(2)} (+${((confluenceMultiplier - 1) * 100).toFixed(0)}%)`,
      };
    }

    // Counter-trend conflict
    if (strictAlignment) {
      return {
        isAligned: false,
        compositeDirection: 'NEUTRAL',
        confluenceMultiplier: 0,
        finalConfidence: 0,
        status: 'COUNTER_TREND_REJECTED',
        details: `LTF ${ltfDir} trade strictly rejected: opposes HTF ${htfDir} institutional trend`,
      };
    }

    // Penalized mode
    const confluenceMultiplier = Math.max(0.1, 1.0 - counterTrendPenalty * htfSignal.confidence);
    const finalConfidence = ltfSignal.confidence * confluenceMultiplier;

    return {
      isAligned: false,
      compositeDirection: ltfDir as 'BUY' | 'SELL',
      confluenceMultiplier,
      finalConfidence,
      status: 'COUNTER_TREND_PENALIZED',
      details: `Counter-trend LTF ${ltfDir} penalized by HTF ${htfDir}. Confidence reduced from ${ltfSignal.confidence.toFixed(2)} to ${finalConfidence.toFixed(2)} (-${((1 - confluenceMultiplier) * 100).toFixed(0)}%)`,
    };
  }
}
