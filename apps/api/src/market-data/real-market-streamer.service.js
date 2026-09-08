"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RealMarketStreamerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealMarketStreamerService = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../common/redis/redis.service");
const shared_1 = require("@quant/shared");
let RealMarketStreamerService = RealMarketStreamerService_1 = class RealMarketStreamerService {
    redis;
    logger = new common_1.Logger(RealMarketStreamerService_1.name);
    nseTimer = null;
    binanceTimer = null;
    microTickTimer = null;
    tickers = new Map([
        [
            'NIFTY',
            {
                symbol: 'NIFTY',
                price: 24175.65,
                open: 24160.0,
                high: 24220.0,
                low: 24135.0,
                close: 24175.65,
                volume: 1250000,
                prevClose: 24207.8,
                changePercent: -0.13,
                changeAmount: -32.15,
                tickSize: 0.05,
                volatility: 0.8,
                lastUpdated: Date.now(),
            },
        ],
        [
            'BANKNIFTY',
            {
                symbol: 'BANKNIFTY',
                price: 57496.3,
                open: 57350.0,
                high: 57650.0,
                low: 57280.0,
                close: 57496.3,
                volume: 850000,
                prevClose: 57380.0,
                changePercent: 0.2,
                changeAmount: 116.3,
                tickSize: 0.05,
                volatility: 2.2,
                lastUpdated: Date.now(),
            },
        ],
        [
            'BTCUSDT',
            {
                symbol: 'BTCUSDT',
                price: 79623.35,
                open: 79200.0,
                high: 80100.0,
                low: 78900.0,
                close: 79623.35,
                volume: 45000,
                prevClose: 79150.0,
                changePercent: 0.6,
                changeAmount: 473.35,
                tickSize: 0.1,
                volatility: 8.5,
                lastUpdated: Date.now(),
            },
        ],
        [
            'XAUUSD',
            {
                symbol: 'XAUUSD',
                price: 2885.5,
                open: 2872.0,
                high: 2898.0,
                low: 2865.0,
                close: 2885.5,
                volume: 95000,
                prevClose: 2875.0,
                changePercent: 0.36,
                changeAmount: 10.5,
                tickSize: 0.01,
                volatility: 1.2,
                lastUpdated: Date.now(),
            },
        ],
        [
            'RELIANCE',
            {
                symbol: 'RELIANCE',
                price: 1287.0,
                open: 1282.0,
                high: 1291.8,
                low: 1280.0,
                close: 1287.0,
                volume: 320000,
                prevClose: 1285.0,
                changePercent: 0.16,
                changeAmount: 2.0,
                tickSize: 0.05,
                volatility: 0.3,
                lastUpdated: Date.now(),
            },
        ],
        [
            'HDFCBANK',
            {
                symbol: 'HDFCBANK',
                price: 720.3,
                open: 715.0,
                high: 720.3,
                low: 707.0,
                close: 720.3,
                volume: 450000,
                prevClose: 712.0,
                changePercent: 1.17,
                changeAmount: 8.3,
                tickSize: 0.05,
                volatility: 0.15,
                lastUpdated: Date.now(),
            },
        ],
        [
            'INFY',
            {
                symbol: 'INFY',
                price: 1144.0,
                open: 1135.0,
                high: 1145.0,
                low: 1123.3,
                close: 1144.0,
                volume: 280000,
                prevClose: 1138.0,
                changePercent: 0.53,
                changeAmount: 6.0,
                tickSize: 0.05,
                volatility: 0.25,
                lastUpdated: Date.now(),
            },
        ],
    ]);
    constructor(redis) {
        this.redis = redis;
    }
    onModuleInit() {
        this.startRealTimeFeeds();
    }
    startRealTimeFeeds() {
        this.logger.log('Connecting to Live Real Market Data Feeds (Binance Public API & NSE Real-Time Quotes)...');
        // 1. Fetch Real Binance Bitcoin Price every 2 seconds
        this.binanceTimer = setInterval(async () => {
            await this.fetchRealBinancePrice();
        }, 2000);
        // 2. Fetch Real NSE Indian Market Quotes every 3.5 seconds
        this.nseTimer = setInterval(async () => {
            await this.fetchRealNSEQuotes();
        }, 3500);
        // Initial fetch
        this.fetchRealBinancePrice();
        this.fetchRealNSEQuotes();
    }
    async fetchRealBinancePrice() {
        try {
            const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
            const data = await res.json();
            if (data && data.lastPrice) {
                const livePrice = parseFloat(data.lastPrice);
                const open = parseFloat(data.openPrice);
                const high = parseFloat(data.highPrice);
                const low = parseFloat(data.lowPrice);
                const volume = parseFloat(data.volume);
                const changePercent = parseFloat(data.priceChangePercent);
                const changeAmount = parseFloat(data.priceChange);
                const ticker = this.tickers.get('BTCUSDT') || {
                    symbol: 'BTCUSDT',
                    price: livePrice,
                    open,
                    high,
                    low,
                    close: livePrice,
                    volume: Math.round(volume),
                    prevClose: open,
                    changePercent,
                    changeAmount,
                    tickSize: 0.1,
                    volatility: 8.5,
                    lastUpdated: Date.now(),
                };
                ticker.price = livePrice;
                ticker.close = livePrice;
                ticker.high = Math.max(ticker.high, high);
                ticker.low = Math.min(ticker.low, low);
                ticker.volume = Math.round(volume);
                ticker.changePercent = changePercent;
                ticker.changeAmount = changeAmount;
                ticker.lastUpdated = Date.now();
                this.tickers.set('BTCUSDT', ticker);
                await this.broadcastTick(ticker);
            }
            // Fetch Real Spot Gold Price (via PAXGUSDT 1:1 backed physical gold ounces)
            const goldRes = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT');
            const goldData = await goldRes.json();
            if (goldData && goldData.lastPrice) {
                const livePrice = parseFloat(goldData.lastPrice);
                const open = parseFloat(goldData.openPrice);
                const high = parseFloat(goldData.highPrice);
                const low = parseFloat(goldData.lowPrice);
                const volume = parseFloat(goldData.volume);
                const changePercent = parseFloat(goldData.priceChangePercent);
                const changeAmount = parseFloat(goldData.priceChange);
                const ticker = this.tickers.get('XAUUSD') || {
                    symbol: 'XAUUSD',
                    price: livePrice,
                    open,
                    high,
                    low,
                    close: livePrice,
                    volume: Math.round(volume),
                    prevClose: open,
                    changePercent,
                    changeAmount,
                    tickSize: 0.01,
                    volatility: 1.2,
                    lastUpdated: Date.now(),
                };
                ticker.price = livePrice;
                ticker.close = livePrice;
                ticker.high = Math.max(ticker.high, high);
                ticker.low = Math.min(ticker.low, low);
                ticker.volume = Math.round(volume);
                ticker.changePercent = changePercent;
                ticker.changeAmount = changeAmount;
                ticker.lastUpdated = Date.now();
                this.tickers.set('XAUUSD', ticker);
                await this.broadcastTick(ticker);
            }
        }
        catch (err) {
            this.logger.debug(`Binance / Gold real tick notice: ${err.message}`);
        }
    }
    async fetchRealNSEQuotes() {
        const symbolMap = {
            NIFTY: '^NSEI',
            BANKNIFTY: '^NSEBANK',
            RELIANCE: 'RELIANCE.NS',
            HDFCBANK: 'HDFCBANK.NS',
            INFY: 'INFY.NS',
        };
        for (const [sym, yahooSym] of Object.entries(symbolMap)) {
            try {
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`;
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = await res.json();
                const meta = data?.chart?.result?.[0]?.meta;
                if (meta && meta.regularMarketPrice) {
                    const livePrice = Number(meta.regularMarketPrice.toFixed(2));
                    const prevClose = Number((meta.chartPreviousClose || meta.previousClose || livePrice).toFixed(2));
                    const high = Number((meta.regularMarketDayHigh || livePrice).toFixed(2));
                    const low = Number((meta.regularMarketDayLow || livePrice).toFixed(2));
                    const volume = meta.regularMarketVolume || 100000;
                    const changeAmount = Number((livePrice - prevClose).toFixed(2));
                    const changePercent = Number(((changeAmount / prevClose) * 100).toFixed(2));
                    const ticker = this.tickers.get(sym);
                    if (ticker) {
                        ticker.price = livePrice;
                        ticker.close = livePrice;
                        ticker.open = Number((meta.regularMarketOpen || ticker.open).toFixed(2));
                        ticker.high = Math.max(ticker.high, high);
                        ticker.low = Math.min(ticker.low, low);
                        ticker.volume = volume;
                        ticker.prevClose = prevClose;
                        ticker.changeAmount = changeAmount;
                        ticker.changePercent = changePercent;
                        ticker.lastUpdated = Date.now();
                        await this.broadcastTick(ticker);
                    }
                }
            }
            catch (err) {
                this.logger.debug(`NSE real tick notice for ${sym}: ${err.message}`);
            }
        }
    }
    async broadcastTick(ticker) {
        const redisClient = this.redis.getClient();
        if (!redisClient || redisClient.status !== 'ready')
            return;
        // Cache live tick with timestamp for worker and execution services
        await this.redis.set(`ticker:${ticker.symbol}:live`, JSON.stringify(ticker), 60);
        const payload = {
            symbol: ticker.symbol,
            timeframe: '15m',
            price: ticker.price,
            open: ticker.open,
            high: ticker.high,
            low: ticker.low,
            close: ticker.close,
            volume: ticker.volume,
            changeAmount: ticker.changeAmount,
            changePercent: ticker.changePercent,
            timestamp: new Date().toISOString(),
            isRealMarket: true,
        };
        await redisClient.publish(shared_1.WS_EVENTS.CANDLE_UPDATED, JSON.stringify(payload));
    }
    getTicker(symbol) {
        return this.tickers.get(symbol.toUpperCase());
    }
    /**
     * Retrieves live ticker with strict validation for trade execution:
     * 1. Price > 0
     * 2. Freshness check: age <= maxAgeSeconds (default 5s)
     * 3. Throws MarketDataUnavailableError or StaleMarketDataError on failure.
     */
    getValidatedTicker(symbol, maxAgeSeconds = 5) {
        const sym = symbol.toUpperCase();
        const ticker = this.tickers.get(sym);
        if (!ticker) {
            throw new shared_1.MarketDataUnavailableError(sym, 'No active market data stream available for symbol');
        }
        if (!Number.isFinite(ticker.price) || ticker.price <= 0) {
            throw new shared_1.MarketDataUnavailableError(sym, `Invalid execution price received: ${ticker.price}`, new Date(ticker.lastUpdated));
        }
        const ageSeconds = (Date.now() - ticker.lastUpdated) / 1000;
        if (ageSeconds > maxAgeSeconds) {
            throw new shared_1.StaleMarketDataError(sym, ageSeconds, maxAgeSeconds, new Date(ticker.lastUpdated));
        }
        return ticker;
    }
    getAllTickers() {
        return Array.from(this.tickers.values());
    }
    onModuleDestroy() {
        if (this.binanceTimer)
            clearInterval(this.binanceTimer);
        if (this.nseTimer)
            clearInterval(this.nseTimer);
        if (this.microTickTimer)
            clearInterval(this.microTickTimer);
    }
};
exports.RealMarketStreamerService = RealMarketStreamerService;
exports.RealMarketStreamerService = RealMarketStreamerService = RealMarketStreamerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], RealMarketStreamerService);
//# sourceMappingURL=real-market-streamer.service.js.map