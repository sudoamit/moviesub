import { CanonicalProviderTransport } from '../execution-quote-validator';

export interface RawSpotProviderEvent {
  providerSymbol: string;
  price: number;
  providerEventTime: number | Date;
  providerId?: string;
  providerTransport?: CanonicalProviderTransport;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  prevClose?: number;
  changePercent?: number;
  changeAmount?: number;
  volatility?: number;
  tickSize?: number;
  sequence?: number;
  isSynthetic?: boolean;
  connectionEpoch?: number;
}
