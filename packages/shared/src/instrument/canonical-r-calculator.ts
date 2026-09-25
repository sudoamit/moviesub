import { Direction } from '../enums';

export interface ICanonicalTargetModel {
  entry: number;
  stopLoss: number;
  riskDistance: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr1: number;
  rr2: number;
  rr3: number;
  maxPotentialR: number;
  isValid: boolean;
  validationError?: string;
}

export interface IStrategyRRRatios {
  rr1: number;
  rr2: number;
  rr3: number;
  maxPotentialR: number;
}

/**
 * Authoritative strategy target configuration.
 * Default institutional SMC risk-reward targets: 1:2.0R (TP1), 1:3.5R (TP2), 1:6.0R (TP3 Runner).
 */
export const DEFAULT_STRATEGY_RR_RATIOS: IStrategyRRRatios = {
  rr1: 2.0,
  rr2: 3.5,
  rr3: 6.0,
  maxPotentialR: 6.0,
};

/**
 * Authoritative NIFTY/BANKNIFTY option target configuration:
 * TP1 = 1.5R, TP2 = 2.5R (Primary Target), TP3 = 4.0R (Extended Target / Max Potential).
 */
export const DEFAULT_OPTION_RR_RATIOS: IStrategyRRRatios = {
  rr1: 1.5,
  rr2: 2.5,
  rr3: 4.0,
  maxPotentialR: 4.0,
};

export function isLongDirection(direction: Direction | string): boolean {
  const dir = String(direction).toUpperCase();
  return dir === 'BULLISH' || dir === 'BUY' || dir === 'LONG';
}

/**
 * Canonical R calculation for risk distance:
 * - For LONG: riskDistance = entry - stopLoss
 * - For SHORT: riskDistance = stopLoss - entry
 */
export function calculateRiskDistance(
  entry: number,
  stopLoss: number,
  direction: Direction | string,
): number {
  const isLong = isLongDirection(direction);
  const rawDist = isLong ? entry - stopLoss : stopLoss - entry;
  return Number(rawDist.toFixed(4));
}

/**
 * Canonical R calculation for target R multiple:
 * - For LONG: tpR = (target - entry) / riskDistance
 * - For SHORT: tpR = (entry - target) / riskDistance
 */
export function calculateTargetR(
  entry: number,
  target: number,
  riskDistance: number,
  direction: Direction | string,
): number {
  if (!riskDistance || riskDistance <= 0 || isNaN(riskDistance)) {
    return 0;
  }
  const isLong = isLongDirection(direction);
  const distance = isLong ? target - entry : entry - target;
  return Number((distance / riskDistance).toFixed(2));
}

/**
 * Validates directional price geometry:
 * - LONG:  SL < Entry < TP1 < TP2 < TP3
 * - SHORT: SL > Entry > TP1 > TP2 > TP3
 */
