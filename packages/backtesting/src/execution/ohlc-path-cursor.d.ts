import { ICandle } from '@quant/shared';
export interface IOHLCSegment {
    start: number;
    end: number;
    type: 'OPEN_LOW' | 'LOW_HIGH' | 'HIGH_CLOSE' | 'OPEN_HIGH' | 'HIGH_LOW' | 'LOW_CLOSE';
}
export declare class OHLCPathCursor {
    segmentIndex: number;
    readonly segments: IOHLCSegment[];
    constructor(candle: ICandle);
    get currentSegment(): IOHLCSegment | undefined;
    get isFinished(): boolean;
    advance(): boolean;
    remainingSegments(): IOHLCSegment[];
}
