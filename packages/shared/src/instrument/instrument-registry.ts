import { AssetType } from '../enums';
import {
  IInstrument,
  IResolvedMarginModel,
  IVenueProfile,
  LiquidationModel,
  MarginMode,
} from '../interfaces';

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
    liquidationModel: 'ISOLATED_LINEAR',
    venueProfile: {
      venueId: 'BINANCE_PERP',
      defaultLeverage: 5,
      maxLeverage: 20,
      marginMode: 'ISOLATED',
      initialMarginRate: 0.05,
      maintenanceMarginRate: 0.025,
      liquidationModel: 'ISOLATED_LINEAR',
    },
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
 * Supports optional venue/account profile overrides.
 * STRICT FAIL-CLOSED: Throws INVALID_INSTRUMENT_SPECIFICATION if instrument is unregistered/unrecognized.
 */
export function getAuthoritativeInstrument(
  symbol: string,
  venueOverride?: Partial<IVenueProfile>,
): IInstrument {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error(`INVALID_INSTRUMENT_SPECIFICATION: Symbol must be a non-empty string, got ${symbol}`);
  }
  const sym = symbol.toUpperCase();
  let baseInstrument: IInstrument | undefined;
  if (customInstruments.has(sym)) {
    baseInstrument = customInstruments.get(sym);
  } else if (sym in AUTHORITATIVE_INSTRUMENTS) {
    baseInstrument = AUTHORITATIVE_INSTRUMENTS[sym];
  }

  if (!baseInstrument) {
    throw new Error(
      `INVALID_INSTRUMENT_SPECIFICATION: No authoritative instrument specification found for symbol '${symbol}'. Production systems fail closed on unconfigured instruments.`,
    );
  }

  if (!venueOverride) {
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

  const marginMode: MarginMode =
    options?.venueOverride?.marginMode ?? instrument.marginMode ?? venue?.marginMode ?? 'SPOT';

  if (marginMode === 'SPOT') {
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
