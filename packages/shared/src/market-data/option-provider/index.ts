/**
 * AI FIX 156 — Provider-origin root of trust.
 *
 * Separates the four layers of option-quote authority:
 *   1. raw provider event            (raw-option-provider-event)
 *   2. validated provider event      (option-provider-validators)
 *   3. canonical execution tick      (canonical-option-provider-tick)
 *   4. Redis canonical record        (canonical-option-quote-record)
 *
 * The provider-specific adapters are the only public entry point for turning a real
 * provider event into a canonical execution tick.
 */
export {
  isProviderConnectionIdUuid,
  isProviderConnectionIdentity,
  ProviderConnectionIdentity,
  IProviderConnectionIdentityInit,
} from './provider-connection-identity';
export * from './raw-option-provider-event';
export * from './option-provider-validators';
export * from './canonical-option-provider-tick';
export * from './canonical-option-quote-record';
export * from './option-provider-adapters';
