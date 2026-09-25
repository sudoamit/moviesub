'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ISignalSetup } from '@quant/shared';
import { StrategyMode } from '../components/Header';
import { useMarketStream } from '../context/MarketStreamContext';

function matchSignalSymbol(signalSym?: string, targetSym?: string): boolean {
  if (!signalSym || !targetSym) return false;
  if (signalSym === targetSym) return true;
  const normSig = signalSym.toUpperCase().replace(/_SPOT$/, '');
  const normTgt = targetSym.toUpperCase().replace(/_SPOT$/, '');
  if (normSig === normTgt) return true;
  if ((normSig === 'GOLD' || normSig === 'XAUUSD') && (normTgt === 'GOLD' || normTgt === 'XAUUSD')) return true;
  if ((normSig === 'BTC' || normSig.includes('BTC')) && (normTgt === 'BTC' || normTgt.includes('BTC'))) return true;
  return false;
}

export function useSignals(
  selectedSymbol: string,
  selectedTimeframe: string,
  selectedStrategy: StrategyMode = 'SMC',
) {
  const { isScanning, triggerScan: contextTriggerScan } = useMarketStream();

  const [signals, setSignals] = useState<ISignalSetup[]>([]);
  const [selectedSignal, setSelectedSignal] = useState<ISignalSetup | null>(null);
  const [isLoadingSignals, setIsLoadingSignals] = useState<boolean>(false);
  const latestRequestIdRef = useRef<number>(0);

  const fetchSignals = useCallback(
    async (tf: string = selectedTimeframe, strat: StrategyMode = selectedStrategy) => {
      const requestId = ++latestRequestIdRef.current;
      setIsLoadingSignals(true);
      try {
        const apiBase = typeof window !== 'undefined' ? '' : 'http://localhost:3001';
        const res = await fetch(
          `${apiBase}/api/signals?timeframe=${tf}&strategy=${strat}`,
        );
        if (requestId !== latestRequestIdRef.current) {
          // Outdated in-flight response discarded to prevent race condition
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setSignals(data);
            const current = data.find((s) => matchSignalSymbol(s.symbol, selectedSymbol));
            setSelectedSignal(current || null);
          }
        }
      } catch (e) {
        console.error('Failed to fetch signals:', e);
      } finally {
        if (requestId === latestRequestIdRef.current) {
          setIsLoadingSignals(false);
        }
      }
    },
    [selectedSymbol, selectedTimeframe, selectedStrategy],
  );

  useEffect(() => {
    fetchSignals(selectedTimeframe, selectedStrategy);
  }, [fetchSignals, selectedTimeframe, selectedStrategy]);

  // Keep selectedSignal in sync when symbol changes
  useEffect(() => {
    const current = signals.find((s) => matchSignalSymbol(s.symbol, selectedSymbol));
    setSelectedSignal(current || null);
  }, [selectedSymbol, signals]);

  const handleTriggerScan = useCallback(async () => {
    await contextTriggerScan(selectedStrategy);
    await fetchSignals(selectedTimeframe, selectedStrategy);
  }, [contextTriggerScan, fetchSignals, selectedTimeframe, selectedStrategy]);

  return {
    signals,
    selectedSignal,
    isLoadingSignals,
    isScanning,
    fetchSignals,
    triggerScan: handleTriggerScan,
    setSelectedSignal,
  };
}
