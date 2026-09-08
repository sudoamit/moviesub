"use strict";
'use client';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMarketStream = exports.MarketStreamProvider = void 0;
const react_1 = __importStar(require("react"));
const socket_io_client_1 = require("socket.io-client");
const shared_1 = require("@quant/shared");
const defaultTickers = {
    NIFTY: {
        symbol: 'NIFTY',
        price: 24175.65,
        changePercent: -0.13,
        changeAmount: -32.15,
        high: 24220,
        low: 24135,
        volume: 1250000,
    },
    BANKNIFTY: {
        symbol: 'BANKNIFTY',
        price: 57496.3,
        changePercent: 0.2,
        changeAmount: 116.3,
        high: 57596,
        low: 57307,
        volume: 850000,
    },
    BTCUSDT: {
        symbol: 'BTCUSDT',
        price: 79230.0,
        changePercent: 0.6,
        changeAmount: 473.35,
        high: 79840,
        low: 79001,
        volume: 45000,
    },
    XAUUSD: {
        symbol: 'XAUUSD',
        price: 2885.5,
        changePercent: 0.35,
        changeAmount: 10.15,
        high: 2894.2,
        low: 2872.4,
        volume: 185000,
    },
    RELIANCE: {
        symbol: 'RELIANCE',
        price: 1287.0,
        changePercent: 0.16,
        changeAmount: 2.0,
        high: 1291.5,
        low: 1280,
        volume: 320000,
    },
    HDFCBANK: {
        symbol: 'HDFCBANK',
        price: 720.3,
        changePercent: 1.17,
        changeAmount: 8.3,
        high: 720.3,
        low: 709.1,
        volume: 450000,
    },
    INFY: {
        symbol: 'INFY',
        price: 1144.0,
        changePercent: 0.53,
        changeAmount: 6.0,
        high: 1144.9,
        low: 1110.8,
        volume: 280000,
    },
};
const MarketStreamContext = (0, react_1.createContext)(undefined);
const MarketStreamProvider = ({ children }) => {
    const [isConnected, setIsConnected] = (0, react_1.useState)(false);
    const [tickers, setTickers] = (0, react_1.useState)(defaultTickers);
    const [signals, setSignals] = (0, react_1.useState)([]);
    const [isScanning, setIsScanning] = (0, react_1.useState)(false);
    const [activeToast, setActiveToast] = (0, react_1.useState)(null);
    const [socket, setSocket] = (0, react_1.useState)(null);
    const showToast = (0, react_1.useCallback)((toast) => {
        setActiveToast(toast);
        setTimeout(() => {
            setActiveToast((prev) => (prev?.title === toast.title ? null : prev));
        }, 6000);
    }, []);
    const dismissToast = (0, react_1.useCallback)(() => {
        setActiveToast(null);
    }, []);
    const subscribeToSymbol = (0, react_1.useCallback)((symbol) => {
        if (socket && socket.connected) {
            socket.emit('subscribe:instrument', { symbol });
        }
    }, [socket]);
    const triggerScan = (0, react_1.useCallback)(async () => {
        setIsScanning(true);
        showToast({
            title: '📡 Institutional Scanner Active',
            message: 'Scanning multi-timeframe 15m/1h/4h order blocks and liquidity across all markets...',
            type: 'info',
        });
        try {
            const res = await fetch('http://localhost:3001/api/scanner/scan', { method: 'POST' });
            const data = await res.json();
            if (data && data.signals) {
                setSignals(data.signals);
                showToast({
                    title: '✅ SMC Scan Complete',
                    message: `Identified ${data.signals.length} high-probability institutional trading setups.`,
                    type: 'success',
                });
            }
        }
        catch (err) {
            showToast({
                title: 'Scanner Error',
                message: err.message || 'Failed to complete scan',
                type: 'error',
            });
        }
        finally {
            setIsScanning(false);
        }
    }, [showToast]);
    (0, react_1.useEffect)(() => {
        const s = (0, socket_io_client_1.io)('http://localhost:3001', {
            transports: ['websocket'],
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
        });
        s.on('connect', () => {
            setIsConnected(true);
            s.emit('subscribe:instrument', { symbol: 'NIFTY' });
            s.emit('subscribe:instrument', { symbol: 'BANKNIFTY' });
            s.emit('subscribe:instrument', { symbol: 'BTCUSDT' });
            s.emit('subscribe:instrument', { symbol: 'XAUUSD' });
        });
        s.on('disconnect', () => {
            setIsConnected(false);
        });
        s.on(shared_1.WS_EVENTS.CANDLE_UPDATED, (data) => {
            if (!data?.symbol)
                return;
            const sym = data.symbol;
            const newPrice = Number(data.price || data.close);
            setTickers((prev) => {
                if (!prev[sym] || prev[sym].price === newPrice)
                    return prev;
                const current = prev[sym];
                const changeAmount = Number(data.changeAmount ?? current.changeAmount);
                const changePercent = Number(data.changePercent ?? current.changePercent);
                return {
                    ...prev,
                    [sym]: {
                        ...current,
                        price: newPrice,
                        changeAmount,
                        changePercent,
                        high: Math.max(current.high, newPrice),
                        low: Math.min(current.low, newPrice),
                    },
                };
            });
        });
        s.on(shared_1.WS_EVENTS.ALERT_TRIGGERED, (data) => {
            showToast({
                title: `🚨 ${data.symbol || 'MARKET'} CONFLUENCE ALERT`,
                message: data.summary ||
                    `Institutional ${data.direction} momentum triggered with score ${data.score}/100.`,
                type: 'warning',
            });
        });
        setSocket(s);
        return () => {
            s.disconnect();
        };
    }, [showToast]);
    return (<MarketStreamContext.Provider value={{
            isConnected,
            tickers,
            signals,
            isScanning,
            activeToast,
            subscribeToSymbol,
            triggerScan,
            dismissToast,
            showToast,
        }}>
      {children}
    </MarketStreamContext.Provider>);
};
exports.MarketStreamProvider = MarketStreamProvider;
const useMarketStream = () => {
    const context = (0, react_1.useContext)(MarketStreamContext);
    if (!context) {
        throw new Error('useMarketStream must be used within a MarketStreamProvider');
    }
    return context;
};
exports.useMarketStream = useMarketStream;
//# sourceMappingURL=MarketStreamContext.js.map