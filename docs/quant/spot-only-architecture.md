# Spot-Only Quantitative Trading Architecture Specification

**Repository**: `sudoamit/moviesub`  
**Architecture Version**: 2.0.0 (Spot-Only Cash Model)  
**Date**: September 2026  

---

## 1. Executive Summary & Non-Negotiable Requirements

The quantitative trading system has been refactored into a **genuinely spot-only cash trading architecture**. All derivative mechanics have been structurally eliminated from the spot domain.

### Supported Spot Trading Universe

The system strictly enforces an explicit allowlist containing only the following canonical instruments:

1. **`NIFTY_SPOT`**: Theoretical cash index-level research for the NIFTY 50 benchmark.
2. **`BANKNIFTY_SPOT`**: Theoretical cash index-level research for the NIFTY Bank benchmark.
3. **`BTCUSDT_SPOT`**: Cash cryptocurrency spot asset quoted in USDT on Binance with INR portfolio accounting.

> **Index Level Notice**:  
> NIFTY and BANKNIFTY are index levels and are not directly purchasable securities. Their spot strategies therefore represent theoretical index-level research/backtesting unless a separately defined tradable proxy is introduced.

### Strictly Forbidden Derivative Mechanics

The spot trading pipeline explicitly prohibits and excludes:
* Futures contracts (`NIFTY_FUT`, `BANKNIFTY_FUT`, etc.)
* Option contracts (`NIFTY_OPTION`, `BANKNIFTY_OPTION`, etc.)
* Perpetual contracts (`BTCUSDT_PERP`, etc.)
* Financial leverage ($> 1$)
* Margin requirements (Initial Margin, Maintenance Margin, Margin Calls, SPAN)
* Funding rates and funding payments
* Liquidation thresholds and liquidation models
* Expiry dates and contract rollover
* Futures Mark-to-Market (MTM) settlement
* Naked short-selling

---

## 2. Canonical Instrument Identity & Allowlist Enforcement

### Canonical Spot Symbols vs Legacy Aliases

| Canonical Spot Symbol | Exchange | Asset Type | Quote Currency | Account Currency | Lot Size | Multiplier | Market Data Mapping |
|:---|:---|:---|:---|:---|:---|:---|:---|
| **`NIFTY_SPOT`** | NSE | SPOT / INDEX | INR | INR | 1 | 1 | `^NSEI` (Yahoo Finance / NSE Cash) |
| **`BANKNIFTY_SPOT`** | NSE | SPOT / INDEX | INR | INR | 1 | 1 | `^NSEBANK` (Yahoo Finance / NSE Cash) |
| **`BTCUSDT_SPOT`** | BINANCE | SPOT / CRYPTO | USDT | INR | 0.00001 | 1 | `BTCUSDT` (Binance Spot REST/WS) |

### Fail-Closed Enforcement Rules

1. **Derivative Rejections**: Any request using `NIFTY_FUT`, `BANKNIFTY_FUT`, `NIFTY_OPTION`, `BANKNIFTY_OPTION`, or `BTCUSDT_PERP` fails closed immediately with `FORBIDDEN_DERIVATIVE_INSTRUMENT`.
2. **Legacy Alias Handling**: The spot engine (`SpotBacktestSimulator`) strictly requires canonical symbols. Passing legacy aliases (`NIFTY`, `BANKNIFTY`, `BTCUSDT`) directly into the spot strategy engine fails closed with `LEGACY_ALIAS_REJECTED`.
3. **Unsupported Universe Isolation**: Legacy symbols such as `GOLD`, `GOLD_MCX`, `XAUUSD`, `RELIANCE`, `HDFCBANK`, `INFY`, and `ETHUSDT` are not part of the supported spot universe and are rejected with `UNSUPPORTED_SPOT_INSTRUMENT` when presented to the spot strategy engine.

---

## 3. Structural Elimination of Fake Derivative Modeling

Spot instruments are defined by the clean `ISpotInstrument` domain interface:

```typescript
export interface ISpotInstrument {
  id: string;
  symbol: SupportedSpotSymbol;
  name: string;
  exchange: 'NSE' | 'BINANCE';
  assetType: AssetType;
  baseCurrency: string;
  quoteCurrency: CurrencyCode;
  accountingCurrency: CurrencyCode;
  tickSize: number;
  lotSize: number;
  contractMultiplier: 1;
  minimumQuantity: number;
  quantityPrecision: number;
  pricePrecision: number;
  tradingHoursJson?: Record<string, any> | null;
  isActive: boolean;
  isSpot: true;
}
```

The spot domain contains **no** fake derivative fields:
* `defaultLeverage` &rarr; Removed
* `maxLeverage` &rarr; Removed
* `initialMarginRate` &rarr; Removed
* `maintenanceMarginRate` &rarr; Removed
* `liquidationModel` &rarr; Removed
* `expiryDate` &rarr; Removed

