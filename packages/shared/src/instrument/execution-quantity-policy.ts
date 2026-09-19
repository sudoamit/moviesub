import { getAuthoritativeDescriptor, InstrumentDescriptor } from './instrument-descriptor';

export type QuantityModel = 'EXCHANGE_LOT_DISCRETE' | 'FRACTIONAL_SIMULATION';

export interface QuantityPolicyRules {
  minQuantity: number;
  maxQuantity: number;
  quantityPrecision: number;
  lotSize: number;
  scaleOutPrecision: number;
  minimumExecutableScale: number;
  allowedQuantityModel: QuantityModel;
}

export interface ScaleOutQuantities {
  tp1Quantity: number;
  tp2Quantity: number;
  tp3Quantity: number;
  quantityModel: QuantityModel;
}

export class ExecutionQuantityPolicy {
  private static readonly RULES: Record<string, QuantityPolicyRules> = {
    NIFTY: {
      minQuantity: 65,
      maxQuantity: 1800,
      quantityPrecision: 0,
      lotSize: 65,
      scaleOutPrecision: 1, // Paper trading simulation supports fractional precision tagged as FRACTIONAL_SIMULATION
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    BANKNIFTY: {
      minQuantity: 15,
      maxQuantity: 900,
      quantityPrecision: 0,
      lotSize: 15,
      scaleOutPrecision: 1,
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    BTCUSDT_SPOT: {
      minQuantity: 0.0001,
      maxQuantity: 100,
      quantityPrecision: 4,
      lotSize: 0.0001,
      scaleOutPrecision: 4,
      minimumExecutableScale: 0.0001,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    XAUUSD: {
      minQuantity: 0.01,
      maxQuantity: 500,
      quantityPrecision: 2,
      lotSize: 0.01,
      scaleOutPrecision: 2,
      minimumExecutableScale: 0.01,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    RELIANCE: {
      minQuantity: 1,
      maxQuantity: 10000,
      quantityPrecision: 0,
      lotSize: 1,
      scaleOutPrecision: 0,
      minimumExecutableScale: 1,
      allowedQuantityModel: 'EXCHANGE_LOT_DISCRETE',
    },
    HDFCBANK: {
      minQuantity: 1,
      maxQuantity: 10000,
      quantityPrecision: 0,
      lotSize: 1,
      scaleOutPrecision: 0,
      minimumExecutableScale: 1,
      allowedQuantityModel: 'EXCHANGE_LOT_DISCRETE',
    },
    INFY: {
      minQuantity: 1,
      maxQuantity: 10000,
      quantityPrecision: 0,
      lotSize: 1,
      scaleOutPrecision: 0,
      minimumExecutableScale: 1,
      allowedQuantityModel: 'EXCHANGE_LOT_DISCRETE',
    },
  };

  public static getRules(symbol: string): QuantityPolicyRules {
    const descriptor = getAuthoritativeDescriptor(symbol);
    const rules = this.RULES[descriptor.canonicalSymbol];
    if (!rules) {
      return {
        minQuantity: descriptor.lotSize,
        maxQuantity: 100000,
        quantityPrecision: descriptor.quantityPrecision,
        lotSize: descriptor.lotSize,
        scaleOutPrecision: descriptor.quantityPrecision,
        minimumExecutableScale: descriptor.lotSize,
        allowedQuantityModel: descriptor.quantityPrecision > 0 ? 'FRACTIONAL_SIMULATION' : 'EXCHANGE_LOT_DISCRETE',
      };
    }
    return rules;
  }

  /**
   * Computes the canonical 3-stage scale-out quantities:
   * TP1: 30%
   * TP2: 30%
   * TP3: remaining (40%)
   */
  public static calculateScaleOutPlan(symbol: string, initialQuantity: number): ScaleOutQuantities {
    const rules = this.getRules(symbol);
    const isDiscrete = rules.allowedQuantityModel === 'EXCHANGE_LOT_DISCRETE';

    if (isDiscrete && initialQuantity === 1) {
      // Single-lot cash equities cannot partial scale-out; closes 100% on runner or manual exit
      return {
        tp1Quantity: 0,
        tp2Quantity: 0,
        tp3Quantity: 1,
        quantityModel: 'EXCHANGE_LOT_DISCRETE',
      };
    }

    // 30% TP1
    const rawTp1 = initialQuantity * 0.3;
    const tp1Quantity = Number(rawTp1.toFixed(rules.scaleOutPrecision));

    // 30% TP2
    const rawTp2 = initialQuantity * 0.3;
    const tp2Quantity = Number(rawTp2.toFixed(rules.scaleOutPrecision));

    // Remaining for TP3
    const tp3Quantity = Number((initialQuantity - tp1Quantity - tp2Quantity).toFixed(rules.scaleOutPrecision));

    return {
      tp1Quantity,
      tp2Quantity,
      tp3Quantity,
      quantityModel: rules.allowedQuantityModel,
    };
  }
}
