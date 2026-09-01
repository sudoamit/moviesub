import { ICandle } from '@quant/shared';

export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export function extractPrices(candles: ICandle[], source: PriceSource = 'close'): number[] {
  return candles.map((c) => {
    switch (source) {
      case 'open':
        return c.open;
      case 'high':
        return c.high;
      case 'low':
        return c.low;
      case 'hl2':
        return (c.high + c.low) / 2;
      case 'hlc3':
        return (c.high + c.low + c.close) / 3;
      case 'ohlc4':
        return (c.open + c.high + c.low + c.close) / 4;
      case 'close':
      default:
        return c.close;
    }
  });
}

export interface IADXResult {
  adx: (number | null)[];
  plusDI: (number | null)[];
  minusDI: (number | null)[];
}

export interface IBollingerBandsResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
  bandwidth: (number | null)[];
  percentB: (number | null)[];
}

export interface IIndicatorSummary {
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  plusDI: number | null;
  minusDI: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  vwap: number | null;
}
