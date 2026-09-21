import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  Direction,
  ExecutionQualityReport,
  IExecutionCostDomainService,
  ItemizedChargeParams,
  ItemizedExecutionCost,
  MarketImpactParams,
  MarketImpactResult,
  SlippageEstimateParams,
  SlippageEstimateResult,
  TotalCostParams,
  TotalExecutionCostResult,
} from '@quant/shared';

@Injectable()
export class ExecutionCostService implements IExecutionCostDomainService {
  private readonly logger = new Logger(ExecutionCostService.name);

  /**
   * Calculates market impact using non-linear Almgren-Chriss square-root law or linear models.
   * Square root: Impact = Y * sigma_daily * sqrt(Q / ADV)
   */
  calculateMarketImpact(params: MarketImpactParams): MarketImpactResult {
    const {
      orderQuantity,
      averageDailyVolume,
      price,
      dailyVolatility = 0.015, // 1.5% daily volatility baseline
      modelType = 'ALMGREN_CHRISS_SQUARE_ROOT',
      impactConstant = 0.6, // Y constant (typically 0.5 - 0.7)
      linearGamma = 0.1,
    } = params;

    if (orderQuantity <= 0 || price <= 0 || !Number.isFinite(orderQuantity) || !Number.isFinite(price)) {
      throw new BadRequestException('Order quantity and price must be positive finite numbers');
    }

    if (modelType === 'ZERO') {
      return {
        modelType: 'ZERO',
        participationRate: 0,
        impactBps: 0,
        impactPriceDelta: 0,
        estimatedImpactCost: 0,
      };
    }

    if (modelType === 'FIXED_BPS') {
      const impactBps = 5; // Fixed 5 bps
      const impactPriceDelta = (price * impactBps) / 10000;
      return {
        modelType: 'FIXED_BPS',
        participationRate: 0,
        impactBps,
        impactPriceDelta,
        estimatedImpactCost: impactPriceDelta * orderQuantity,
      };
    }

    const safeADV = averageDailyVolume > 0 && Number.isFinite(averageDailyVolume) ? averageDailyVolume : 1000000;
    const participationRate = orderQuantity / safeADV;

    let impactBps = 0;
    if (modelType === 'ALMGREN_CHRISS_SQUARE_ROOT') {
      // Impact = Y * sigma * sqrt(Q / ADV) * 10,000 (in basis points)
      const rawImpact = impactConstant * dailyVolatility * Math.sqrt(participationRate);
      impactBps = rawImpact * 10000;
    } else if (modelType === 'LINEAR') {
      // Impact = gamma * (Q / ADV) * 10,000
      impactBps = linearGamma * participationRate * 10000;
    }

    // Cap market impact at 500 bps (5.0%) to prevent numerical explosions on small ADV
    const cappedImpactBps = Math.min(500, Math.max(0, impactBps));
    const impactPriceDelta = (price * cappedImpactBps) / 10000;
    const estimatedImpactCost = impactPriceDelta * orderQuantity;

    return {
      modelType,
      participationRate,
      impactBps: Number(cappedImpactBps.toFixed(4)),
      impactPriceDelta: Number(impactPriceDelta.toFixed(4)),
      estimatedImpactCost: Number(estimatedImpactCost.toFixed(2)),
    };
  }

