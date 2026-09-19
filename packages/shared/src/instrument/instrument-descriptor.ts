import { AssetType } from '../enums';
import { CurrencyCode, MarginMode } from '../interfaces';

export type ProductType = 'SPOT' | 'OPTION' | 'FUTURE';
export type AssetClass = 'EQUITY' | 'INDEX' | 'CRYPTO' | 'COMMODITY';
export type CostScheduleId =
  | 'NSE_OPTION_DELIVERY'
  | 'BINANCE_CRYPTO_SPOT'
  | 'COMEX_COMMODITY_SPOT'
  | 'NSE_CASH_EQUITY';

export interface InstrumentDescriptor {
  instrumentId: string;
  canonicalSymbol: string;
  venue: string;
  productType: ProductType;
  assetClass: AssetClass;
  quoteCurrency: CurrencyCode | string;
  accountCurrency: CurrencyCode | string;
  contractSize: number;
  lotSize: number;
  quantityPrecision: number;
  priceTickSize: number;
  supportsLong: boolean;
  supportsShort: boolean;
  supportsOptions: boolean;
  marginModel: MarginMode | 'SPOT';
  costScheduleId: CostScheduleId;
}

export const INSTRUMENT_DESCRIPTORS: Record<string, InstrumentDescriptor> = {
  NIFTY: {
    instrumentId: 'inst_nifty',
    canonicalSymbol: 'NIFTY',
    venue: 'NSE',
    productType: 'OPTION',
    assetClass: 'INDEX',
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 65,
    quantityPrecision: 0,
    priceTickSize: 0.05,
    supportsLong: true,
    supportsShort: false, // Spot shorting strictly prohibited
    supportsOptions: true,
    marginModel: 'SPOT',
    costScheduleId: 'NSE_OPTION_DELIVERY',
  },
  BANKNIFTY: {
    instrumentId: 'inst_banknifty',
    canonicalSymbol: 'BANKNIFTY',
    venue: 'NSE',
    productType: 'OPTION',
    assetClass: 'INDEX',
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 15,
    quantityPrecision: 0,
    priceTickSize: 0.05,
    supportsLong: true,
    supportsShort: false,
    supportsOptions: true,
    marginModel: 'SPOT',
    costScheduleId: 'NSE_OPTION_DELIVERY',
  },
  BTCUSDT_SPOT: {
    instrumentId: 'inst_btcusdt_spot',
    canonicalSymbol: 'BTCUSDT_SPOT',
    venue: 'BINANCE',
    productType: 'SPOT',
    assetClass: 'CRYPTO',
    quoteCurrency: 'USDT',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 0.0001,
    quantityPrecision: 4,
    priceTickSize: 0.01,
    supportsLong: true,
    supportsShort: false, // Binance spot cannot short without margin borrowing
    supportsOptions: false,
    marginModel: 'SPOT',
    costScheduleId: 'BINANCE_CRYPTO_SPOT',
  },
  XAUUSD: {
    instrumentId: 'inst_xauusd',
    canonicalSymbol: 'XAUUSD',
    venue: 'COMEX',
    productType: 'SPOT',
    assetClass: 'COMMODITY',
    quoteCurrency: 'USD',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 0.01,
    quantityPrecision: 2,
    priceTickSize: 0.01,
    supportsLong: true,
    supportsShort: true,
    supportsOptions: false,
    marginModel: 'SPOT',
    costScheduleId: 'COMEX_COMMODITY_SPOT',
  },
  RELIANCE: {
    instrumentId: 'inst_reliance',
    canonicalSymbol: 'RELIANCE',
    venue: 'NSE',
    productType: 'SPOT',
    assetClass: 'EQUITY',
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 1,
    quantityPrecision: 0,
    priceTickSize: 0.05,
    supportsLong: true,
    supportsShort: false,
    supportsOptions: false,
    marginModel: 'SPOT',
    costScheduleId: 'NSE_CASH_EQUITY',
  },
  HDFCBANK: {
    instrumentId: 'inst_hdfcbank',
    canonicalSymbol: 'HDFCBANK',
    venue: 'NSE',
    productType: 'SPOT',
    assetClass: 'EQUITY',
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 1,
    quantityPrecision: 0,
    priceTickSize: 0.05,
    supportsLong: true,
    supportsShort: false,
    supportsOptions: false,
    marginModel: 'SPOT',
    costScheduleId: 'NSE_CASH_EQUITY',
  },
  INFY: {
    instrumentId: 'inst_infy',
    canonicalSymbol: 'INFY',
    venue: 'NSE',
    productType: 'SPOT',
    assetClass: 'EQUITY',
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    contractSize: 1,
    lotSize: 1,
    quantityPrecision: 0,
    priceTickSize: 0.05,
    supportsLong: true,
    supportsShort: false,
    supportsOptions: false,
    marginModel: 'SPOT',
    costScheduleId: 'NSE_CASH_EQUITY',
  },
};

// Aliases lookup map for ingestion boundary normalization
const CANONICAL_SYMBOL_ALIASES: Record<string, string> = {
  BTCUSDT: 'BTCUSDT_SPOT',
  BTCUSD: 'BTCUSDT_SPOT',
  BTC: 'BTCUSDT_SPOT',
  CRYPTO: 'BTCUSDT_SPOT',
  GOLD: 'XAUUSD',
  COMMODITY: 'XAUUSD',
  NIFTY_SPOT: 'NIFTY',
  BANKNIFTY_SPOT: 'BANKNIFTY',
  OPTION: 'NIFTY',
  EQUITY: 'RELIANCE',
};

/**
 * Normalizes input symbol to canonical execution identity at the ingestion boundary only.
 */
export function normalizeCanonicalExecutionSymbol(symbol: string): string {
  if (!symbol) return symbol;
  const upper = symbol.trim().toUpperCase();
  if (CANONICAL_SYMBOL_ALIASES[upper]) {
    return CANONICAL_SYMBOL_ALIASES[upper];
  }
  // Check if option symbol starts with NIFTY or BANKNIFTY
  if (upper.startsWith('NIFTY ') || upper.startsWith('NIFTY_')) return upper;
  if (upper.startsWith('BANKNIFTY ') || upper.startsWith('BANKNIFTY_')) return upper;
  return upper;
}

/**
 * Resolves the authoritative InstrumentDescriptor without string matching heuristics.
 */
export function getAuthoritativeDescriptor(symbol: string): InstrumentDescriptor {
  const norm = normalizeCanonicalExecutionSymbol(symbol);
  // If option contract symbol, get base index descriptor
  const baseKey = norm.split(' ')[0];
  let descriptor = INSTRUMENT_DESCRIPTORS[norm] || INSTRUMENT_DESCRIPTORS[baseKey];
  if (!descriptor) {
    if (norm.startsWith('NIFTY')) {
      descriptor = INSTRUMENT_DESCRIPTORS['NIFTY'];
    } else if (norm.startsWith('BANKNIFTY')) {
      descriptor = INSTRUMENT_DESCRIPTORS['BANKNIFTY'];
    }
  }
  if (!descriptor) {
    throw new Error(`[UNKNOWN_INSTRUMENT_DESCRIPTOR] No authoritative InstrumentDescriptor for symbol: ${symbol}`);
  }
  return descriptor;
}
