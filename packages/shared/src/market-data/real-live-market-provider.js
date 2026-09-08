"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealLiveMarketDataProvider = void 0;
const enums_1 = require("../enums");
class RealLiveMarketDataProvider {
    providerName = 'RealLiveMarketDataProvider';
    static SYMBOL_MAP = {
        NIFTY: '^NSEI',
        BANKNIFTY: '^NSEBANK',
        RELIANCE: 'RELIANCE.NS',
        HDFCBANK: 'HDFCBANK.NS',
        INFY: 'INFY.NS',
    };
    /**
     * Fetches real historical candles directly from Yahoo Finance and Binance public APIs
     */
    async getHistoricalCandles(symbol, timeframe, limit = 100, endTime = new Date()) {
        const sym = symbol.toUpperCase();
        if (sym === 'BTCUSDT') {
            return this.fetchBinanceCandles(timeframe, limit);
        }
        return this.fetchYahooCandles(sym, timeframe, limit);
    }
    async getLatestCandle(symbol, timeframe) {
        const candles = await this.getHistoricalCandles(symbol, timeframe, 5);
        return candles[candles.length - 1];
    }
    async subscribeToMarketData(symbol, timeframe, onCandle) {
        // Real-time streaming handled by WebSocket connector
    }
    async unsubscribeFromMarketData(symbol, timeframe) { }
    async fetchBinanceCandles(timeframe, limit) {
        const interval = this.mapTimeframeToBinance(timeframe);
        const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (!Array.isArray(data)) {
                throw new Error(`Binance API error: ${JSON.stringify(data)}`);
            }
            return data.map((k) => ({
                timestamp: new Date(k[0]),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                isClosed: true,
            }));
        }
        catch (err) {
            console.error(`Error fetching Binance candles: ${err.message}`);
            return [];
        }
    }
    async fetchYahooCandles(symbol, timeframe, limit) {
        const yahooSymbol = RealLiveMarketDataProvider.SYMBOL_MAP[symbol] || symbol;
        const interval = this.mapTimeframeToYahoo(timeframe);
        const range = this.getRangeForTimeframe(timeframe, limit);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const data = await res.json();
            const result = data?.chart?.result?.[0];
            if (!result || !result.timestamp) {
                throw new Error(`No chart data returned for ${yahooSymbol}`);
            }
            const timestamps = result.timestamp;
            const quote = result.indicators?.quote?.[0];
            if (!quote)
                return [];
            const candles = [];
            for (let i = 0; i < timestamps.length; i++) {
                const o = quote.open[i];
                const h = quote.high[i];
                const l = quote.low[i];
                const c = quote.close[i];
                const v = quote.volume[i] || 0;
                if (o !== null && h !== null && l !== null && c !== null) {
                    candles.push({
                        timestamp: new Date(timestamps[i] * 1000),
                        open: Number(Number(o).toFixed(2)),
                        high: Number(Number(h).toFixed(2)),
                        low: Number(Number(l).toFixed(2)),
                        close: Number(Number(c).toFixed(2)),
                        volume: Math.round(v),
                        isClosed: true,
                    });
                }
            }
            return candles.slice(-limit);
        }
        catch (err) {
            console.error(`Error fetching Yahoo Finance candles for ${symbol}: ${err.message}`);
            return [];
        }
    }
    mapTimeframeToBinance(tf) {
        switch (tf) {
            case '1m':
            case enums_1.Timeframe.M1:
                return '1m';
            case '5m':
            case enums_1.Timeframe.M5:
                return '5m';
            case '15m':
            case enums_1.Timeframe.M15:
                return '15m';
            case '30m':
            case enums_1.Timeframe.M30:
                return '30m';
            case '1h':
            case enums_1.Timeframe.H1:
                return '1h';
            case '4h':
            case enums_1.Timeframe.H4:
                return '4h';
            case '1d':
            case enums_1.Timeframe.D1:
                return '1d';
            default:
                return '15m';
        }
    }
    mapTimeframeToYahoo(tf) {
        switch (tf) {
            case '1m':
            case enums_1.Timeframe.M1:
                return '1m';
            case '5m':
            case enums_1.Timeframe.M5:
                return '5m';
            case '15m':
            case enums_1.Timeframe.M15:
                return '15m';
            case '30m':
            case enums_1.Timeframe.M30:
                return '30m';
            case '1h':
            case enums_1.Timeframe.H1:
                return '60m';
            case '4h':
            case enums_1.Timeframe.H4:
                return '60m';
            case '1d':
            case enums_1.Timeframe.D1:
                return '1d';
            default:
                return '15m';
        }
    }
    getRangeForTimeframe(tf, limit) {
        if (tf === '1m' || tf === '5m')
            return '5d';
        if (tf === '15m' || tf === '30m')
            return '1mo';
        if (tf === '1h' || tf === '4h')
            return '3mo';
        return '1y';
    }
}
exports.RealLiveMarketDataProvider = RealLiveMarketDataProvider;
//# sourceMappingURL=real-live-market-provider.js.map