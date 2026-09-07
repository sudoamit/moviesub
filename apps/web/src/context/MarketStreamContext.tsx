'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { ISignalSetup, WS_EVENTS } from '@quant/shared';
import { ITickerInfo } from '../components/LiveTickerBar';

interface ToastInfo {
  title: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}

interface MarketStreamContextType {
  isConnected: boolean;
  tickers: Record<string, ITickerInfo>;
  signals: ISignalSetup[];
  isScanning: boolean;
  activeToast: ToastInfo | null;
  subscribeToSymbol: (symbol: string) => void;
  triggerScan: () => Promise<void>;
  dismissToast: () => void;
  showToast: (toast: ToastInfo) => void;
}

const defaultTickers: Record<string, ITickerInfo> = {
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

const MarketStreamContext = createContext<MarketStreamContextType | undefined>(undefined);

export const MarketStreamProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [tickers, setTickers] = useState<Record<string, ITickerInfo>>(defaultTickers);
  const [signals, setSignals] = useState<ISignalSetup[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [activeToast, setActiveToast] = useState<ToastInfo | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  const showToast = useCallback((toast: ToastInfo) => {
    setActiveToast(toast);
    setTimeout(() => {
      setActiveToast((prev) => (prev?.title === toast.title ? null : prev));
    }, 6000);
  }, []);

  const dismissToast = useCallback(() => {
    setActiveToast(null);
  }, []);

  const subscribeToSymbol = useCallback(
    (symbol: string) => {
      if (socket && socket.connected) {
        socket.emit('subscribe:instrument', { symbol });
      }
    },
    [socket],
  );

  const triggerScan = useCallback(async () => {
    setIsScanning(true);
    showToast({
      title: '📡 Institutional Scanner Active',
      message:
        'Scanning multi-timeframe 15m/1h/4h order blocks and liquidity across all markets...',
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
    } catch (err: any) {
      showToast({
        title: 'Scanner Error',
        message: err.message || 'Failed to complete scan',
        type: 'error',
      });
    } finally {
      setIsScanning(false);
    }
  }, [showToast]);

  useEffect(() => {
    const s: Socket = io('http://localhost:3001', {
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

    s.on(WS_EVENTS.CANDLE_UPDATED, (data) => {
      if (!data?.symbol) return;
      const sym = data.symbol;
      const newPrice = Number(data.price || data.close);

      setTickers((prev) => {
        if (!prev[sym] || prev[sym].price === newPrice) return prev;
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

    s.on(WS_EVENTS.ALERT_TRIGGERED, (data) => {
      showToast({
        title: `🚨 ${data.symbol || 'MARKET'} CONFLUENCE ALERT`,
        message:
          data.summary ||
          `Institutional ${data.direction} momentum triggered with score ${data.score}/100.`,
        type: 'warning',
      });
    });

    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [showToast]);

  return (
    <MarketStreamContext.Provider
      value={{
        isConnected,
        tickers,
        signals,
        isScanning,
        activeToast,
        subscribeToSymbol,
        triggerScan,
        dismissToast,
        showToast,
      }}
    >
      {children}
    </MarketStreamContext.Provider>
  );
};

export const useMarketStream = (): MarketStreamContextType => {
  const context = useContext(MarketStreamContext);
  if (!context) {
    throw new Error('useMarketStream must be used within a MarketStreamProvider');
  }
  return context;
};
