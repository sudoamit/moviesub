import { AssetType } from '../enums';
import {
  CurrencyCode,
  IInstrument,
  IResolvedMarginModel,
  IVenueProfile,
  LiquidationModel,
  MarginMode,
} from '../interfaces';

export const FORBIDDEN_DERIVATIVE_INSTRUMENTS = new Set([
  'NIFTY_FUT',
  'BANKNIFTY_FUT',
  'NIFTY_OPTION',
  'BANKNIFTY_OPTION',
]);

/**
 * Binance USDⓈ-M perpetuals supported for execution (long and short, isolated margin), with exchange contract
 * specs (tick, lot step, precisions) and the paper engine's margin assumptions. BTCUSDT_PERP is defined in full
 * in AUTHORITATIVE_INSTRUMENTS; the others are generated from this table.
 */
export const PERPETUAL_SPECS: Record<string, {
  base: string; name: string; tickSize: number; lotSize: number; quantityPrecision: number; pricePrecision: number;
  maxLeverage: number; maintenanceMarginRate: number;
}> = {
  BTCUSDT_PERP: { base: 'BTC', name: 'Bitcoin / Tether USD Perpetual Futures', tickSize: 0.1, lotSize: 0.001, quantityPrecision: 3, pricePrecision: 1, maxLeverage: 50, maintenanceMarginRate: 0.004 },
  ETHUSDT_PERP: { base: 'ETH', name: 'Ethereum / Tether USD Perpetual Futures', tickSize: 0.01, lotSize: 0.001, quantityPrecision: 3, pricePrecision: 2, maxLeverage: 50, maintenanceMarginRate: 0.005 },
  SOLUSDT_PERP: { base: 'SOL', name: 'Solana / Tether USD Perpetual Futures', tickSize: 0.01, lotSize: 0.01, quantityPrecision: 2, pricePrecision: 2, maxLeverage: 20, maintenanceMarginRate: 0.01 },
  BNBUSDT_PERP: { base: 'BNB', name: 'BNB / Tether USD Perpetual Futures', tickSize: 0.01, lotSize: 0.01, quantityPrecision: 2, pricePrecision: 2, maxLeverage: 20, maintenanceMarginRate: 0.01 },
  ADAUSDT_PERP: { base: 'ADA', name: 'Cardano / Tether USD Perpetual Futures', tickSize: 0.0001, lotSize: 1, quantityPrecision: 0, pricePrecision: 4, maxLeverage: 20, maintenanceMarginRate: 0.01 },
  LINKUSDT_PERP: { base: 'LINK', name: 'Chainlink / Tether USD Perpetual Futures', tickSize: 0.001, lotSize: 0.01, quantityPrecision: 2, pricePrecision: 3, maxLeverage: 20, maintenanceMarginRate: 0.01 },
};

/** Leveraged perpetual futures that are supported for execution (long and short, isolated margin). */
export const SUPPORTED_PERPETUAL_SYMBOLS = new Set<string>(Object.keys(PERPETUAL_SPECS));

/** Binance futures symbol for a perpetual (e.g. ETHUSDT_PERP -> ETHUSDT). */
export function perpetualVenueSymbol(symbol: string): string {
  return (symbol || '').toUpperCase().replace(/_PERP$/, '');
}

export function isPerpetualSymbol(symbol: string): boolean {
  return SUPPORTED_PERPETUAL_SYMBOLS.has((symbol || '').trim().toUpperCase());
}

export const SUPPORTED_SPOT_SYMBOLS = ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'BTCUSDT_SPOT'] as const;
export type SupportedSpotSymbol = (typeof SUPPORTED_SPOT_SYMBOLS)[number];
export const SUPPORTED_SPOT_SYMBOLS_SET = new Set<string>(SUPPORTED_SPOT_SYMBOLS);

export interface ISpotInstrument {
  id: string;
  symbol: SupportedSpotSymbol;
  name: string;
  exchange: 'NSE' | 'BINANCE';
  assetType: AssetType;
  baseCurrency: string;
  quoteCurrency: CurrencyCode;
  accountingCurrency: CurrencyCode;
  tickSize: number;
  lotSize: number;
  contractMultiplier: 1;
  minimumQuantity: number;
  quantityPrecision: number;
  pricePrecision: number;
  tradingHoursJson?: Record<string, any> | null;
  isActive: boolean;
  isSpot: true;
}

