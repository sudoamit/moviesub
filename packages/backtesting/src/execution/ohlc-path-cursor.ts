import { ICandle } from '@quant/shared';

export interface IOHLCSegment {
  start: number;
  end: number;
  type: 'OPEN_LOW' | 'LOW_HIGH' | 'HIGH_CLOSE' | 'OPEN_HIGH' | 'HIGH_LOW' | 'LOW_CLOSE';
}

export class OHLCPathCursor {
  public segmentIndex: number = 0;
  public readonly segments: IOHLCSegment[];

  constructor(candle: ICandle) {
    const isBullish = candle.close >= candle.open;

    if (isBullish) {
      // Bullish candle path: Open -> Low -> High -> Close
      this.segments = [
        { start: candle.open, end: candle.low, type: 'OPEN_LOW' },
        { start: candle.low, end: candle.high, type: 'LOW_HIGH' },
        { start: candle.high, end: candle.close, type: 'HIGH_CLOSE' },
      ];
    } else {
      // Bearish candle path: Open -> High -> Low -> Close
      this.segments = [
        { start: candle.open, end: candle.high, type: 'OPEN_HIGH' },
        { start: candle.high, end: candle.low, type: 'HIGH_LOW' },
        { start: candle.low, end: candle.close, type: 'LOW_CLOSE' },
      ];
    }
  }

  public get currentSegment(): IOHLCSegment | undefined {
    return this.segments[this.segmentIndex];
  }

  public get isFinished(): boolean {
    return this.segmentIndex >= this.segments.length;
  }

  public advance(): boolean {
    if (this.segmentIndex < this.segments.length) {
      this.segmentIndex++;
    }
    return !this.isFinished;
  }

  public remainingSegments(): IOHLCSegment[] {
    return this.segments.slice(this.segmentIndex);
  }
}