  /**
   * Pre-trade slippage estimation incorporating bid-ask spread and market impact.
   * Fails closed if expected slippage exceeds max allowed budget.
   */
  estimateSlippage(params: SlippageEstimateParams): SlippageEstimateResult {
    const {
      direction,
      orderQuantity,
      referencePrice,
      bid,
      ask,
      averageDailyVolume = 1000000,
      dailyVolatility = 0.015,
      impactModel = 'ALMGREN_CHRISS_SQUARE_ROOT',
      urgency = 'AGGRESSIVE',
      maxSlippageBps = 50,
    } = params;

    if (referencePrice <= 0 || orderQuantity <= 0 || !Number.isFinite(referencePrice)) {
      throw new BadRequestException('Reference price and order quantity must be positive finite numbers');
    }

    // 1. Compute half-spread in basis points
    let halfSpreadBps = 2.0; // default 2 bps baseline
    if (bid !== undefined && ask !== undefined && ask >= bid && bid > 0) {
      const mid = (ask + bid) / 2;
      halfSpreadBps = ((ask - bid) / (2 * mid)) * 10000;
    }

    // 2. Compute market impact
    const impact = this.calculateMarketImpact({
      orderQuantity,
      averageDailyVolume,
      price: referencePrice,
      dailyVolatility,
      modelType: impactModel,
    });
    const marketImpactBps = impact.impactBps;

    // 3. Urgency weighting
    let spreadWeight = 1.0;
    let impactWeight = 1.0;
    if (urgency === 'NEUTRAL') {
      spreadWeight = 0.5;
      impactWeight = 0.75;
    } else if (urgency === 'PASSIVE') {
      spreadWeight = -0.25; // spread capture on resting orders
      impactWeight = 0.25;
    }

    const totalExpectedSlippageBps = Math.max(
      0,
      Number((halfSpreadBps * spreadWeight + marketImpactBps * impactWeight).toFixed(4)),
    );

    const expectedSlippageAmount = Number(
      ((referencePrice * totalExpectedSlippageBps) / 10000).toFixed(4),
    );

    // Directional price adjustment: BUY slips up, SELL slips down
    const isBuy =
      String(direction).toUpperCase() === 'BUY' ||
      String(direction).toUpperCase() === 'BULLISH' ||
      String(direction).toUpperCase() === 'LONG';

    const expectedFillPrice = isBuy
      ? Number((referencePrice + expectedSlippageAmount).toFixed(4))
      : Number((referencePrice - expectedSlippageAmount).toFixed(4));

    // Budget assertion
    const exceedsBudget = totalExpectedSlippageBps > maxSlippageBps;
    const actionAllowed = !exceedsBudget;
    const reason = exceedsBudget
      ? `Expected slippage ${totalExpectedSlippageBps.toFixed(2)} bps exceeds maximum allowed budget ${maxSlippageBps} bps`
      : undefined;

    return {
      referencePrice,
      expectedFillPrice,
      halfSpreadBps: Number(halfSpreadBps.toFixed(4)),
      marketImpactBps: Number(marketImpactBps.toFixed(4)),
      totalExpectedSlippageBps,
      expectedSlippageAmount,
      exceedsBudget,
      maxAllowedSlippageBps: maxSlippageBps,
      actionAllowed,
      reason,
    };
  }

  /**
   * Asserts slippage is within budget, throwing BadRequestException if exceeded.
   */
  assertSlippageWithinBudget(params: SlippageEstimateParams): void {
    const result = this.estimateSlippage(params);
    if (!result.actionAllowed) {
      throw new BadRequestException(result.reason);
    }
  }