export function isSupportedSpotSymbol(symbol: string): symbol is SupportedSpotSymbol {
  return SUPPORTED_SPOT_SYMBOLS_SET.has((symbol || '').toUpperCase());
}

export const LEGACY_SPOT_ALIASES: Record<string, SupportedSpotSymbol> = {
  NIFTY: 'NIFTY_SPOT',
  BANKNIFTY: 'BANKNIFTY_SPOT',
  BTCUSDT: 'BTCUSDT_SPOT',
};

/**
 * Bitcoin aliases that must always execute as true spot (BTCUSDT_SPOT).
 * The legacy 'BTCUSDT' registry entry is a leveraged perpetual specification and must never be
 * selected by an execution path: the platform only trades BTC as spot.
 */
const BTC_SPOT_EXECUTION_ALIASES = new Set(['BTC', 'BTCUSD', 'BTCUSDT', 'BTCUSDT_SPOT']);

/**
 * Canonicalizes a symbol for execution, sizing, and risk lookups.
 * BTC aliases resolve to BTCUSDT_SPOT; every other symbol (including the explicit BTCUSDT_PERP futures
 * instrument) is trimmed and upper-cased unchanged.
 */
export function canonicalizeExecutionSymbol(symbol: string): string {
  const sym = (symbol || '').trim().toUpperCase();
  return BTC_SPOT_EXECUTION_ALIASES.has(sym) ? 'BTCUSDT_SPOT' : sym;
}

export function canonicalizeSpotSymbol(
  symbol: string,
  options?: { allowLegacyAliases?: boolean },
): SupportedSpotSymbol {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error(`INVALID_SPOT_SYMBOL: Expected non-empty string, got ${symbol}`);
  }
  const sym = symbol.toUpperCase();
  if (FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(sym)) {
    throw new Error(
      `FORBIDDEN_DERIVATIVE_INSTRUMENT: Derivative instrument '${symbol}' is strictly forbidden in the spot-only trading architecture.`,
    );
  }
  if (sym === 'NIFTY_SPOT' || sym === 'BANKNIFTY_SPOT' || sym === 'BTCUSDT_SPOT') {
    return sym;
  }
  if (sym in LEGACY_SPOT_ALIASES) {
    if (options?.allowLegacyAliases === false) {
      throw new Error(
        `LEGACY_ALIAS_REJECTED: Symbol '${symbol}' is a legacy alias. The spot engine strictly requires canonical symbol '${LEGACY_SPOT_ALIASES[sym]}'.`,
      );
    }
    return LEGACY_SPOT_ALIASES[sym];
  }

  throw new Error(
    `UNSUPPORTED_SPOT_INSTRUMENT: Symbol '${symbol}' is not in the supported spot universe: ${SUPPORTED_SPOT_SYMBOLS.join(', ')}`,
  );
}

export function getAuthoritativeSpotInstrument(symbol: string): ISpotInstrument {
  const canonicalSym = canonicalizeSpotSymbol(symbol);
  const inst = AUTHORITATIVE_INSTRUMENTS[canonicalSym];
  return {
    id: inst.id,
    symbol: canonicalSym,
    name: inst.name,
    exchange: inst.exchange as 'NSE' | 'BINANCE',
    assetType: inst.assetType,
    baseCurrency: inst.baseCurrency || inst.symbol,
    quoteCurrency: (inst.quoteCurrency || 'INR') as CurrencyCode,
    accountingCurrency: (inst.accountingCurrency || 'INR') as CurrencyCode,
    tickSize: inst.tickSize,
    lotSize: inst.lotSize,
    contractMultiplier: 1,
    minimumQuantity: inst.minimumQuantity || inst.lotSize,
    quantityPrecision: inst.quantityPrecision || 0,
    pricePrecision: inst.pricePrecision || 2,
    tradingHoursJson: inst.tradingHoursJson,
    isActive: inst.isActive,
    isSpot: true,
  };
}

