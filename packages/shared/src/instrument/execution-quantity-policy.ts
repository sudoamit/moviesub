import { getAuthoritativeDescriptor, InstrumentDescriptor } from './instrument-descriptor';

export type QuantityModel = 'EXCHANGE_LOT_DISCRETE' | 'FRACTIONAL_SIMULATION';
export type ExecutionEnvironment = 'SIMULATION' | 'EXCHANGE_EXECUTION';

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
    NIFTY_SPOT: {
      minQuantity: 65,
      maxQuantity: 1800,
      quantityPrecision: 0,
      lotSize: 65,
      scaleOutPrecision: 1,
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    BANKNIFTY_SPOT: {
      minQuantity: 15,
      maxQuantity: 900,
      quantityPrecision: 0,
      lotSize: 15,
      scaleOutPrecision: 1,
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    NIFTY_OPTION: {
      minQuantity: 65,
      maxQuantity: 1800,
      quantityPrecision: 0,
      lotSize: 65,
      scaleOutPrecision: 1,
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    BANKNIFTY_OPTION: {
      minQuantity: 15,
      maxQuantity: 900,
      quantityPrecision: 0,
      lotSize: 15,
      scaleOutPrecision: 1,
      minimumExecutableScale: 0.1,
      allowedQuantityModel: 'FRACTIONAL_SIMULATION',
    },
    NIFTY: {
      minQuantity: 65,
      maxQuantity: 1800,
      quantityPrecision: 0,
      lotSize: 65,
      scaleOutPrecision: 1,
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
    XAUUSD_SPOT: {
      minQuantity: 0.01,
      maxQuantity: 500,
      quantityPrecision: 2,
      lotSize: 0.01,
      scaleOutPrecision: 2,
      minimumExecutableScale: 0.01,
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
    const rules =
      this.RULES[descriptor.canonicalSymbol] ||
      this.RULES[symbol.toUpperCase()] ||
      this.RULES[symbol.split(' ')[0].toUpperCase()];

    if (!rules) {
      return {
        minQuantity: descriptor.lotSize,
        maxQuantity: 100000,
        quantityPrecision: descriptor.quantityPrecision,
        lotSize: descriptor.lotSize,
        scaleOutPrecision: descriptor.quantityPrecision,
        minimumExecutableScale: descriptor.lotSize,
        allowedQuantityModel:
          descriptor.quantityPrecision > 0 ? 'FRACTIONAL_SIMULATION' : 'EXCHANGE_LOT_DISCRETE',
      };
    }
    return rules;
  }

  /**
   * Validates initial entry quantity according to execution environment.
   */
  public static validateEntryQuantity(
    symbol: string,
    quantity: number,
    env: ExecutionEnvironment = 'SIMULATION',
  ): void {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`[INVALID_QUANTITY] Quantity must be positive number: ${quantity}`);
    }

    const rules = this.getRules(symbol);
    if (quantity < rules.minQuantity) {
      throw new Error(
        `[QUANTITY_BELOW_MINIMUM] Quantity ${quantity} for ${symbol} is below minimum ${rules.minQuantity}`,
      );
    }
    if (quantity > rules.maxQuantity) {
      throw new Error(
        `[QUANTITY_EXCEEDS_MAXIMUM] Quantity ${quantity} for ${symbol} exceeds maximum ${rules.maxQuantity}`,
      );
    }

    if (env === 'EXCHANGE_EXECUTION') {
      // In live exchange execution, fractional contracts are strictly prohibited
      if (rules.quantityPrecision === 0) {
        if (!Number.isInteger(quantity) || quantity % rules.lotSize !== 0) {
          throw new Error(
            `[EXCHANGE_LOT_VIOLATION] Quantity ${quantity} for ${symbol} must be an integer multiple of lot size ${rules.lotSize}. Fractional contracts are strictly prohibited in EXCHANGE_EXECUTION.`,
          );
        }
      } else {
        const factor = Math.pow(10, rules.quantityPrecision);
        const rounded = Math.round(quantity * factor) / factor;
        if (Math.abs(quantity - rounded) > 1e-7) {
          throw new Error(
            `[EXCHANGE_PRECISION_VIOLATION] Quantity ${quantity} for ${symbol} exceeds allowable precision of ${rules.quantityPrecision} decimals.`,
          );
        }
      }
    }
  }

  /**
   * Validates scale-out (partial exit) quantity according to execution environment.
   */
  public static validateScaleOutQuantity(
    symbol: string,
    quantity: number,
    env: ExecutionEnvironment = 'SIMULATION',
  ): void {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`[INVALID_SCALEOUT_QUANTITY] Scale-out quantity must be positive number: ${quantity}`);
    }

    const rules = this.getRules(symbol);
    if (quantity < rules.minimumExecutableScale) {
      throw new Error(
        `[SCALEOUT_BELOW_MINIMUM] Scale-out quantity ${quantity} for ${symbol} is below minimum executable scale ${rules.minimumExecutableScale}`,
      );
    }

    if (env === 'EXCHANGE_EXECUTION') {
      if (rules.quantityPrecision === 0) {
        if (!Number.isInteger(quantity) || quantity % rules.lotSize !== 0) {
          throw new Error(
            `[EXCHANGE_SCALEOUT_LOT_VIOLATION] Scale-out quantity ${quantity} for ${symbol} must be an integer multiple of lot size ${rules.lotSize} in EXCHANGE_EXECUTION.`,
          );
        }
      }
    }
  }

  /**
   * Validates final remainder after scale-out according to execution environment.
   */
  public static validateFinalRemainder(
    symbol: string,
    remainder: number,
    env: ExecutionEnvironment = 'SIMULATION',
  ): void {
    if (remainder < 0) {
      throw new Error(`[INVALID_REMAINDER] Remainder quantity cannot be negative: ${remainder}`);
    }
    if (remainder === 0) return; // Completely closed

    const rules = this.getRules(symbol);
    if (remainder < rules.minimumExecutableScale) {
      throw new Error(
        `[REMAINDER_UNEXECUTABLE] Remainder ${remainder} for ${symbol} is below minimum executable scale ${rules.minimumExecutableScale} and cannot be executed.`,
      );
    }

    if (env === 'EXCHANGE_EXECUTION') {
      if (rules.quantityPrecision === 0) {
        if (!Number.isInteger(remainder) || remainder % rules.lotSize !== 0) {
          throw new Error(
            `[EXCHANGE_REMAINDER_LOT_VIOLATION] Remainder ${remainder} for ${symbol} must be an integer multiple of lot size ${rules.lotSize} in EXCHANGE_EXECUTION.`,
          );
        }
      }
    }
  }

  /**
   * Computes the canonical 3-stage scale-out quantities:
   * TP1: 30%
   * TP2: 30%
   * TP3: remaining (40%)
   */
  public static calculateScaleOutPlan(
    symbol: string,
    initialQuantity: number,
    env: ExecutionEnvironment = 'SIMULATION',
  ): ScaleOutQuantities {
    this.validateEntryQuantity(symbol, initialQuantity, env);
    const rules = this.getRules(symbol);
    const isDiscrete = rules.allowedQuantityModel === 'EXCHANGE_LOT_DISCRETE' || env === 'EXCHANGE_EXECUTION';

    if (isDiscrete && initialQuantity === rules.lotSize) {
      // Single-lot positions cannot partial scale-out without leaving unexecutable remainder
      return {
        tp1Quantity: 0,
        tp2Quantity: 0,
        tp3Quantity: initialQuantity,
        quantityModel: 'EXCHANGE_LOT_DISCRETE',
      };
    }

    if (env === 'EXCHANGE_EXECUTION' && rules.quantityPrecision === 0) {
      // Integer lot sizing for exchange execution: discrete lots only
      const totalLots = Math.floor(initialQuantity / rules.lotSize);
      const tp1Lots = Math.floor(totalLots * 0.3);
      const tp2Lots = Math.floor(totalLots * 0.3);
      const tp3Lots = totalLots - tp1Lots - tp2Lots;

      return {
        tp1Quantity: tp1Lots * rules.lotSize,
        tp2Quantity: tp2Lots * rules.lotSize,
        tp3Quantity: tp3Lots * rules.lotSize,
        quantityModel: 'EXCHANGE_LOT_DISCRETE',
      };
    }

    // Simulation fractional scale-out
    const rawTp1 = initialQuantity * 0.3;
    const tp1Quantity = Number(rawTp1.toFixed(rules.scaleOutPrecision));

    const rawTp2 = initialQuantity * 0.3;
    const tp2Quantity = Number(rawTp2.toFixed(rules.scaleOutPrecision));

    const tp3Quantity = Number((initialQuantity - tp1Quantity - tp2Quantity).toFixed(rules.scaleOutPrecision));

    return {
      tp1Quantity,
      tp2Quantity,
      tp3Quantity,
      quantityModel: rules.allowedQuantityModel,
    };
  }
}
