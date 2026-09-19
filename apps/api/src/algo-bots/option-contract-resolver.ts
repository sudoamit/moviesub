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
  underlying: 'NIFTY' | 'BANKNIFTY';
  optionType: 'CE' | 'PE';
  strike: number;
  expiry: string;
  contractSymbol: string;
  orderSide: 'BUY';
  lotSize: number;
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
      throw new Error(`Unsupported options underlying: ${params.underlyingSymbol}. Only NIFTY and BANKNIFTY are supported.`);
    }

    const direction = (params.signalDirection || '').toUpperCase();
    if (direction !== 'BULLISH' && direction !== 'BEARISH') {
      throw new Error(`Invalid signal direction: ${params.signalDirection}. Must be BULLISH or BEARISH.`);
    }

    const spotPrice = Number(params.underlyingSpotPrice);
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      throw new Error(`Invalid underlying spot price: ${params.underlyingSpotPrice}. Must be a positive number.`);
    }

    const optionType: 'CE' | 'PE' = direction === 'BULLISH' ? 'CE' : 'PE';
    const stepSize = getOptionStepSize(underlying);
    const lotSize = getOptionLotSize(underlying);

    let strike: number;
    if (params.customStrike && Number.isFinite(params.customStrike) && params.customStrike > 0) {
      strike = Math.round(params.customStrike / stepSize) * stepSize;
    } else {
      const atmStrike = Math.round(spotPrice / stepSize) * stepSize;
      const selection = params.strikeSelection || 'ATM';

      if (selection === 'ATM') {
        strike = atmStrike;
      } else if (selection === 'ITM') {
        // For Call: ITM is lower strike. For Put: ITM is higher strike.
        strike = optionType === 'CE' ? atmStrike - stepSize : atmStrike + stepSize;
      } else if (selection === 'OTM') {
        // For Call: OTM is higher strike. For Put: OTM is lower strike.
        strike = optionType === 'CE' ? atmStrike + stepSize : atmStrike - stepSize;
      } else {
        strike = atmStrike;
      }
    }

    // Expiry resolution
    let expiry = params.customExpiry;
    if (!expiry) {
      const baseDate = params.signalTimestamp ? new Date(params.signalTimestamp) : new Date();
      const expiries = IndianOptionsExpiryEngine.getUpcomingExpiries(underlying, baseDate);
      if (!expiries || expiries.length === 0) {
        throw new Error(`Failed to resolve upcoming expiry for ${underlying}`);
      }
      expiry = expiries[0].dateString;
    }

    const contractSymbol = `${underlying} ${strike} ${optionType}`;

    return {
      underlying,
      optionType,
      strike,
      expiry,
      contractSymbol,
      orderSide: 'BUY',
      lotSize,
      stepSize,
    };
  }
}