export const AUTHORITATIVE_INSTRUMENTS: Record<string, IInstrument> = {
  NIFTY_SPOT: {
    id: 'inst_nifty_spot',
    symbol: 'NIFTY_SPOT',
    name: 'NIFTY 50 Index (Spot Research)',
    exchange: 'NSE',
    assetType: AssetType.INDEX,
    tickSize: 0.05,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'NIFTY',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'SPOT',
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  BANKNIFTY_SPOT: {
    id: 'inst_banknifty_spot',
    symbol: 'BANKNIFTY_SPOT',
    name: 'NIFTY Bank Index (Spot Research)',
    exchange: 'NSE',
    assetType: AssetType.INDEX,
    tickSize: 0.05,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'BANKNIFTY',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'SPOT',
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  BTCUSDT_SPOT: {
    id: 'inst_btcusdt_spot',
    symbol: 'BTCUSDT_SPOT',
    name: 'Bitcoin / Tether USD (Spot)',
    exchange: 'BINANCE',
    assetType: AssetType.CRYPTO,
    tickSize: 0.01,
    lotSize: 0.0001,
    contractSize: 1,
    currency: 'USDT',
    baseCurrency: 'BTC',
    quoteCurrency: 'USDT',
    accountingCurrency: 'INR',
    marginMode: 'SPOT',
    defaultLeverage: 1,
    maxLeverage: 1,
    initialMarginRate: 1.0,
    maintenanceMarginRate: 1.0,
    liquidationModel: 'SPOT_NONE',
    venueProfile: {
      venueId: 'BINANCE_SPOT',
      defaultLeverage: 1,
      maxLeverage: 1,
      marginMode: 'SPOT',
      initialMarginRate: 1.0,
      maintenanceMarginRate: 1.0,
      liquidationModel: 'SPOT_NONE',
    },
    minimumQuantity: 0.0001,
    quantityPrecision: 4,
    pricePrecision: 2,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  },
  BTCUSDT_PERP: {
    id: 'inst_btcusdt_perp',
    symbol: 'BTCUSDT_PERP',
    name: 'Bitcoin / Tether USD Perpetual Futures',
    exchange: 'BINANCE',
    assetType: AssetType.CRYPTO,
    tickSize: 0.1,
    lotSize: 0.001,
    contractSize: 1,
    currency: 'USDT',
    baseCurrency: 'BTC',
    quoteCurrency: 'USDT',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 50,
    initialMarginRate: 0.02,
    // Up to 50x (1 / 0.02 initial margin). Maintenance margin is Binance's tier-1 rate; the paper engine does not
    // model Binance's notional brackets (larger positions have a higher maintenance rate on the exchange).
    // Binance USDⓈ-M BTCUSDT tier-1 maintenance margin rate
    maintenanceMarginRate: 0.004,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'BINANCE_FUTURES_USDT',
      defaultLeverage: 5,
      maxLeverage: 50,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.02,
      maintenanceMarginRate: 0.004,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 0.001,
    quantityPrecision: 3,
    pricePrecision: 1,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  },
  NIFTY: {
    id: 'inst_nifty_50',
    symbol: 'NIFTY',
    name: 'NIFTY 50 Index (Legacy Derivative)',
    exchange: 'NSE',
    assetType: AssetType.INDEX,
    tickSize: 0.05,
    lotSize: 65,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'NIFTY',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'NSE_DERIVATIVES',
      defaultLeverage: 5,
      maxLeverage: 5,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 65,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  BANKNIFTY: {
    id: 'inst_banknifty',
    symbol: 'BANKNIFTY',
    name: 'NIFTY Bank Index (Legacy Derivative)',
    exchange: 'NSE',
    assetType: AssetType.INDEX,
    tickSize: 0.05,
    lotSize: 15,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'BANKNIFTY',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 1,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'NSE_INDEX_FUTURES',
      defaultLeverage: 1,
      maxLeverage: 5,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 15,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  GOLD: {
    id: 'inst_gold_mcx',
    symbol: 'GOLD',
    name: 'MCX Gold Futures / Spot',
    exchange: 'MCX',
    assetType: AssetType.COMMODITY,
    tickSize: 1.0,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'GOLD',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 10,
    initialMarginRate: 0.1,
    maintenanceMarginRate: 0.05,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'MCX_COMMODITIES',
      defaultLeverage: 5,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.1,
      maintenanceMarginRate: 0.05,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:00', end: '23:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  GOLD_MCX: {
    id: 'inst_gold_mcx_full',
    symbol: 'GOLD_MCX',
    name: 'MCX Gold 1kg',
    exchange: 'MCX',
    assetType: AssetType.COMMODITY,
    tickSize: 1.0,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'GOLD',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 10,
    initialMarginRate: 0.1,
    maintenanceMarginRate: 0.05,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'MCX_COMMODITIES',
      defaultLeverage: 5,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.1,
      maintenanceMarginRate: 0.05,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:00', end: '23:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  XAUUSD: {
    id: 'inst_xauusd_comex',
    symbol: 'XAUUSD',
    name: 'Gold Spot / US Dollar (1 oz)',
    exchange: 'COMEX',
    assetType: AssetType.COMMODITY,
    tickSize: 0.01,
    lotSize: 0.01,
    contractSize: 1, // 1 troy ounce per contract
    currency: 'USD',
    baseCurrency: 'XAU',
    quoteCurrency: 'USD',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 10,
    maxLeverage: 20,
    initialMarginRate: 0.05, // 5% for 20x
    maintenanceMarginRate: 0.025, // 2.5% maintenance margin
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'COMEX_METALS',
      defaultLeverage: 10,
      maxLeverage: 20,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.05,
      maintenanceMarginRate: 0.025,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 0.01,
    quantityPrecision: 2,
    pricePrecision: 2,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  },
  BTCUSDT: {
    id: 'inst_btcusdt_binance',
    symbol: 'BTCUSDT',
    name: 'Bitcoin / Tether USD (Legacy Derivative / Perpetual)',
    exchange: 'BINANCE',
    assetType: AssetType.CRYPTO,
    tickSize: 0.01,
    lotSize: 0.001,
    contractSize: 1,
    currency: 'USDT',
    baseCurrency: 'BTC',
    quoteCurrency: 'USDT',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 20,
    initialMarginRate: 0.05,
    maintenanceMarginRate: 0.025,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'BINANCE_FUTURES_USDT',
      defaultLeverage: 5,
      maxLeverage: 20,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.05,
      maintenanceMarginRate: 0.025,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 0.001,
    quantityPrecision: 4,
    pricePrecision: 2,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  },
  RELIANCE: {
    id: 'inst_reliance',
    symbol: 'RELIANCE',
    name: 'Reliance Industries Ltd.',
    exchange: 'NSE',
    assetType: AssetType.EQUITY,
    tickSize: 0.05,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'RELIANCE',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'NSE_EQUITY_MARGIN',
      defaultLeverage: 5,
      maxLeverage: 5,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  HDFCBANK: {
    id: 'inst_hdfcbank',
    symbol: 'HDFCBANK',
    name: 'HDFC Bank Ltd.',
    exchange: 'NSE',
    assetType: AssetType.EQUITY,
    tickSize: 0.05,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'HDFCBANK',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'NSE_EQUITY_MARGIN',
      defaultLeverage: 5,
      maxLeverage: 5,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  INFY: {
    id: 'inst_infy',
    symbol: 'INFY',
    name: 'Infosys Ltd.',
    exchange: 'NSE',
    assetType: AssetType.EQUITY,
    tickSize: 0.05,
    lotSize: 1,
    contractSize: 1,
    currency: 'INR',
    baseCurrency: 'INFY',
    quoteCurrency: 'INR',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'NSE_EQUITY_MARGIN',
      defaultLeverage: 5,
      maxLeverage: 5,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
};

// Generated perpetual instruments (BTCUSDT_PERP is declared explicitly above)
for (const [symbol, spec] of Object.entries(PERPETUAL_SPECS)) {
  if (AUTHORITATIVE_INSTRUMENTS[symbol]) continue;
  const imr = 1 / spec.maxLeverage;
  AUTHORITATIVE_INSTRUMENTS[symbol] = {
    id: `inst_${symbol.toLowerCase()}`,
    symbol,
    name: spec.name,
    exchange: 'BINANCE',
    assetType: AssetType.CRYPTO,
    tickSize: spec.tickSize,
    lotSize: spec.lotSize,
    contractSize: 1,
    currency: 'USDT',
    baseCurrency: spec.base,
    quoteCurrency: 'USDT',
    accountingCurrency: 'INR',
    marginMode: 'ISOLATED',
    defaultLeverage: 5,
    maxLeverage: spec.maxLeverage,
    initialMarginRate: imr,
    maintenanceMarginRate: spec.maintenanceMarginRate,
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'BINANCE_FUTURES_USDT',
      defaultLeverage: 5,
      maxLeverage: spec.maxLeverage,
      marginMode: 'ISOLATED',
      initialMarginRate: imr,
      maintenanceMarginRate: spec.maintenanceMarginRate,
      liquidationModel: 'ISOLATED_LINEAR',
    },
    minimumQuantity: spec.lotSize,
    quantityPrecision: spec.quantityPrecision,
    pricePrecision: spec.pricePrecision,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  };
}

const customInstruments: Map<string, IInstrument> = new Map();

export function registerInstrument(instrument: IInstrument): void {
  if (!instrument || !instrument.symbol) {
    throw new Error('INVALID_INSTRUMENT: Instrument must have a valid symbol');
  }
  const sym = instrument.symbol.toUpperCase();
  customInstruments.set(sym, {
    ...instrument,
    symbol: sym,
    quoteCurrency: instrument.quoteCurrency || (instrument.currency as any) || 'INR',
    accountingCurrency: instrument.accountingCurrency || 'INR',
  });
}

export function hasInstrument(symbol: string): boolean {
  if (!symbol) return false;
  const sym = symbol.toUpperCase();
  if (FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(sym)) {
    return false;
  }
  return sym in AUTHORITATIVE_INSTRUMENTS || customInstruments.has(sym);
}

/**
 * Resolves authoritative instrument specification.
 * Supports optional venue/account profile overrides.
 * STRICT FAIL-CLOSED: Throws INVALID_INSTRUMENT_SPECIFICATION if instrument is unregistered/unrecognized.
 * Throws FORBIDDEN_DERIVATIVE_INSTRUMENT if instrument is a forbidden derivative.
 */
export function getAuthoritativeInstrument(
  symbol: string,
  venueOverride?: Partial<IVenueProfile>,
): IInstrument {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error(`INVALID_INSTRUMENT_SPECIFICATION: Symbol must be a non-empty string, got ${symbol}`);
  }
  const sym = symbol.toUpperCase();
  if (FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(sym)) {
    throw new Error(
      `FORBIDDEN_DERIVATIVE_INSTRUMENT: Derivative instrument '${symbol}' is not supported in the spot-only trading architecture.`,
    );
  }
  let baseInstrument: IInstrument | undefined;
  if (customInstruments.has(sym)) {
    baseInstrument = customInstruments.get(sym);
  } else if (sym in AUTHORITATIVE_INSTRUMENTS) {
    baseInstrument = AUTHORITATIVE_INSTRUMENTS[sym];
  } else if (sym.startsWith('NIFTY ') && (sym.endsWith(' CE') || sym.endsWith(' PE'))) {
    const niftyBase = AUTHORITATIVE_INSTRUMENTS['NIFTY'];
    baseInstrument = {
      ...niftyBase,
      id: `inst_${sym.toLowerCase().replace(/\s+/g, '_')}`,
      symbol: sym,
      name: `${sym} Option Contract`,
      assetType: AssetType.INDEX,
      defaultLeverage: 1,
      maxLeverage: 1,
      initialMarginRate: 1.0,
      maintenanceMarginRate: 1.0,
    };
  } else if (sym.startsWith('BANKNIFTY ') && (sym.endsWith(' CE') || sym.endsWith(' PE'))) {
    const bnfBase = AUTHORITATIVE_INSTRUMENTS['BANKNIFTY'];
    baseInstrument = {
      ...bnfBase,
      id: `inst_${sym.toLowerCase().replace(/\s+/g, '_')}`,
      symbol: sym,
      name: `${sym} Option Contract`,
      assetType: AssetType.INDEX,
      defaultLeverage: 1,
      maxLeverage: 1,
      initialMarginRate: 1.0,
      maintenanceMarginRate: 1.0,
    };
  }

  if (!baseInstrument) {
    throw new Error(
      `INVALID_INSTRUMENT_SPECIFICATION: No authoritative instrument specification found for symbol '${symbol}'. Production systems fail closed on unconfigured instruments.`,
    );
  }

  if (!venueOverride) {
    return baseInstrument;
  }

  // A true spot instrument keeps its spot margin model regardless of venue overrides.
  if (baseInstrument.marginMode === 'SPOT') {
    return baseInstrument;
  }

  // Compose with venue override
  return {
    ...baseInstrument,
    marginMode: venueOverride.marginMode ?? baseInstrument.marginMode,
    defaultLeverage: venueOverride.defaultLeverage ?? baseInstrument.defaultLeverage,
    maxLeverage: venueOverride.maxLeverage ?? baseInstrument.maxLeverage,
    initialMarginRate: venueOverride.initialMarginRate ?? baseInstrument.initialMarginRate,
    maintenanceMarginRate: venueOverride.maintenanceMarginRate ?? baseInstrument.maintenanceMarginRate,
    liquidationModel: venueOverride.liquidationModel ?? baseInstrument.liquidationModel,
    venueProfile: baseInstrument.venueProfile
      ? { ...baseInstrument.venueProfile, ...venueOverride }
      : (venueOverride as IVenueProfile),
  };
}

export function resetCustomInstruments(): void {
  customInstruments.clear();
}

export interface IMarginModelResolutionOptions {
  requestedLeverage?: number;
  customLeverage?: number;
  venueOverride?: Partial<IVenueProfile>;
}

/**
 * Resolves the single authoritative margin model for an instrument.
 *
 * PRECEDENCE & POLICY:
 * 1. Margin-Rate-Driven Precedence:
 *    - The venue/instrument minimum required initialMarginRate (IMR) sets the absolute ceiling on leverage: maxLeverage <= 1 / IMR.
 *    - Requested leverage cannot exceed maxLeverage (or 1 / IMR).
 *    - If a caller chooses lower leverage L <= maxLeverage (e.g., 2x on a 10x venue), the required margin rate is 1 / L (e.g. 50%),
 *      guaranteeing effectiveInitialMarginRate = max(venueIMR, 1 / requestedLeverage).
 * 2. SPOT Mode:
 *    - marginMode = 'SPOT', effectiveLeverage = 1, initialMarginRate = 1.0, MMR = 0.0, liquidationModel = 'SPOT_NONE'.
 */
export function resolveMarginModel(
  instrument: IInstrument,
  options?: IMarginModelResolutionOptions,
): IResolvedMarginModel {
  if (!instrument) {
    throw new Error('INVALID_INSTRUMENT: Cannot resolve margin model for undefined instrument');
  }

  const venue = options?.venueOverride
    ? { ...(instrument.venueProfile || {}), ...options.venueOverride }
    : instrument.venueProfile;

  // A true spot instrument can never be converted into a margin product by a venue override.
  const marginMode: MarginMode =
    instrument.marginMode === 'SPOT'
      ? 'SPOT'
      : (options?.venueOverride?.marginMode ?? instrument.marginMode ?? venue?.marginMode ?? 'SPOT');

  if (marginMode === 'SPOT') {
    // Reject (never silently clamp) any leverage > 1 on spot, whichever field it arrives in.
    const spotLeverageRequests = [options?.requestedLeverage, options?.customLeverage];
    for (const lev of spotLeverageRequests) {
      if (lev !== undefined && lev !== null && Number(lev) > 1) {
        throw new Error(
          `LEVERAGE_EXCEEDS_MAX: Requested leverage ${lev}x exceeds maximum allowable leverage of 1x for spot instrument ${instrument.symbol}`,
        );
      }
    }
    return {
      marginMode: 'SPOT',
      effectiveLeverage: 1,
      initialMarginRate: 1.0,
      maintenanceMarginRate: 0.0,
      liquidationModel: 'SPOT_NONE',
    };
  }

  // Margin / Derivative Mode: Derive venue authoritative base initial margin rate
  const venueBaseImr =
    options?.venueOverride?.initialMarginRate ??
    venue?.initialMarginRate ??
    instrument.initialMarginRate;

  const venueMaxLeverageFromImr =
    venueBaseImr !== undefined && venueBaseImr > 0 ? Math.round(1 / venueBaseImr) : Infinity;

  const declaredMaxLeverage =
    options?.venueOverride?.maxLeverage ??
    venue?.maxLeverage ??
    instrument.maxLeverage ??
    (venueMaxLeverageFromImr !== Infinity ? venueMaxLeverageFromImr : 1);

  const maxLeverage = Math.min(declaredMaxLeverage, venueMaxLeverageFromImr);

  const defaultLeverage = Math.min(
    maxLeverage,
    options?.venueOverride?.defaultLeverage ??
      venue?.defaultLeverage ??
      instrument.defaultLeverage ??
      maxLeverage,
  );

  const leverage = options?.requestedLeverage ?? options?.customLeverage ?? defaultLeverage;

  if (typeof leverage !== 'number' || !Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(`INVALID_LEVERAGE: Leverage must be a positive finite number, got ${leverage}`);
  }

  if (leverage > maxLeverage) {
    throw new Error(
      `LEVERAGE_EXCEEDS_MAX: Requested leverage ${leverage}x exceeds maximum allowable leverage of ${maxLeverage}x for instrument ${instrument.symbol}`,
    );
  }

  // Effective initial margin rate: higher of required venue minimum rate or 1 / leverage
  let initialMarginRate: number;
  if (options?.requestedLeverage !== undefined || options?.customLeverage !== undefined) {
    const derivedRate = 1 / leverage;
    initialMarginRate = venueBaseImr !== undefined ? Math.max(venueBaseImr, derivedRate) : derivedRate;
  } else {
    initialMarginRate = venueBaseImr !== undefined ? venueBaseImr : 1 / leverage;
  }

  const maintenanceMarginRate =
    options?.venueOverride?.maintenanceMarginRate ??
    venue?.maintenanceMarginRate ??
    instrument.maintenanceMarginRate ??
    0.05;

  const liquidationModel: LiquidationModel =
    options?.venueOverride?.liquidationModel ??
    venue?.liquidationModel ??
    instrument.liquidationModel ??
    'ISOLATED_LINEAR';

  return {
    marginMode,
    effectiveLeverage: leverage,
    initialMarginRate: Number(initialMarginRate.toFixed(4)),
    maintenanceMarginRate: Number(maintenanceMarginRate.toFixed(4)),
    liquidationModel,
  };
}

/**
 * Isolated-margin liquidation price for a linear (USDT-margined) perpetual, ignoring the tiered
 * maintenance amount: long = entry x (1 - 1/L + MMR), short = entry x (1 + 1/L - MMR).
 */
export function computeIsolatedLiquidationPrice(
  entryPrice: number,
  direction: 'LONG' | 'SHORT',
  leverage: number,
  maintenanceMarginRate: number,
): number {
  if (!(entryPrice > 0) || !(leverage >= 1)) {
    throw new Error(`INVALID_LIQUIDATION_INPUT: entry ${entryPrice}, leverage ${leverage}`);
  }
  const imr = 1 / leverage;
  return direction === 'LONG'
    ? entryPrice * (1 - imr + maintenanceMarginRate)
    : entryPrice * (1 + imr - maintenanceMarginRate);
}

/**
 * Rounds a price to the instrument's price precision (e.g. 4 decimals for ADAUSDT_PERP, 1 for BTCUSDT_PERP).
 * Unknown instruments keep 2 decimals. Never rounds to fewer decimals than `minDecimals`.
 */
export function roundPrice(symbol: string, price: number, minDecimals = 2): number {
  const sym = (symbol || '').toUpperCase();
  const perp = PERPETUAL_SPECS[sym];
  const inst = AUTHORITATIVE_INSTRUMENTS[sym];
  const decimals = Math.max(minDecimals, perp?.pricePrecision ?? inst?.pricePrecision ?? 2);
  return Number(price.toFixed(decimals));
}
