"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockMarketDataProvider = void 0;
const candle_validator_1 = require("./candle-validator");
class MockMarketDataProvider {
    providerName = 'MockMarketDataProvider';
    subscriptions = new Map();
    listeners = new Map();
    isConnected = true;
    seed;
    // Base instrument price parameters
    static INSTRUMENT_PROFILES = {
        NIFTY: { basePrice: 24175, volatility: 0.0035, baseVolume: 250000, decimals: 2 },
        BANKNIFTY: { basePrice: 51200, volatility: 0.0055, baseVolume: 180000, decimals: 2 },
        BTCUSDT: { basePrice: 92500, volatility: 0.0085, baseVolume: 1500, decimals: 2 },
        XAUUSD: { basePrice: 2885.5, volatility: 0.0055, baseVolume: 65000, decimals: 2 },
        GOLD: { basePrice: 2885.5, volatility: 0.0055, baseVolume: 65000, decimals: 2 },
        RELIANCE: { basePrice: 3020, volatility: 0.004, baseVolume: 80000, decimals: 2 },
        HDFCBANK: { basePrice: 1650, volatility: 0.0035, baseVolume: 120000, decimals: 2 },
        INFY: { basePrice: 1890, volatility: 0.0045, baseVolume: 95000, decimals: 2 },
    };
    constructor(config) {
        this.seed = config?.seed ?? 12345;
    }
    pseudoRandom() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
    getProfile(symbol) {
        const sym = symbol.toUpperCase();
        return (MockMarketDataProvider.INSTRUMENT_PROFILES[sym] || {
            basePrice: 1000,
            volatility: 0.005,
            baseVolume: 50000,
            decimals: 2,
        });
    }
    async getHistoricalCandles(symbol, timeframe, limit = 100, endTime = new Date()) {
        if (!this.isConnected) {
            throw new Error(`[MockMarketDataProvider] Cannot fetch data: Provider is disconnected`);
        }
        const intervalMs = candle_validator_1.CandleValidator.timeframeToMs(timeframe);
        const profile = this.getProfile(symbol);
        const candles = [];
        // Scale volatility by sqrt of timeframe ratio relative to 15m
        const tfScale = Math.sqrt(intervalMs / (15 * 60 * 1000));
        const stepVol = profile.volatility * tfScale;
        // Start backwards from endTime rounded to timeframe boundary
        const endTimestamp = Math.floor(endTime.getTime() / intervalMs) * intervalMs;
        const startTimestamp = endTimestamp - (limit - 1) * intervalMs;
        let currentPrice = profile.basePrice;
        for (let i = 0; i < limit; i++) {
            const candleTime = new Date(startTimestamp + i * intervalMs);
            // Deterministic synthetic price path with SMC swing structure
            const trendWave = Math.sin((i / limit) * 4 * Math.PI) * stepVol * 1.5;
            const noise = (this.pseudoRandom() - 0.49) * stepVol * 2;
            const returnPct = trendWave * 0.2 + noise;
            const open = Number(currentPrice.toFixed(profile.decimals));
            const close = Number(Math.max(1, open * (1 + returnPct)).toFixed(profile.decimals));
            const maxBody = Math.max(open, close);
            const minBody = Math.min(open, close);
            // Add realistic upper and lower wicks (liquidity sweeps)
            const upperWick = (this.pseudoRandom() * 0.8 + 0.1) * (open * stepVol);
            const lowerWick = (this.pseudoRandom() * 0.8 + 0.1) * (open * stepVol);
            const high = Number((maxBody + upperWick).toFixed(profile.decimals));
            const low = Number(Math.max(0.01, minBody - lowerWick).toFixed(profile.decimals));
            const volumeNoise = (this.pseudoRandom() * 0.8 + 0.6) * profile.baseVolume;
            const volume = Math.round(volumeNoise * (1 + Math.abs(returnPct) * 10));
            candles.push({
                timestamp: candleTime,
                open,
                high,
                low,
                close,
                volume,
                isClosed: true,
            });
            currentPrice = close;
        }
        return candles;
    }
    async getLatestCandle(symbol, timeframe) {
        const historical = await this.getHistoricalCandles(symbol, timeframe, 1);
        return historical[0];
    }
    async subscribeToMarketData(symbol, timeframe, onCandle) {
        const key = `${symbol.toUpperCase()}:${timeframe}`;
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key).add(onCandle);
        if (!this.subscriptions.has(key)) {
            const intervalMs = Math.min(candle_validator_1.CandleValidator.timeframeToMs(timeframe), 5000);
            const timer = setInterval(async () => {
                if (!this.isConnected)
                    return;
                const latest = await this.getLatestCandle(symbol, timeframe);
                const callbacks = this.listeners.get(key);
                if (callbacks) {
                    callbacks.forEach((cb) => cb(latest));
                }
            }, intervalMs);
            this.subscriptions.set(key, timer);
        }
    }
    async unsubscribeFromMarketData(symbol, timeframe) {
        const key = `${symbol.toUpperCase()}:${timeframe}`;
        const timer = this.subscriptions.get(key);
        if (timer) {
            clearInterval(timer);
            this.subscriptions.delete(key);
        }
        this.listeners.delete(key);
    }
    simulateDisconnect() {
        this.isConnected = false;
    }
    simulateReconnect() {
        this.isConnected = true;
    }
    getIsConnected() {
        return this.isConnected;
    }
}
exports.MockMarketDataProvider = MockMarketDataProvider;
//# sourceMappingURL=mock-market-data-provider.js.map