export type ChartProvenance = 'LIVE' | 'HISTORICAL' | 'DELAYED' | 'BACKTEST' | 'LEARNING' | 'CACHED' | 'SYNTHETIC';
export type TickVolumeType = 'INCREMENTAL' | 'CUMULATIVE';

export interface ChartCandle {
  readonly timestamp: Date | string | number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly isClosed: true;
  readonly provenance?: ChartProvenance;
}

export interface ChartFormingCandle {
  readonly timestamp: Date | string | number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly isClosed: false;
  readonly provenance?: ChartProvenance;
  readonly volumeType?: TickVolumeType;
}

export interface ChartSMCSnapshot {
  readonly symbol: string;
  readonly timeframe: string;
  readonly asOfTimestamp: Date | string | number;
  readonly provenance: ChartProvenance;
  readonly computedAt?: Date | string | number;
  readonly structureAsOf?: Date | string | number;
  readonly structures?: {
    swings?: any[];
    bos?: any[];
    choch?: any[];
    marketRegime?: any;
    dealingRange?: any;
  };
  readonly liquidity?: {
    pools?: any[];
    sweeps?: any[];
  };
  readonly fvgs?: any[];
  readonly orderBlocks?: any[];
}

export interface ChartMarketSnapshot {
  readonly symbol: string;
  readonly timeframe: string;
  readonly closedCandles: ChartCandle[];
  readonly formingCandle: ChartFormingCandle | null;
  readonly livePrice: number | null;
  readonly closedThrough?: Date | string | number;
  readonly asOfTimestamp: Date | string | number;
  readonly dataProvenance: ChartProvenance;
  readonly sourceIdentity: string;
  readonly smcSnapshot?: ChartSMCSnapshot | null;
  readonly isDegraded?: boolean;
}