  /**
   * Calculates itemized regulatory taxes, exchange turnover fees, and brokerage.
   * Strictly adheres to post-2024/2026 Indian tax laws (STT, Stamp Duty, GST, SEBI).
   */
  calculateItemizedCharges(params: ItemizedChargeParams): ItemizedExecutionCost {
    const {
      exchange,
      category,
      side,
      price,
      quantity,
      contractSize = 1,
      optionPremium,
      isMaker = false,
    } = params;

    const notional = price * quantity * contractSize;
    const isBuy = side.toUpperCase() === 'BUY';
    const isSell = side.toUpperCase() === 'SELL';

    // 1. Crypto Fees (BINANCE)
    if (exchange.toUpperCase() === 'BINANCE') {
      const feeRate = isMaker ? 0.0002 : 0.0004; // 2 bps maker, 4 bps taker
      const brokerage = Number((notional * feeRate).toFixed(2));
      return {
        brokerage,
        stt: 0,
        exchangeTurnover: 0,
        sebiCharges: 0,
        stampDuty: 0,
        gst: 0,
        totalTaxesAndCharges: brokerage,
      };
    }

    // 2. Indian Statutory Fees (NSE)
    // Brokerage: Flat ₹20 per executed order or 0.03% capped at ₹20
    const brokerage = Math.min(20, Math.max(0, Number((notional * 0.0003).toFixed(2))));

    let stt = 0;
    let exchangeTurnover = 0;
    let stampDuty = 0;
    const sebiCharges = Number((notional * 0.000001).toFixed(2)); // ₹10 per crore = 0.0001%

    switch (category) {
      case 'EQUITY_DELIVERY':
        // STT: 0.1% on both Buy and Sell
        stt = Number((notional * 0.001).toFixed(2));
        exchangeTurnover = Number((notional * 0.0000325).toFixed(2)); // 0.00325%
        stampDuty = isBuy ? Number((notional * 0.00015).toFixed(2)) : 0; // 0.015% on Buy
        break;

      case 'EQUITY_INTRADAY':
        // STT: 0.025% on Sell only
        stt = isSell ? Number((notional * 0.00025).toFixed(2)) : 0;
        exchangeTurnover = Number((notional * 0.0000325).toFixed(2));
        stampDuty = isBuy ? Number((notional * 0.00003).toFixed(2)) : 0; // 0.003% on Buy
        break;

      case 'FUTURES':
        // STT: 0.02% on Sell only (Budget 2024 revised)
        stt = isSell ? Number((notional * 0.0002).toFixed(2)) : 0;
        exchangeTurnover = Number((notional * 0.000019).toFixed(2)); // 0.0019%
        stampDuty = isBuy ? Number((notional * 0.00002).toFixed(2)) : 0; // 0.002% on Buy
        break;

      case 'OPTIONS': {
        // Options turnover is calculated on premium value
        const premiumVal = (optionPremium ?? price) * quantity * contractSize;
        // STT: 0.1% on Sell of option premium (Budget 2024 revised)
        stt = isSell ? Number((premiumVal * 0.001).toFixed(2)) : 0;
        exchangeTurnover = Number((premiumVal * 0.0005).toFixed(2)); // ~0.05% of premium
        stampDuty = isBuy ? Number((premiumVal * 0.00003).toFixed(2)) : 0; // 0.003% on Buy
        break;
      }

      default:
        exchangeTurnover = Number((notional * 0.0000325).toFixed(2));
        break;
    }

    // GST: 18% on (Brokerage + Exchange Turnover + SEBI Charges)
    const taxableAmount = brokerage + exchangeTurnover + sebiCharges;
    const gst = Number((taxableAmount * 0.18).toFixed(2));

    const totalTaxesAndCharges = Number(
      (brokerage + stt + exchangeTurnover + sebiCharges + stampDuty + gst).toFixed(2),
    );

    return {
      brokerage,
      stt,
      exchangeTurnover,
      sebiCharges,
      stampDuty,
      gst,
      totalTaxesAndCharges,
    };
  }

  /**
   * Combines itemized statutory charges and expected market slippage into total execution cost.
   */
  calculateTotalExecutionCost(params: TotalCostParams): TotalExecutionCostResult {
    const slippageEstimate = this.estimateSlippage(params.slippageParams);
    const itemizedCharges = this.calculateItemizedCharges(params.chargeParams);

    const notional =
      params.chargeParams.price *
      params.chargeParams.quantity *
      (params.chargeParams.contractSize ?? 1);

    const totalExpectedCostAccount = Number(
      (itemizedCharges.totalTaxesAndCharges + slippageEstimate.expectedSlippageAmount).toFixed(2),
    );

    const costBpsOfNotional =
      notional > 0 ? Number(((totalExpectedCostAccount / notional) * 10000).toFixed(2)) : 0;

    return {
      itemizedCharges,
      slippageEstimate,
      totalExpectedCostAccount,
      costBpsOfNotional,
    };
  }

  /**
   * Post-trade execution quality & slippage drift analysis.
   */
  analyzeExecutionQuality(
    orderId: string,
    expectedSlippageBps: number,
    realizedSlippageBps: number,
  ): ExecutionQualityReport {
    const slippageDriftBps = Number((realizedSlippageBps - expectedSlippageBps).toFixed(4));

    let qualityAssessment: 'SUPERIOR' | 'IN_LINE' | 'DEGRADED' | 'EXCESSIVE' = 'IN_LINE';
    if (slippageDriftBps <= -2) {
      qualityAssessment = 'SUPERIOR'; // Beat expected slippage by > 2 bps
    } else if (slippageDriftBps <= 5) {
      qualityAssessment = 'IN_LINE';
    } else if (slippageDriftBps <= 15) {
      qualityAssessment = 'DEGRADED';
    } else {
      qualityAssessment = 'EXCESSIVE';
    }

    const details = `Order ${orderId}: Expected ${expectedSlippageBps.toFixed(2)} bps vs Realized ${realizedSlippageBps.toFixed(2)} bps (Drift: ${slippageDriftBps > 0 ? '+' : ''}${slippageDriftBps.toFixed(2)} bps) -> ${qualityAssessment}`;

    return {
      orderId,
      expectedSlippageBps,
      realizedSlippageBps,
      slippageDriftBps,
      qualityAssessment,
      details,
    };
  }
}
