import { IndianOptionsExpiryEngine } from '@quant/trading-engine';

export type StrikeSelectionType = 'ATM' | 'ITM' | 'OTM';

export interface ResolveOptionContractParams {
  underlyingSymbol: string;
  signalDirection: 'BULLISH' | 'BEARISH' | string;
  underlyingSpotPrice: number;
  signalTimestamp?: Date | string | number;
  strikeSelection?: StrikeSelectionType;
  customStrike?: number;
  customExpiry?: string;
}

export interface ResolvedOptionContract {
  instrumentId: string;
  venue: 'NSE';
  underlying: 'NIFTY' | 'BANKNIFTY';
  contractSymbol: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  orderSide: 'BUY';
  strategyDirection: 'BULLISH' | 'BEARISH';
  lotSize: number;
  quantityPrecision: number;
  priceTickSize: number;
  stepSize: number;
}

export function normalizeOptionsUnderlying(symbol: string): 'NIFTY' | 'BANKNIFTY' | null {
  if (!symbol) return null;
  const upper = symbol.toUpperCase().trim();
  if (upper === 'NIFTY' || upper === 'NIFTY_SPOT' || upper.startsWith('NIFTY')) {
    return 'NIFTY';
  }
  if (upper === 'BANKNIFTY' || upper === 'BANKNIFTY_SPOT' || upper.startsWith('BANKNIFTY')) {
    return 'BANKNIFTY';
  }
  return null;
}

export function isOptionsUnderlying(symbol: string): boolean {
  return normalizeOptionsUnderlying(symbol) !== null;
}

export function getOptionLotSize(underlying: 'NIFTY' | 'BANKNIFTY'): number {
  return underlying === 'NIFTY' ? 65 : 15;
}

export function getOptionStepSize(underlying: 'NIFTY' | 'BANKNIFTY'): number {
  return underlying === 'NIFTY' ? 50 : 100;
}

export class OptionContractResolver {
  static resolveContract(params: ResolveOptionContractParams): ResolvedOptionContract {
    const underlying = normalizeOptionsUnderlying(params.underlyingSymbol);
    if (!underlying) {
      throw new Error(`[UNSUPPORTED_OPTIONS_UNDERLYING] Unsupported options underlying: ${params.underlyingSymbol}. Only NIFTY and BANKNIFTY are supported.`);
    }

    const direction = (params.signalDirection || '').toUpperCase();
    if (direction !== 'BULLISH' && direction !== 'BEARISH') {
      throw new Error(`[INVALID_SIGNAL_DIRECTION] Invalid signal direction: ${params.signalDirection}. Must be BULLISH or BEARISH.`);
    }

    const spotPrice = Number(params.underlyingSpotPrice);
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      throw new Error(`[INVALID_UNDERLYING_PRICE] Invalid underlying spot price: ${params.underlyingSpotPrice}. Must be a positive number.`);
    }

    // Direction Mapping: BULLISH -> BUY CE, BEARISH -> BUY PE
    const optionType: 'CE' | 'PE' = direction === 'BULLISH' ? 'CE' : 'PE';
    const stepSize = getOptionStepSize(underlying);
    const lotSize = getOptionLotSize(underlying);

    let strike: number;
    if (params.customStrike && Number.isFinite(params.customStrike) && params.customStrike > 0) {
      if (params.customStrike % stepSize !== 0) {
        throw new Error(
          `[INVALID_OPTION_STRIKE_ALIGNMENT] Strike ${params.customStrike} is not aligned to ${underlying} strike interval of ${stepSize}.`,
        );
      }
      strike = params.customStrike;
    } else {
      const atmStrike = Math.round(spotPrice / stepSize) * stepSize;
      const selection = params.strikeSelection || 'ATM';

      if (selection === 'ATM') {
        strike = atmStrike;
      } else if (selection === 'ITM') {
        // Call ITM is lower strike; Put ITM is higher strike
        strike = optionType === 'CE' ? atmStrike - stepSize : atmStrike + stepSize;
      } else if (selection === 'OTM') {
        // Call OTM is higher strike; Put OTM is lower strike
        strike = optionType === 'CE' ? atmStrike + stepSize : atmStrike - stepSize;
      } else {
        strike = atmStrike;
      }
    }

    // Expiry resolution & validation
    const baseDate = params.signalTimestamp ? new Date(params.signalTimestamp) : new Date();
    let expiry = params.customExpiry;
    if (!expiry) {
      const expiries = IndianOptionsExpiryEngine.getUpcomingExpiries(underlying, baseDate);
      if (!expiries || expiries.length === 0) {
        throw new Error(`[EXPIRY_RESOLUTION_FAILED] Failed to resolve upcoming expiry for ${underlying} at ${baseDate.toISOString()}`);
      }
      expiry = expiries[0].dateString;
    } else {
      // Validate custom expiry has not expired relative to decision/signal time
      const expiryDate = new Date(expiry);
      if (expiryDate.getTime() < baseDate.getTime() - 86400000) {
        throw new Error(`[EXPIRED_OPTION_CONTRACT] Contract expiry ${expiry} has already expired relative to decision timestamp ${baseDate.toISOString()}`);
      }
    }

    const contractSymbol = `${underlying} ${strike} ${optionType}`;

    return {
      instrumentId: `inst_${underlying.toLowerCase()}_option`,
      venue: 'NSE',
      underlying,
      contractSymbol,
      expiry,
      strike,
      optionType,
      orderSide: 'BUY',
      strategyDirection: direction as 'BULLISH' | 'BEARISH',
      lotSize,
      quantityPrecision: 0,
      priceTickSize: 0.05,
      stepSize,
    };
  }
}
