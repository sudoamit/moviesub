import { CanonicalProviderTransport } from '../execution-quote-validator';

/**
 * AI FIX 156 — Raw (untrusted) provider event layer.
 *
 * A RawOptionProviderEvent is the shape of data exactly as it arrives from a provider
 * wire message (WebSocket frame / REST poll body). It carries NO authority: every
 * field is caller-supplied and unverified. It can only be promoted to a
 * `ValidatedOptionProviderEvent` by a provider-specific validator.
 */
export interface RawOptionProviderEvent {
  /** Provider identity that MUST match the validating adapter's declared providerId. */
  readonly providerId: string;
  /** Transport that MUST match the validating adapter's declared transport. */
  readonly providerTransport: CanonicalProviderTransport;
  /** Raw contract/symbol string exactly as delivered by the provider. */
  readonly providerSymbol: string;
  /** Raw price exactly as delivered (providers may deliver numeric strings). */
  readonly price: number | string;
  /** Raw provider event time (epoch ms, numeric string, or Date). */
  readonly providerEventTime: number | string | Date;
  /** Provider connection epoch claimed by the ingestion path. */
  readonly connectionEpoch: number;
  readonly open?: number | string;
  readonly high?: number | string;
  readonly low?: number | string;
  readonly close?: number | string;
  readonly volume?: number | string;
  readonly prevClose?: number | string;
  readonly changePercent?: number | string;
  readonly changeAmount?: number | string;
  readonly volatility?: number | string;
  readonly tickSize?: number | string;
  readonly sequence?: number;
  /** Any provider/derived flag claiming synthetic origin is rejected outright. */
  readonly isSynthetic?: boolean;
}
