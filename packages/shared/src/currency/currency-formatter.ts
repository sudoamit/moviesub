import { CurrencyCode } from '../interfaces';

/**
 * Format currency amount with strict institutional symbols/suffixes.
 *
 * Rules:
 * - INR: ₹46,000.00
 * - USD: $500.00
 * - USDT: 500.00 USDT (NEVER $500 USDT or $500)
 * - EUR: €500.00
 * - GBP: £500.00
 * - BTC: 0.25000000 BTC
 */
export function formatCurrencyAmount(
  amount: number,
  currency: CurrencyCode | string,
  options?: {
    showSign?: boolean;
    decimals?: number;
  },
): string {
  const normalized = (currency || 'INR').toUpperCase();
  const showSign = options?.showSign ?? false;
  const isNegative = amount < 0;
  const absVal = Math.abs(amount);

  let decimals = options?.decimals;
  if (decimals === undefined) {
    if (normalized === 'BTC' || normalized === 'ETH') {
      decimals = 6;
    } else if (normalized === 'USDT' || normalized === 'USD' || normalized === 'INR' || normalized === 'EUR' || normalized === 'GBP') {
      decimals = 2;
    } else {
      decimals = 2;
    }
  }

  const formattedNum = absVal.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const signPrefix = isNegative ? '-' : showSign && amount > 0 ? '+' : '';

  switch (normalized) {
    case 'INR':
      return `${signPrefix}₹${formattedNum}`;
    case 'USD':
      return `${signPrefix}$${formattedNum}`;
    case 'USDT':
      return `${signPrefix}${formattedNum} USDT`;
    case 'EUR':
      return `${signPrefix}€${formattedNum}`;
    case 'GBP':
      return `${signPrefix}£${formattedNum}`;
    default:
      return `${signPrefix}${formattedNum} ${normalized}`;
  }
}

/**
 * Formats a market price in its quote/native currency.
 */
export function formatPriceWithCurrency(
  price: number,
  currency: CurrencyCode | string,
  decimals?: number,
): string {
  return formatCurrencyAmount(price, currency, { showSign: false, decimals });
}

/**
 * Formats realized or unrealized P&L in its denomination currency with explicit +/- sign.
 */
export function formatPnlWithCurrency(
  pnl: number,
  currency: CurrencyCode | string,
  decimals?: number,
): string {
  return formatCurrencyAmount(pnl, currency, { showSign: true, decimals });
}
