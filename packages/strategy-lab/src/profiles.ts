import { CostScheduleId, estimatedSlippageRate, feeRateForSchedule, feeRateForSymbol } from '@quant/shared';
import { InstrumentProfile } from './types';

/**
 * Fee rates come from the shared canonical cost model (the same rates execution and accounting charge);
 * slippage is the shared ESTIMATED slippage for that instrument. Nothing here restates a fee number.
 */
function scheduleCosts(symbol: string, researchOnlySchedule?: CostScheduleId): Pick<InstrumentProfile, 'makerFeeRate' | 'takerFeeRate' | 'slippageRate' | 'costBasis'> {
  // Research-only confirmation markets (not executable here) use their venue's schedule, named explicitly
  const fee = (l: 'MAKER' | 'TAKER') => (researchOnlySchedule ? feeRateForSchedule(researchOnlySchedule, l) : feeRateForSymbol(symbol, l));
  return {
    makerFeeRate: fee('MAKER'),
    takerFeeRate: fee('TAKER'),
    slippageRate: estimatedSlippageRate(symbol),
    costBasis: 'SCHEDULE',
  };
}

const M15 = 15 * 60 * 1000;

/**
 * Execution assumptions per traded instrument (15m bars). Round-trip cost = fees both sides + spread/slippage.
 * Session windows are UTC and ignore daylight-saving shifts (about one hour of drift for London / New York).
 */
export const INSTRUMENT_PROFILES: Record<string, InstrumentProfile> = {
  BTCUSDT_PERP: {
    symbol: 'BTCUSDT_PERP',
    ...scheduleCosts('BTCUSDT_PERP'),
    barMs: M15,
    killzones: [
      { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
      { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
    ],
    silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
  },
  ...Object.fromEntries(
    ['SOLUSDT_PERP', 'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP', 'AVAXUSDT_PERP'].map((symbol) => [
      symbol,
      {
        symbol,
        // XRP / DOGE / AVAX are research-only confirmation markets on the same venue
        ...scheduleCosts(symbol, ['XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP'].includes(symbol) ? 'BINANCE_USDM_FUTURES' : undefined),
        barMs: M15,
        killzones: [
          { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
          { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
        ],
        silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
      } as InstrumentProfile,
    ]),
  ),
  // Confirmation market for out-of-market validation.
  ETHUSDT_PERP: {
    symbol: 'ETHUSDT_PERP',
    ...scheduleCosts('ETHUSDT_PERP'),
    barMs: M15,
    killzones: [
      { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
      { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
    ],
    silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
  },
  XAUUSD: {
    symbol: 'XAUUSD',
    ...scheduleCosts('XAUUSD'),
    barMs: M15,
    killzones: [
      { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
      { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
    ],
    silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
  },
  NIFTY: {
    symbol: 'NIFTY',
    // INDEX PROXY (not an executable fee schedule): the option trade is simulated on the index with ~0.05% of the
    // underlying per round trip for premium spread + charges. Never used for execution or accounting.
    costBasis: 'INDEX_PROXY',
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0002,
    slippageRate: 0.00005,
    barMs: M15,
    killzones: [
      { name: 'NSE open drive', startHourUtc: 3.75, endHourUtc: 5.25 },
      { name: 'NSE afternoon', startHourUtc: 8, endHourUtc: 9.75 },
    ],
  },
};