All spot accounting records report:
* `leverage = 1`
* `marginRequired = 0`
* `initialMarginRequired = 0`
* `maintenanceMarginRequired = 0`
* `marginUsed = 0`
* `availableMargin = currentCash`
* `liquidationPrice = undefined`

---

## 4. Pure Cash Position Sizing Formula

Position sizing in the spot engine is determined by `PositionSizer.calculateSpotPosition` and enforces cash and risk constraints with zero leverage:

$$\text{riskAmount} = \text{equity} \times \text{riskPercent}$$

$$\text{riskPerUnit} = |\text{entryPrice} - \text{stopLoss}| \times \text{fxRate}$$

$$\text{quantityByRisk} = \frac{\text{riskAmount}}{\text{riskPerUnit}}$$

$$\text{quantityByCash} = \frac{\text{availableCash}}{\text{entryPrice} \times \text{fxRate}}$$

$$\text{quantity} = \min(\text{quantityByRisk}, \text{quantityByCash})$$

$$\text{finalQuantity} = \text{quantize}(\text{quantity}, \text{lotSize}, \text{quantityPrecision})$$

### Invariant: Available Cash Ceiling

$$\text{finalQuantity} \times \text{entryPrice} \times \text{contractMultiplier} \times \text{fxRate} \le \text{availableCash}$$

The trade notional can never exceed available cash. If $\text{quantity} < \text{minimumQuantity}$, the order fails closed and is rejected.

---

## 5. Prohibition of Naked Shorting

In spot trading, an investor cannot sell what they do not hold.
* **BUY**: Valid if sufficient cash is available to fund 100% of the trade notional plus fees.
* **SELL**: Permitted strictly as an exit or reduction of an open long position:
  $$\text{sellQuantity} \le \text{currentHeldQuantity}$$
* **Naked Shorting**: Any entry order with $\text{side} = \text{SELL}$ or $\text{positionSide} = \text{SHORT}$ throws `SPOT_SHORT_SELLING_FORBIDDEN`.
* No borrow mechanics, short margin, or synthetic short positions are supported.

---

## 6. Multi-Currency Point-in-Time Accounting (`BTCUSDT_SPOT`)

BTC trades are quoted in USDT on Binance, while the account portfolio is maintained in INR.

### Point-in-Time FX Conversion Pipeline

1. Every cross-currency transaction must resolve a timestamped historical FX rate via `PointInTimeCurrencyConverter.getInstance().getRate('USDT', 'INR', timestamp)`.
2. **Zero Lookahead**: The converter matches historical rates where $\text{rateTimestamp} \le \text{eventTimestamp}$.
3. **No Synthetic Fixed Fallbacks**: The system prohibits falling back to fixed rates (such as 92 or 1.0). If no historical FX rate is available, the converter throws `MISSING_FX_RATE`.
4. **Independent Fee Conversion**: USDT fees are converted to INR using the fill timestamp's FX rate:
   $$\text{feeINR} = \text{feeUSDT} \times \text{fxRate}(t_{\text{fill}})$$
   A USDT fee is never subtracted directly from INR cash or INR P&L.
5. **Cash Ledger**:
   * On BUY:
     $$\text{currentCash} = \text{currentCash} - (\text{fillPrice} \times \text{fillQty} \times \text{fxRate} + \text{feeINR})$$
   * On SELL:
     $$\text{currentCash} = \text{currentCash} + (\text{fillPrice} \times \text{fillQty} \times \text{fxRate} - \text{feeINR})$$
   * Snapshot Equity:
     $$\text{equity} = \text{cash} + (\text{remainingQty} \times \text{closePrice} \times \text{fxRate}(t_{\text{candle}}))$$

---

## 7. Performance Metrics Calibration

### 1. Turnover Based on Actual Fills

$$\text{turnover} = \sum_{f \in \text{fills}} |f.\text{price} \times f.\text{quantity} \times f.\text{contractMultiplier} \times f.\text{fxRate}|$$

Turnover accounts for all actual fills (entry, partial target scale-outs, stop loss fills, trailing stops).

### 2. Elapsed Calendar Days CAGR

Intraday bar counts are not treated as trading days. CAGR calculates true elapsed calendar time:

$$\text{elapsedDays} = \max\left(1, \frac{t_{\text{end}} - t_{\text{start}}}{86,400,000}\right)$$

$$\text{CAGR} = \left(\frac{\text{finalEquity}}{\text{initialCapital}}\right)^{\frac{365.25}{\text{elapsedDays}}} - 1$$

### 3. Daily Aggregated Sharpe and Sortino

Intraday 15-minute equity snapshots are resampled into continuous daily close returns before annualizing:

$$\text{Sharpe} = \frac{\mu_{\text{daily}} - R_f}{\sigma_{\text{daily}}} \times \sqrt{252}$$

$$\text{Sortino} = \frac{\mu_{\text{daily}} - R_f}{\sigma_{\text{downside}}} \times \sqrt{252}$$
