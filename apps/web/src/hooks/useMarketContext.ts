'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChartMarketSnapshot, CanonicalCandleAggregator } from '@quant/shared';
import { ChartSnapshotValidator } from '@quant/trading-engine';
import { useMarketStream } from '../context/MarketStreamContext';

export interface MarketDataState {
  status: 'CONNECTED' | 'RECONNECTING' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE';
  providerId: string;
  dataProvenance: string;
  marketAsOf?: string;
  observedAt?: string;
  latencyMs?: number;
  isStale: boolean;
}

export function useMarketContext(initialSymbol = 'NIFTY', initialTimeframe = '15m') {
  const { isConnected, tickers, subscribeToSymbol } = useMarketStream();

  const [selectedSymbol, setSelectedSymbol] = useState<string>(initialSymbol);
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>(initialTimeframe);
  const [chartSnapshot, setChartSnapshot] = useState<ChartMarketSnapshot | null>(null);
  const [isDataUnavailable, setIsDataUnavailable] = useState<boolean>(false);
  const [isLoadingCandles, setIsLoadingCandles] = useState<boolean>(false);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const aggregatorRef = useRef(new CanonicalCandleAggregator());

  // Normalize symbol naming
  const normalizeSymbol = useCallback((rawSym: string): string => {
    const s = (rawSym || '').toUpperCase();
    if (s === 'BTC' || s === 'BTC/USDT' || s === 'BITCOIN' || s === 'BTCUSDT' || s === 'BTCUSDT_SPOT') {
      return 'BTCUSDT_SPOT';
    }
    if (s === 'GOLD' || s === 'XAU' || s === 'XAU/USD' || s === 'SPOTGOLD') return 'XAUUSD';
    return s;
  }, []);

  const handleSelectSymbol = useCallback(
    (rawSym: string) => {
      const sym = normalizeSymbol(rawSym);
      setSelectedSymbol(sym);
      if (typeof window !== 'undefined') {
        localStorage.setItem('quant_selected_symbol', sym);
      }
    },
    [normalizeSymbol],
  );

  const handleSelectTimeframe = useCallback((tf: string) => {
    setSelectedTimeframe(tf);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_selected_timeframe', tf);
    }
  }, []);

  // Fetch Candles & Chart Snapshot
  const fetchCandles = useCallback(async (sym: string, tf: string) => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setIsLoadingCandles(true);
    setIsDataUnavailable(false);

    try {
      const res = await fetch(
        `http://localhost:3001/api/candles/chart-data?symbol=${sym}&timeframe=${tf}&limit=200`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && (Array.isArray(data.closedCandles) || Array.isArray(data.candles))) {
        const closed = Array.isArray(data.closedCandles)
          ? data.closedCandles
          : data.candles.map((c: any) => ({
              timestamp: new Date(c.time ? c.time * 1000 : c.timestamp),
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume ?? 0,
              isClosed: true as const,
              provenance: data.dataProvenance || 'LIVE',
            }));

        const snapshotObj: ChartMarketSnapshot = {
          symbol: data.symbol || sym,
          timeframe: data.timeframe || tf,
          closedCandles: closed,
          formingCandle: data.formingCandle || null,
          livePrice: data.livePrice ?? (closed.length > 0 ? closed[closed.length - 1].close : null),
          closedThrough:
            data.closedThrough ||
            (closed.length > 0 ? closed[closed.length - 1].timestamp : undefined),
          asOfTimestamp: data.asOfTimestamp || new Date().toISOString(),
          marketAsOf: data.marketAsOf,
          observedAt: data.observedAt || data.asOfTimestamp || new Date().toISOString(),
          sessionKey: data.sessionKey,
          sessionVolumeWatermark: data.sessionVolumeWatermark,
          streamState: data.streamState,
          dataProvenance: data.dataProvenance || 'LIVE',
          sourceIdentity: data.sourceIdentity || 'UNKNOWN_SOURCE',
          isDegraded: data.isDegraded ?? data.marketAsOf === undefined,
          smcSnapshot: data.smcSnapshot || null,
        };

        const validation = ChartSnapshotValidator.validateSnapshot(snapshotObj);
        if (!validation.isValid) {
          console.warn(`Chart snapshot validation rejected: ${validation.error}`);
          setChartSnapshot(null);
          setIsDataUnavailable(true);
          return;
        }

        aggregatorRef.current.syncFromSnapshot(snapshotObj);
        setChartSnapshot(snapshotObj);
      } else {
        setChartSnapshot(null);
        setIsDataUnavailable(true);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error('Failed to fetch chart data:', e);
      setChartSnapshot(null);
      setIsDataUnavailable(true);
    } finally {
      setIsLoadingCandles(false);
    }
  }, []);

  // Initialize from LocalStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedSymbol = localStorage.getItem('quant_selected_symbol');
      if (savedSymbol) setSelectedSymbol(normalizeSymbol(savedSymbol));
      const savedTf = localStorage.getItem('quant_selected_timeframe');
      if (savedTf) setSelectedTimeframe(savedTf);
    }
  }, [normalizeSymbol]);

  useEffect(() => {
    fetchCandles(selectedSymbol, selectedTimeframe);
    subscribeToSymbol(selectedSymbol);
    aggregatorRef.current.reset();
  }, [selectedSymbol, selectedTimeframe, fetchCandles, subscribeToSymbol]);

  // Process Live Ticks through CanonicalCandleAggregator
  useEffect(() => {
    const rawTick = tickers[selectedSymbol];
    if (rawTick && chartSnapshot && chartSnapshot.symbol === selectedSymbol) {
      setChartSnapshot((prev) => {
        if (!prev || prev.symbol !== selectedSymbol) return prev;
        return aggregatorRef.current.processTick(prev, rawTick);
      });
    }
  }, [tickers, selectedSymbol]);

  const currentTicker = useMemo(() => {
    const fromMap = tickers[selectedSymbol];
    if (fromMap) return fromMap;
    const closed = chartSnapshot?.closedCandles || [];
    return {
      symbol: selectedSymbol,
      price: chartSnapshot?.livePrice ?? (closed.length > 0 ? closed[closed.length - 1].close : 0),
      changePercent: 0,
      changeAmount: 0,
      high: 0,
      low: 0,
      volume: 0,
      isRealTime: isConnected,
    };
  }, [tickers, selectedSymbol, chartSnapshot, isConnected]);

  // Compute Authoritative Market Data State
  const marketDataState: MarketDataState = useMemo(() => {
    if (isDataUnavailable) {
      return {
        status: 'UNAVAILABLE',
        providerId: chartSnapshot?.sourceIdentity || 'FALLBACK_FEED',
        dataProvenance: 'UNAVAILABLE',
        isStale: true,
      };
    }
    if (!isConnected) {
      return {
        status: 'RECONNECTING',
        providerId: chartSnapshot?.sourceIdentity || 'FEED_SOCKET',
        dataProvenance: chartSnapshot?.dataProvenance || 'STREAM_RECONNECTING',
        isStale: true,
      };
    }
    if (chartSnapshot?.isDegraded) {
      return {
        status: 'DEGRADED',
        providerId: chartSnapshot.sourceIdentity || 'FEED',
        dataProvenance: chartSnapshot.dataProvenance || 'DEGRADED',
        marketAsOf: chartSnapshot.marketAsOf ? String(chartSnapshot.marketAsOf) : undefined,
        observedAt: chartSnapshot.observedAt ? String(chartSnapshot.observedAt) : undefined,
        isStale: false,
      };
    }

    return {
      status: 'CONNECTED',
      providerId:
        chartSnapshot?.sourceIdentity || (selectedSymbol.includes('BTC') ? 'BINANCE' : 'NSE_INDEX'),
      dataProvenance: chartSnapshot?.dataProvenance || 'LIVE',
      marketAsOf: chartSnapshot?.marketAsOf ? String(chartSnapshot.marketAsOf) : undefined,
      observedAt: chartSnapshot?.observedAt ? String(chartSnapshot.observedAt) : undefined,
      isStale: false,
    };
  }, [isDataUnavailable, isConnected, chartSnapshot, selectedSymbol]);

  return {
    selectedSymbol,
    selectedTimeframe,
    chartSnapshot,
    isDataUnavailable,
    isLoadingCandles,
    currentTicker,
    marketDataState,
    setSelectedSymbol: handleSelectSymbol,
    setSelectedTimeframe: handleSelectTimeframe,
    refetchCandles: () => fetchCandles(selectedSymbol, selectedTimeframe),
  };
}
