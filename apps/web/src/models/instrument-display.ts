/**
 * Display helpers for instrument quote currency.
 * BTC (any alias: BTCUSDT, BTCUSDT_SPOT, ...) and gold are quoted in USD/USDT; everything else in INR.
 * Always use these instead of comparing raw symbol strings, which misses aliases like BTCUSDT_SPOT.
 */
export function isUsdQuoted(symbol?: string | null): boolean {
  const sym = (symbol || '').toUpperCase().trim();
  return sym.includes('BTC') || sym === 'XAUUSD' || sym === 'GOLD' || sym === 'PAXGUSDT';
}

export function quoteCurrencySymbol(symbol?: string | null): '$' | '₹' {
  return isUsdQuoted(symbol) ? '$' : '₹';
}
