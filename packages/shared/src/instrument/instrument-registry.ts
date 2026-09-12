import { AssetType } from '../enums';
import { IInstrument } from '../interfaces';

export const AUTHORITATIVE_INSTRUMENTS: Record<string, IInstrument> = {
  NIFTY: {
    id: 'inst_nifty_50',
    symbol: 'NIFTY',
    name: 'NIFTY 50 Index',
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
    initialMarginRate: 0.2, // 20% initial margin for 5x
    maintenanceMarginRate: 0.1, // 10% maintenance margin
    minimumQuantity: 65,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
  BANKNIFTY: {
    id: 'inst_banknifty',
    symbol: 'BANKNIFTY',
    name: 'NIFTY Bank Index',
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
    defaultLeverage: 5,
    maxLeverage: 5,
    initialMarginRate: 0.2,
    maintenanceMarginRate: 0.1,
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
    minimumQuantity: 0.01,
    quantityPrecision: 2,
    pricePrecision: 2,
    tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
    isActive: true,
  },
  BTCUSDT: {
    id: 'inst_btcusdt_binance',
    symbol: 'BTCUSDT',
    name: 'Bitcoin / Tether USD Perpetual',
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
    minimumQuantity: 0.001,
    quantityPrecision: 3,
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
    minimumQuantity: 1,
    quantityPrecision: 0,
    pricePrecision: 2,
    tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
    isActive: true,
  },
};

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
  return sym in AUTHORITATIVE_INSTRUMENTS || customInstruments.has(sym);
}

/**
 * Resolves authoritative instrument specification.
 * STRICT FAIL-CLOSED: Throws INVALID_INSTRUMENT_SPECIFICATION if instrument is unregistered/unrecognized.
 */
export function getAuthoritativeInstrument(symbol: string): IInstrument {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error(`INVALID_INSTRUMENT_SPECIFICATION: Symbol must be a non-empty string, got ${symbol}`);
  }
  const sym = symbol.toUpperCase();
  if (customInstruments.has(sym)) {
    return customInstruments.get(sym)!;
  }
  if (sym in AUTHORITATIVE_INSTRUMENTS) {
    return AUTHORITATIVE_INSTRUMENTS[sym];
  }
  throw new Error(
    `INVALID_INSTRUMENT_SPECIFICATION: No authoritative instrument specification found for symbol '${symbol}'. Production systems fail closed on unconfigured instruments.`,
  );
}

export function resetCustomInstruments(): void {
  customInstruments.clear();
}
