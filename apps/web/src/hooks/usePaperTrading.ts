'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

export interface AuthoritativePosition {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  realizedPnL?: number;
  status: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'CANCELLED';
  openedAt: string;
  closedAt?: string;
  sourceBotId?: string;
  executionId?: string;
}

export interface AuthoritativePortfolio {
  cashBalance: number;
  usedMargin: number;
  totalEquity: number;
  openPositions: AuthoritativePosition[];
  dailyPnL?: number;
  winRate?: number;
}

export interface AlgoExecutionRecord {
  id: string;
  botId: string;
  symbol: string;
  timeframe: string;
  direction: string;
  state: 'RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';
  failureReasonCode?: string;
  failureReason?: string;
  orderPositionId?: string;
  reservationFingerprint?: string;
  reservationId?: string;
  reservedAt?: string;
  reservationState?: 'RESERVED' | 'RELEASED' | 'FAILED';
  fillPrice?: number;
  fillTime?: string;
  eligibilityState?: 'ELIGIBLE' | 'BLOCKED' | 'FAILED' | 'PENDING';
  eligibilityReasonCode?: string;
  eligibilityReason?: string;
  signalTimestamp: string;
  createdAt: string;
  updatedAt: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function isSameSymbol(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const normA = a.toUpperCase().replace(/_SPOT$/, '');
  const normB = b.toUpperCase().replace(/_SPOT$/, '');
  if (normA === normB) return true;
  if ((normA === 'GOLD' || normA === 'XAUUSD') && (normB === 'GOLD' || normB === 'XAUUSD')) return true;
  return false;
}

export function usePaperTrading(selectedSymbol: string) {
  const [portfolio, setPortfolio] = useState<AuthoritativePortfolio | null>(null);
  const [executions, setExecutions] = useState<AlgoExecutionRecord[]>([]);
  const [isPlacingOrder, setIsPlacingOrder] = useState<boolean>(false);

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/paper-trading/portfolio`);
      if (res.ok) {
        const data = await res.json();
        setPortfolio({
          cashBalance: data.cashBalance ?? 100000,
          usedMargin: data.usedMargin ?? 0,
          totalEquity: data.totalEquity ?? data.cashBalance ?? 100000,
          openPositions: Array.isArray(data.openPositions) ? data.openPositions : [],
          dailyPnL: data.dailyPnL ?? 0,
          winRate: data.winRate ?? 0,
        });
      }
    } catch (e) {
      console.error('Failed to fetch paper trading portfolio:', e);
    }
  }, []);

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/algo-bots/executions?limit=20`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setExecutions(data);
        }
      }
    } catch {
      // Endpoint may not be queryable in all configurations; fallback gracefully
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
    fetchExecutions();
    const interval = setInterval(() => {
      fetchPortfolio();
      fetchExecutions();
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchPortfolio, fetchExecutions]);

  const activePositionForSymbol = useMemo(() => {
    if (!portfolio || !portfolio.openPositions) return null;
    return (
      portfolio.openPositions.find(
        (p) =>
          isSameSymbol(p.symbol, selectedSymbol) &&
          (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'),
      ) || null
    );
  }, [portfolio, selectedSymbol]);

  const activeExecutionForSymbol = useMemo(() => {
    if (!executions || executions.length === 0) return null;
    return executions.find((e) => isSameSymbol(e.symbol, selectedSymbol)) || null;
  }, [executions, selectedSymbol]);

  const closePosition = useCallback(
    async (positionId: string) => {
      setIsPlacingOrder(true);
      try {
        const res = await fetch(
          `${API_BASE}/api/paper-trading/positions/${positionId}/close`,
          {
            method: 'POST',
          },
        );
        if (res.ok) {
          await fetchPortfolio();
        }
      } catch (err) {
        console.error('Failed to close position:', err);
      } finally {
        setIsPlacingOrder(false);
      }
    },
    [fetchPortfolio],
  );

  return {
    portfolio,
    executions,
    activePositionForSymbol,
    activeExecutionForSymbol,
    isPlacingOrder,
    fetchPortfolio,
    closePosition,
  };
}
