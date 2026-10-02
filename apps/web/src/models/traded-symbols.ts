/**
 * The instruments this terminal trades. Every symbol picker, ticker bar and live subscription uses this list;
 * other instruments are deactivated on the server (not scanned, no bots).
 */
export const TRADED_SYMBOLS = [
  { symbol: 'NIFTY', label: 'NIFTY 50', shortLabel: 'NIFTY', assetType: 'INDEX', tag: 'INDEX' },
  { symbol: 'XAUUSD', label: 'XAU / USD', shortLabel: 'GOLD 🥇', assetType: 'COMMODITY', tag: 'GOLD' },
  { symbol: 'BTCUSDT_PERP', label: 'BTC / USDT PERP', shortLabel: 'BTC PERP ⚡', assetType: 'CRYPTO', tag: 'FUTURES' },
] as const;

export const TRADED_SYMBOL_SET = new Set<string>(TRADED_SYMBOLS.map((s) => s.symbol));

/** Maps aliases to a traded symbol; anything not traded falls back to NIFTY. */
export function toTradedSymbol(raw: string): string {
  const s = (raw || '').toUpperCase().trim();
  if (s === 'BTC' || s === 'BTC/USDT' || s === 'BITCOIN' || s.startsWith('BTCUSDT')) return 'BTCUSDT_PERP';
  if (s === 'GOLD' || s === 'XAU' || s === 'XAU/USD' || s === 'SPOTGOLD') return 'XAUUSD';
  return TRADED_SYMBOL_SET.has(s) ? s : 'NIFTY';
}
