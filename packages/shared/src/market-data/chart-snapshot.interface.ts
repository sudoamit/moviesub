import {
  ISwingPoint,
  IBreakOfStructure,
  IChangeOfCharacter,
  IMarketRegime,
  IDealingRange,
  ILiquidityPool,
  IFairValueGap,
  IOrderBlock,
} from '../interfaces';

export type ChartProvenance = 'LIVE' | 'HISTORICAL' | 'DELAYED' | 'BACKTEST' | 'LEARNING' | 'CACHED' | 'SYNTHETIC';
export type TickVolumeType = 'INCREMENTAL' | 'BUCKET_CUMULATIVE' | 'SESSION_CUMULATIVE' | 'UNKNOWN';
export type CandleClosureType = 'TIME_BOUNDARY_INFERRED' | 'PROVIDER_CONFIRMED';

export interface ProviderTick {
  readonly symbol?: string;
  readonly price?: number;
  readonly timestamp?: Date | string | number;
  readonly volume?: number;
  readonly volumeType?: TickVolumeType;
  readonly tickId?: string;
  readonly sequenceNumber?: number;
  readonly providerId?: string;
  readonly connectionEpoch?: string;
  readonly providerConnectionEpoch?: string | null;
  readonly localConnectionInstanceId?: string | null;
  readonly sessionVolume?: number;
  readonly isReconnect?: boolean;
}

export interface NormalizedTick {
  readonly symbol: string;
  readonly price: number;
  readonly timestamp: Date | string | number;
  readonly volume?: number;
  readonly volumeType: TickVolumeType;
  readonly tickId?: string;
  readonly sequenceNumber?: number;
  readonly providerId?: string;
  readonly connectionEpoch?: string;
  readonly providerConnectionEpoch?: string | null;
  readonly localConnectionInstanceId?: string | null;
  readonly sessionVolume?: number;
  readonly isReconnect?: boolean;
}

export interface ChartCandle {
  readonly timestamp: Date | string | number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly isClosed: true;
  readonly provenance?: ChartProvenance;
  readonly closureType?: CandleClosureType;
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

export interface CanonicalStreamState {
  readonly marketAsOf?: Date | string | number | null;
  readonly observedAt?: Date | string | number;
  readonly sessionKey: string;
  readonly providerId?: string;
  readonly connectionEpoch?: string | null;
  readonly providerConnectionEpoch?: string | null;
  readonly localConnectionInstanceId?: string | null;
  readonly lastSequenceNumber?: number | null;
  readonly sessionVolumeWatermark?: number | null;
}

export interface ChartSMCSnapshot {
  readonly symbol: string;
  readonly timeframe: string;
  readonly asOfTimestamp: Date | string | number;
  readonly provenance: ChartProvenance;
  readonly computedAt?: Date | string | number;
  readonly structureAsOf?: Date | string | number;
  readonly marketAsOf?: Date | string | number;
  readonly observedAt?: Date | string | number;
  readonly structures?: {
    swings?: ISwingPoint[];
    bos?: IBreakOfStructure[];
    choch?: IChangeOfCharacter[];
    marketRegime?: IMarketRegime;
    dealingRange?: IDealingRange | null;
  };
  readonly liquidity?: {
    pools?: ILiquidityPool[];
    sweeps?: ILiquidityPool[];
  };
  readonly fvgs?: IFairValueGap[];
  readonly orderBlocks?: IOrderBlock[];
}

export interface ChartMarketSnapshot {
  readonly symbol: string;
  readonly timeframe: string;
  readonly closedCandles: ChartCandle[];
  readonly formingCandle: ChartFormingCandle | null;
  readonly livePrice: number | null;
  readonly closedThrough?: Date | string | number;
  readonly asOfTimestamp: Date | string | number;
  readonly marketAsOf?: Date | string | number;
  readonly latestMarketEventTimestamp?: Date | string | number;
  readonly observedAt?: Date | string | number;
  readonly sessionKey?: string;
  readonly sessionVolumeWatermark?: number | null;
  readonly streamState?: CanonicalStreamState;
  readonly dataProvenance: ChartProvenance;
  readonly sourceIdentity: string;
  readonly smcSnapshot?: ChartSMCSnapshot | null;
  readonly isDegraded?: boolean;
}
