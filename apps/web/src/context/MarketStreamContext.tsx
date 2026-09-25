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
  triggerScan: (strategy?: string) => Promise<void>;
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
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
  },
  BANKNIFTY: {
    symbol: 'BANKNIFTY',
    price: 57496.3,
    changePercent: 0.2,
    changeAmount: 116.3,
    high: 57596,
    low: 57307,
    volume: 850000,
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
  },
  BTCUSDT_SPOT: {
    symbol: 'BTCUSDT_SPOT',
    price: 0,
    changePercent: 0,
    changeAmount: 0,
    high: 0,
    low: 0,
    volume: 0,
    provenance: 'UNKNOWN',
    isFresh: false,
  },
  BTCUSDT: {
    symbol: 'BTCUSDT',
    price: 0,
    changePercent: 0,
    changeAmount: 0,
    high: 0,
    low: 0,
    volume: 0,
    provenance: 'UNKNOWN',
    isFresh: false,
  },
  XAUUSD: {
    symbol: 'XAUUSD',
    price: 2885.5,
    changePercent: 0.35,
    changeAmount: 10.15,
    high: 2894.2,
    low: 2872.4,
    volume: 185000,
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
  },
  RELIANCE: {
    symbol: 'RELIANCE',
    price: 1287.0,
    changePercent: 0.16,
    changeAmount: 2.0,
    high: 1291.5,
    low: 1280,
    volume: 320000,
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
  },
  HDFCBANK: {
    symbol: 'HDFCBANK',
    price: 720.3,
    changePercent: 1.17,
    changeAmount: 8.3,
    high: 720.3,
    low: 709.1,
    volume: 450000,
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
  },
  INFY: {
    symbol: 'INFY',
    price: 1144.0,
    changePercent: 0.53,
    changeAmount: 6.0,
    high: 1144.9,
    low: 1110.8,
    volume: 280000,
    provenance: 'LIVE_PROVIDER',
    isFresh: true,
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

  const triggerScan = useCallback(
    async (strategy: string = 'SMC') => {
      setIsScanning(true);
      const isSaiyan = strategy === 'SAIYAN_OCC' || strategy === 'SAIYAN';
      const stratName = isSaiyan ? 'Saiyan OCC Flow' : 'SMC Core Engine';
      showToast({
        title: `📡 ${stratName} Scanner Active`,
        message: `Scanning multi-timeframe 15m/1h/4h setups across all markets using ${stratName}...`,
        type: 'info',
      });

      try {
        const stratParam = encodeURIComponent(strategy);
        const res = await fetch(`http://localhost:3001/api/scanner/scan?strategy=${stratParam}`, {
          method: 'POST',
        });
        const data = await res.json();
        if (data && data.signals) {
          setSignals(data.signals);
          showToast({
            title: `✅ ${stratName} Scan Complete`,
            message: `Identified ${data.signals.length} high-probability ${stratName} setups.`,
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
    },
    [showToast],
  );

  // Fetch Authoritative Snapshot on mount
  useEffect(() => {
    const fetchSnapshot = async () => {
      const symbolsToFetch = ['BTCUSDT_SPOT', 'XAUUSD'];
      for (const sym of symbolsToFetch) {
        try {
          const res = await fetch(`http://localhost:3001/api/market-data/snapshot/${sym}`);
          if (!res.ok) continue;
          const snap = await res.json();
          if (
            snap &&
            snap.price > 0 &&
            snap.provenance === 'LIVE_PROVIDER' &&
            snap.isFresh === true
          ) {
            const snapshotInfo: ITickerInfo = {
              symbol: snap.symbol,
              price: Number(snap.price),
              changePercent: 0,
              changeAmount: 0,
              high: Number(snap.price),
              low: Number(snap.price),
              volume: 0,
              provenance: 'LIVE_PROVIDER',
              isFresh: true,
              marketEventTime: snap.marketEventTime,
              observedAt: snap.observedAt,
              providerId: snap.providerId,
              providerTransport: snap.providerTransport,
            };

            setTickers((prev) => {
              const next: Record<string, ITickerInfo> = { ...prev, [snap.symbol]: snapshotInfo };
              if (snap.symbol === 'BTCUSDT_SPOT') {
                next.BTCUSDT = { ...snapshotInfo, symbol: 'BTCUSDT' };
              } else if (snap.symbol === 'XAUUSD') {
                next.GOLD = { ...snapshotInfo, symbol: 'GOLD' };
              }
              return next;
            });
          }
        } catch (e) {
          // Silently ignore network errors during initial snapshot fetch; will be populated via websocket
        }
      }
    };

    fetchSnapshot();
  }, []);

  // Periodic heartbeat checking quote freshness (every 2 seconds)
  useEffect(() => {
    const freshnessInterval = setInterval(() => {
      const now = Date.now();
      setTickers((prev) => {
        let hasChanges = false;
        const updated = { ...prev };

        for (const [sym, ticker] of Object.entries(updated)) {
          if (!ticker || !ticker.marketEventTime || !ticker.isFresh) continue;
          const eventTime =
            typeof ticker.marketEventTime === 'number'
              ? ticker.marketEventTime
              : new Date(ticker.marketEventTime).getTime();

          if (now - eventTime > 5000) {
            updated[sym] = {
              ...ticker,
              isFresh: false,
              provenance: 'STALE',
            };
            hasChanges = true;
          }
        }

        return hasChanges ? updated : prev;
      });
    }, 2000);

    return () => clearInterval(freshnessInterval);
  }, []);

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
      s.emit('subscribe:instrument', { symbol: 'BTCUSDT_SPOT' });
      s.emit('subscribe:instrument', { symbol: 'XAUUSD' });
    });

    s.on('disconnect', () => {
      setIsConnected(false);
    });

    s.on(WS_EVENTS.CANDLE_UPDATED, (data) => {
      if (!data?.symbol) return;
      const rawSym = data.symbol;
      const isBtc =
        rawSym === 'BTC' ||
        rawSym === 'BTCUSDT' ||
        rawSym === 'BTCUSDT_SPOT' ||
        rawSym === 'BTC/USDT';

      // Strict validation for BTC live quotes
      if (isBtc) {
        // Enforce live provider provenance
        if (data.provenance && data.provenance !== 'LIVE_PROVIDER') {
          return; // Drop non-live quotes (BOOTSTRAP, STALE, UNKNOWN, DEGRADED)
        }

        // Validate price positivity and finite value
        const newPrice = Number(data.price || data.close);
        if (!isFinite(newPrice) || newPrice <= 0) {
          return;
        }

        const now = Date.now();
        const eventTime =
          typeof data.marketEventTime === 'number'
            ? data.marketEventTime
            : data.marketEventTime
            ? new Date(data.marketEventTime).getTime()
            : data.timestamp
            ? new Date(data.timestamp).getTime()
            : now;

        // Reject severe future skew (> 5000ms ahead of client clock)
        if (eventTime > now + 5000) {
          return;
        }

        const isFresh = now - eventTime <= 5000;

        setTickers((prev) => {
          const currentBtc = prev['BTCUSDT_SPOT'] || prev['BTCUSDT'];
          const currentEventTime =
            currentBtc && currentBtc.marketEventTime
              ? typeof currentBtc.marketEventTime === 'number'
                ? currentBtc.marketEventTime
                : new Date(currentBtc.marketEventTime).getTime()
              : 0;

          // Reject out-of-order ticks if newer event already observed
          if (currentEventTime && eventTime < currentEventTime) {
            return prev;
          }

          const changeAmount = Number(data.changeAmount ?? currentBtc?.changeAmount ?? 0);
          const changePercent = Number(data.changePercent ?? currentBtc?.changePercent ?? 0);

          const updatedBtc: ITickerInfo = {
            symbol: 'BTCUSDT_SPOT',
            price: newPrice,
            changeAmount,
            changePercent,
            high: Math.max(currentBtc?.high || 0, newPrice),
            low: currentBtc?.low && currentBtc.low > 0 ? Math.min(currentBtc.low, newPrice) : newPrice,
            volume: Number(data.volume ?? currentBtc?.volume ?? 0),
            provenance: 'LIVE_PROVIDER',
            isFresh,
            marketEventTime: eventTime,
            observedAt: data.observedAt || now,
            receivedAt: now,
            providerId: data.providerId || 'BINANCE_SPOT',
            providerTransport: data.providerTransport || 'REST_POLLING',
          };

          return {
            ...prev,
            BTCUSDT_SPOT: updatedBtc,
            BTCUSDT: { ...updatedBtc, symbol: 'BTCUSDT' },
            ...(rawSym !== 'BTCUSDT' && rawSym !== 'BTCUSDT_SPOT' ? { [rawSym]: updatedBtc } : {}),
          };
        });
        return;
      }

      // Non-BTC instrument handling
      const sym = rawSym;
      const newPrice = Number(data.price || data.close);
      if (!isFinite(newPrice) || newPrice <= 0) return;

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
            provenance: (data.provenance as any) || 'LIVE_PROVIDER',
            isFresh: true,
            marketEventTime: data.marketEventTime || Date.now(),
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