export function validateTargetGeometry(
  entry: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  tp3: number,
  direction: Direction | string,
): { isValid: boolean; error?: string } {
  const isLong = isLongDirection(direction);

  if (isLong) {
    if (!(stopLoss < entry)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Long stop loss (${stopLoss}) must be strictly less than entry (${entry})`,
      };
    }
    if (!(entry < tp1)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Long target 1 (${tp1}) must be strictly greater than entry (${entry})`,
      };
    }
    if (!(tp1 < tp2)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Long target 2 (${tp2}) must be strictly greater than target 1 (${tp1})`,
      };
    }
    if (!(tp2 < tp3)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Long target 3 (${tp3}) must be strictly greater than target 2 (${tp2})`,
      };
    }
  } else {
    if (!(stopLoss > entry)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Short stop loss (${stopLoss}) must be strictly greater than entry (${entry})`,
      };
    }
    if (!(entry > tp1)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Short target 1 (${tp1}) must be strictly less than entry (${entry})`,
      };
    }
    if (!(tp1 > tp2)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Short target 2 (${tp2}) must be strictly less than target 1 (${tp1})`,
      };
    }
    if (!(tp2 > tp3)) {
      return {
        isValid: false,
        error: `INVALID_GEOMETRY: Short target 3 (${tp3}) must be strictly less than target 2 (${tp2})`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Computes canonical price levels and RR model from entry, SL, and authoritative R ratios.
 */
export function calculateCanonicalTargets(
  entry: number,
  stopLoss: number,
  direction: Direction | string,
  ratios: Partial<IStrategyRRRatios> = {},
): ICanonicalTargetModel {
  const isLong = isLongDirection(direction);
  const rr1 = ratios.rr1 ?? DEFAULT_STRATEGY_RR_RATIOS.rr1;
  const rr2 = ratios.rr2 ?? DEFAULT_STRATEGY_RR_RATIOS.rr2;
  const rr3 = ratios.rr3 ?? DEFAULT_STRATEGY_RR_RATIOS.rr3;
  const maxPotentialR = ratios.maxPotentialR ?? rr3;

  const riskDistance = calculateRiskDistance(entry, stopLoss, direction);

  let tp1 = 0;
  let tp2 = 0;
  let tp3 = 0;

  if (isLong) {
    tp1 = Number((entry + riskDistance * rr1).toFixed(2));
    tp2 = Number((entry + riskDistance * rr2).toFixed(2));
    tp3 = Number((entry + riskDistance * rr3).toFixed(2));
  } else {
    tp1 = Number((entry - riskDistance * rr1).toFixed(2));
    tp2 = Number((entry - riskDistance * rr2).toFixed(2));
    tp3 = Number((entry - riskDistance * rr3).toFixed(2));
  }

  const geomValidation = validateTargetGeometry(entry, stopLoss, tp1, tp2, tp3, direction);

  return {
    entry,
    stopLoss,
    riskDistance,
    tp1,
    tp2,
    tp3,
    rr1,
    rr2,
    rr3,
    maxPotentialR,
    isValid: geomValidation.isValid && riskDistance > 0,
    validationError: geomValidation.error,
  };
}

export interface IOptionTradeSetupModel {
  instrument: string;
  underlyingSymbol: string;
  underlyingTriggerPrice: number;
  optionContract: {
    symbol: string;
    strike: number;
    optionType: 'CE' | 'PE';
    expiry: string;
    lotSize: number;
  };
  entryPremium: number;
  stopPremium: number;
  targets: Array<{
    targetIndex: number;
    price: number;
    rMultiple: number;
  }>;
  quantity: number;
  lots: number;
  premiumOutlay: number;
  plannedRisk: number;
  maxPremiumLoss: number;
  maxPotentialR: number;
  primaryTargetR: number;
}

/**
 * Calculates option risk per unit, planned risk, premium outlay, and theoretical max loss.
 * For LONG Option BUY:
 * - riskPerUnit = entryPremium - stopPremium
 * - plannedRisk = riskPerUnit * quantity
 * - premiumOutlay = entryPremium * quantity (required cash)
 * - maxPremiumLoss = premiumOutlay (maximum loss if option expires at 0)
 */
export function calculateOptionRiskAndOutlay(
  entryPremium: number,
  stopPremium: number,
  quantity: number,
): {
  riskPerUnit: number;
  plannedRisk: number;
  premiumOutlay: number;
  maxPremiumLoss: number;
} {
  const riskPerUnit = Number((entryPremium - stopPremium).toFixed(2));
  const plannedRisk = Number((riskPerUnit * quantity).toFixed(2));
  const premiumOutlay = Number((entryPremium * quantity).toFixed(2));
  const maxPremiumLoss = premiumOutlay;
  return {
    riskPerUnit,
    plannedRisk,
    premiumOutlay,
    maxPremiumLoss,
  };
}

/**
 * Calculates option BUY P&L strictly without leverage multiplier.
 * P&L = (exitPremium - entryPremium) * quantity
 */
export function calculateOptionBuyPnL(
  entryPremium: number,
  exitPremium: number,
  quantity: number,
): number {
  return Number(((exitPremium - entryPremium) * quantity).toFixed(2));
}

/**
 * Validates option quantity is a positive integer multiple of lotSize.
 */
export function validateOptionLotQuantity(
  quantity: number,
  lotSize: number,
): { isValid: boolean; lots: number; error?: string } {
  if (!quantity || quantity <= 0) {
    return { isValid: false, lots: 0, error: 'Option quantity must be greater than zero' };
  }
  if (!lotSize || lotSize <= 0) {
    return { isValid: false, lots: 0, error: 'Invalid lot size' };
  }
  const lots = quantity / lotSize;
  if (!Number.isInteger(lots) || lots < 1) {
    return {
      isValid: false,
      lots,
      error: `Option quantity (${quantity}) must be an exact integer multiple of lot size (${lotSize}). Fractional lots or misaligned sizes are strictly forbidden.`,
    };
  }
  return { isValid: true, lots };
}

/**
 * Sizing for options based on max risk amount and lot size.
 */
export function calculateOptionRiskQuantity(
  maxRiskAmount: number,
  riskPerOption: number,
  lotSize: number,
): { lots: number; quantity: number; plannedRisk: number } {
  if (riskPerOption <= 0 || maxRiskAmount <= 0 || lotSize <= 0) {
    return { lots: 0, quantity: 0, plannedRisk: 0 };
  }
  const maxUnits = Math.floor(maxRiskAmount / riskPerOption);
  const lots = Math.floor(maxUnits / lotSize);
  const quantity = lots * lotSize;
  const plannedRisk = Number((quantity * riskPerOption).toFixed(2));
  return { lots, quantity, plannedRisk };
}

/**
 * Builds authoritative canonical option trade setup model.
 */
export function buildCanonicalOptionTradeSetup(params: {
  underlyingSymbol: string;
  underlyingTriggerPrice: number;
  strike: number;
  optionType: 'CE' | 'PE';
  expiry: string;
  lotSize: number;
  entryPremium: number;
  stopPremium: number;
  quantity?: number;
  accountBalance?: number;
  riskPercentage?: number;
  ratios?: Partial<IStrategyRRRatios>;
}): IOptionTradeSetupModel {
  const {
    underlyingSymbol,
    underlyingTriggerPrice,
    strike,
    optionType,
    expiry,
    lotSize,
    entryPremium,
    stopPremium,
    ratios = DEFAULT_OPTION_RR_RATIOS,
  } = params;

  const rr1 = ratios.rr1 ?? DEFAULT_OPTION_RR_RATIOS.rr1;
  const rr2 = ratios.rr2 ?? DEFAULT_OPTION_RR_RATIOS.rr2;
  const rr3 = ratios.rr3 ?? DEFAULT_OPTION_RR_RATIOS.rr3;
  const maxPotentialR = ratios.maxPotentialR ?? DEFAULT_OPTION_RR_RATIOS.maxPotentialR;

  const riskPerUnit = Number((entryPremium - stopPremium).toFixed(2));
  if (riskPerUnit <= 0) {
    throw new Error(
      `INVALID_OPTION_SL: Stop premium (${stopPremium}) must be strictly less than entry premium (${entryPremium}) for Long Option BUY`,
    );
  }

  let finalQuantity = params.quantity;
  if (!finalQuantity && params.accountBalance && params.riskPercentage) {
    const maxRisk = params.accountBalance * (params.riskPercentage / 100);
    const sizing = calculateOptionRiskQuantity(maxRisk, riskPerUnit, lotSize);
    finalQuantity = sizing.quantity > 0 ? sizing.quantity : lotSize;
  } else if (!finalQuantity) {
    finalQuantity = lotSize;
  }

  const lotVal = validateOptionLotQuantity(finalQuantity, lotSize);
  if (!lotVal.isValid) {
    throw new Error(lotVal.error);
  }

  const { plannedRisk, premiumOutlay, maxPremiumLoss } = calculateOptionRiskAndOutlay(
    entryPremium,
    stopPremium,
    finalQuantity,
  );

  const tp1 = Number((entryPremium + riskPerUnit * rr1).toFixed(2));
  const tp2 = Number((entryPremium + riskPerUnit * rr2).toFixed(2));
  const tp3 = Number((entryPremium + riskPerUnit * rr3).toFixed(2));

  const contractSymbol = `${underlyingSymbol} ${strike} ${optionType}`;

  return {
    instrument: underlyingSymbol,
    underlyingSymbol,
    underlyingTriggerPrice,
    optionContract: {
      symbol: contractSymbol,
      strike,
      optionType,
      expiry,
      lotSize,
    },
    entryPremium,
    stopPremium,
    targets: [
      { targetIndex: 1, price: tp1, rMultiple: rr1 },
      { targetIndex: 2, price: tp2, rMultiple: rr2 },
      { targetIndex: 3, price: tp3, rMultiple: rr3 },
    ],
    quantity: finalQuantity,
    lots: lotVal.lots,
    premiumOutlay,
    plannedRisk,
    maxPremiumLoss,
    maxPotentialR,
    primaryTargetR: rr2,
  };
}
