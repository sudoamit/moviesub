import { InstrumentProfile } from './types';

const M15 = 15 * 60 * 1000;

/**
 * Execution assumptions per traded instrument (15m bars). Round-trip cost = fees both sides + spread/slippage.
 * Session windows are UTC and ignore daylight-saving shifts (about one hour of drift for London / New York).
 */
export const INSTRUMENT_PROFILES: Record<string, InstrumentProfile> = {
  BTCUSDT_PERP: {
    symbol: 'BTCUSDT_PERP',
    // Binance USDⓈ-M regular tier: maker 0.02%, taker 0.05%; ~0.01% slippage per market fill
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    slippageRate: 0.0001,
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
        // Binance USDⓈ-M: maker 0.02%, taker 0.05%; alts get ~0.02% slippage per market fill
        makerFeeRate: 0.0002,
        takerFeeRate: 0.0005,
        slippageRate: 0.0002,
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
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    slippageRate: 0.0001,
    barMs: M15,
    killzones: [
      { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
      { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
    ],
    silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
  },
  XAUUSD: {
    symbol: 'XAUUSD',
    // Paper engine charges 0.02% per side (COMEX schedule); ~0.01% spread/slippage per market fill
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0002,
    slippageRate: 0.0001,
    barMs: M15,
    killzones: [
      { name: 'London open', startHourUtc: 7, endHourUtc: 10 },
      { name: 'New York open', startHourUtc: 12.5, endHourUtc: 15.5 },
    ],
    silverBullet: { name: 'NY AM Silver Bullet', startHourUtc: 14, endHourUtc: 15 },
  },
  NIFTY: {
    symbol: 'NIFTY',
    // Simulated on the index as a proxy for the option trade: ~0.05% of underlying round trip (premium spread + charges)
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
