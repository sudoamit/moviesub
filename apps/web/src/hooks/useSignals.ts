'use client';

import { useState, useEffect, useCallback } from 'react';
import { ISignalSetup } from '@quant/shared';
import { StrategyMode } from '../components/Header';
import { useMarketStream } from '../context/MarketStreamContext';

export function useSignals(
  selectedSymbol: string,
  selectedTimeframe: string,
  selectedStrategy: StrategyMode = 'SMC',
) {
  const { isScanning, triggerScan: contextTriggerScan } = useMarketStream();

  const [signals, setSignals] = useState<ISignalSetup[]>([]);
  const [selectedSignal, setSelectedSignal] = useState<ISignalSetup | null>(null);
  const [isLoadingSignals, setIsLoadingSignals] = useState<boolean>(false);

  const fetchSignals = useCallback(
    async (tf: string = selectedTimeframe, strat: StrategyMode = selectedStrategy) => {
      setIsLoadingSignals(true);
      try {
        const res = await fetch(
          `http://localhost:3001/api/signals?timeframe=${tf}&strategy=${strat}`,
        );
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setSignals(data);
            const current = data.find((s) => s.symbol === selectedSymbol);
            setSelectedSignal(current || null);
          }
        }
      } catch (e) {
        console.error('Failed to fetch signals:', e);
      } finally {
        setIsLoadingSignals(false);
      }
    },
    [selectedSymbol, selectedTimeframe, selectedStrategy],
  );

  useEffect(() => {
    fetchSignals(selectedTimeframe, selectedStrategy);
  }, [fetchSignals, selectedTimeframe, selectedStrategy]);

  // Keep selectedSignal in sync when symbol changes
  useEffect(() => {
    const current = signals.find((s) => s.symbol === selectedSymbol);
    setSelectedSignal(current || null);
  }, [selectedSymbol, signals]);

  const handleTriggerScan = useCallback(async () => {
    await contextTriggerScan();
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
