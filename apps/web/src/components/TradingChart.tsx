'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  LineData,
  CrosshairMode,
  ColorType,
  LineStyle,
  Time,
  CandlestickSeries,
  BarSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
} from 'lightweight-charts';
import {
  Maximize2,
  Minimize2,
  TrendingUp,
  TrendingDown,
  Layers,
  Settings,
  Pencil,
  Trash2,
  Sliders,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Shield,
  Target,
  ArrowUpRight,
  ArrowDownRight,
  Droplets,
  Zap,
  Radar,
  Clock,
} from 'lucide-react';
import {
  SMCAnalyzer,
  VolumeProfileAnalyzer,
  SessionFilter,
  LiquidityHeatmapEngine,
  MTFFlowRadarEngine,
} from '@quant/trading-engine';

interface TradingChartProps {
  symbol: string;
  timeframe: string;
  candles: any[];
  signal?: any;
  livePrice?: number;
  liveChangePercent?: number;
  isTradeActive?: boolean;
  onTimeframeChange?: (tf: string) => void;
  onSymbolChange?: (symbol: string) => void;
}

export const TradingChart: React.FC<TradingChartProps> = ({
  symbol,
  timeframe,
  candles,
  signal,
  livePrice,
  liveChangePercent = 0,
  isTradeActive = true,
  onTimeframeChange,
  onSymbolChange,
}) => {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);

  // Indicator Series Refs
  const ema20SeriesRef = useRef<ISeriesApi<any> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<any> | null>(null);
  const ema200SeriesRef = useRef<ISeriesApi<any> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const sma20SeriesRef = useRef<ISeriesApi<any> | null>(null);
  const priceLinesRef = useRef<any[]>([]);

  // Chart UI States
  const [chartType, setChartType] = useState<'Candles' | 'Bar' | 'Line' | 'Area'>('Candles');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Indicators Active Toggles
  const [showEMA20, setShowEMA20] = useState<boolean>(true);
  const [showEMA50, setShowEMA50] = useState<boolean>(true);
  const [showEMA200, setShowEMA200] = useState<boolean>(false);
  const [showVWAP, setShowVWAP] = useState<boolean>(true);
  const [showSMA20, setShowSMA20] = useState<boolean>(false);
  const [showVolume, setShowVolume] = useState<boolean>(true);
  const [showVolumeProfile, setShowVolumeProfile] = useState<boolean>(true);
  const [showKillZones, setShowKillZones] = useState<boolean>(true);
  const [showLiquidityHeatmap, setShowLiquidityHeatmap] = useState<boolean>(false);
  const [showIndicatorsModal, setShowIndicatorsModal] = useState<boolean>(false);

  // SMC Overlays Active Toggles
  const [showOB, setShowOB] = useState<boolean>(true);
  const [showFVG, setShowFVG] = useState<boolean>(true);
  const [showBOS, setShowBOS] = useState<boolean>(true);
  const [showCHoCH, setShowCHoCH] = useState<boolean>(true);
  const [showLiq, setShowLiq] = useState<boolean>(true);
  const [showLevels, setShowLevels] = useState<boolean>(true);
  const [showRange, setShowRange] = useState<boolean>(true);
  const [showSMCDash, setShowSMCDash] = useState<boolean>(true);
  const [showSMCModal, setShowSMCModal] = useState<boolean>(false);

  // Drawing Tools State
  const [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<any[]>([]);

  // OHLC Crosshair Display
  const [ohlcData, setOhlcData] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);

  // Live Paper Trading Position Sync
  const [paperPosition, setPaperPosition] = useState<any | null>(null);
  const [isLocallyCut, setIsLocallyCut] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      if (signal?.id) return localStorage.getItem(`quant_pos_cut_${signal.id}`) === 'true';
      return localStorage.getItem(`quant_pos_cut_${symbol}`) === 'true';
    }
    return false;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const updateCutState = () => {
        const isCut = signal?.id
          ? localStorage.getItem(`quant_pos_cut_${signal.id}`) === 'true'
          : localStorage.getItem(`quant_pos_cut_${symbol}`) === 'true';
        setIsLocallyCut(isCut);
      };
      updateCutState();

      const handleTradeClosed = () => {
        setIsLocallyCut(true);
      };
      window.addEventListener('quant_trade_closed', handleTradeClosed);
      return () => window.removeEventListener('quant_trade_closed', handleTradeClosed);
    }
  }, [signal?.id, symbol]);

  // Live AI ML Probability & Expectancy Telemetry
  const [aiPredictionInfo, setAiPredictionInfo] = useState<{
    winProbability: number;
    expectedValueR: number;
    recommendation: string;
    deterministicScore: number;
  } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetchAIPrediction = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/ai-learning/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, timeframe }),
        });
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data && data.aiPrediction) {
            setAiPredictionInfo({
              winProbability: data.aiPrediction.winProbability,
              expectedValueR: data.aiPrediction.expectedValueR,
              recommendation: data.aiPrediction.recommendation,
              deterministicScore: data.deterministicScore,
            });
          }
        }
      } catch (e) {}
    };
    fetchAIPrediction();
    const interval = setInterval(fetchAIPrediction, 6000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    let isMounted = true;
    const fetchActivePos = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/paper-trading/portfolio');
        const data = await res.json();
        if (isMounted && data && Array.isArray(data.openPositions)) {
          const found = data.openPositions.find((p: any) => p.symbol === symbol);
          setPaperPosition(found || null);
          if (!found) {
            setIsLocallyCut(false);
          }
        }
      } catch (e) {}
    };
    fetchActivePos();
    const interval = setInterval(fetchActivePos, 1500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [symbol]);

  const currentPrice = livePrice || (candles.length > 0 ? candles[candles.length - 1].close : 0);
  const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

  // 1. Instant Client-Side Pure SMC Pro Computation (0 network lag)
  const clientSMC = useMemo(() => {
    if (!candles || candles.length < 5) return null;
    try {
      const cleanCandles = candles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.time ? c.time * 1000 : c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 1),
        isClosed: true,
      }));
      return SMCAnalyzer.analyze(cleanCandles);
    } catch (e) {
      console.error('Client SMC calculation error:', e);
      return null;
    }
  }, [candles]);

  // 2. Client-Side Volume Profile & Cumulative Volume Delta Computation
  const clientVP = useMemo(() => {
    if (!candles || candles.length < 5) return null;
    try {
      const cleanCandles = candles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp.toISOString() : typeof c.timestamp === 'string' ? c.timestamp : new Date((c.time || 0) * 1000).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 1),
        isClosed: true,
      }));
      return VolumeProfileAnalyzer.compute(cleanCandles as any, 28, 0.70);
    } catch (e) {
      console.error('Volume profile computation error:', e);
      return null;
    }
  }, [candles]);

  // 3. ICT Session & Kill Zone Info
  const clientSession = useMemo(() => {
    return SessionFilter.getSessionInfo(new Date(), symbol);
  }, [symbol]);

  // 4. Institutional Stop-Loss Liquidity Heatmap
  const clientHeatmap = useMemo(() => {
    if (!candles || candles.length < 10) return null;
    try {
      const cleanCandles = candles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.time ? c.time * 1000 : c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 1),
        isClosed: true,
      }));
      return LiquidityHeatmapEngine.compute(cleanCandles as any);
    } catch (e) {
      return null;
    }
  }, [candles]);

  // 5. Multi-Timeframe 4-Tier Order Flow Confluence
  const clientMTF = useMemo(() => {
    if (!candles || candles.length < 5) return null;
    try {
      const cleanCandles = candles.map((c) => ({
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.time ? c.time * 1000 : c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 1),
        isClosed: true,
      }));
      return MTFFlowRadarEngine.analyze(symbol, [], [], cleanCandles as any, []);
    } catch (e) {
      return null;
    }
  }, [symbol, candles]);

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  // Load Saved Drawings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`quant_drawings_${symbol}`);
      if (saved) setDrawings(JSON.parse(saved));
    } catch (e) {}
  }, [symbol]);

  const saveDrawings = (newDrawings: any[]) => {
    setDrawings(newDrawings);
    try {
      localStorage.setItem(`quant_drawings_${symbol}`, JSON.stringify(newDrawings));
    } catch (e) {}
  };

  // 1. Initialize Lightweight Chart Engine
  useEffect(() => {
    if (!chartContainerRef.current) return;

    if (chartApiRef.current) {
      chartApiRef.current.remove();
      chartApiRef.current = null;
    }

    const isDark = theme === 'dark';
    const bg = isDark ? '#131722' : '#FFFFFF';
    const textColor = isDark ? '#D1D4DC' : '#131722';
    const gridColor = isDark ? 'rgba(42, 46, 57, 0.55)' : 'rgba(226, 232, 240, 0.8)';

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: textColor,
        fontFamily: "'JetBrains Mono', -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#758696',
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1E222D',
        },
        horzLine: {
          color: '#758696',
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1E222D',
        },
      },
      rightPriceScale: {
        borderColor: gridColor,
        autoScale: true,
        scaleMargins: {
          top: 0.12,
          bottom: 0.20, // Room for volume histogram
        },
      },
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 15, // Allows dragging right past the current candle
        fixLeftEdge: false,
        fixRightEdge: false, // Allows panning right freely
        shiftVisibleRangeOnNewBar: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
    });

    chartApiRef.current = chart;

    // 2. Add Main Price Series based on chartType with Authentic TradingView Aesthetic
    let mainSeries: ISeriesApi<any>;
    if (chartType === 'Candles') {
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#089981',
        downColor: '#F23645',
        borderVisible: true,
        borderUpColor: '#089981',
        borderDownColor: '#F23645',
        wickUpColor: '#089981',
        wickDownColor: '#F23645',
      });
    } else if (chartType === 'Bar') {
      mainSeries = chart.addSeries(BarSeries, {
        upColor: '#089981',
        downColor: '#F23645',
      });
    } else if (chartType === 'Area') {
      mainSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(8, 153, 129, 0.35)',
        bottomColor: 'rgba(8, 153, 129, 0.0)',
        lineColor: '#089981',
        lineWidth: 2,
      });
    } else {
      mainSeries = chart.addSeries(LineSeries, {
        color: '#089981',
        lineWidth: 2,
      });
    }
    mainSeriesRef.current = mainSeries;

    // 3. Add Volume Sub-pane Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });
    volumeSeriesRef.current = volumeSeries;

    // 4. Add Indicator Line Series
    ema20SeriesRef.current = chart.addSeries(LineSeries, {
      color: '#FBBF24',
      lineWidth: 2,
      title: 'EMA 20',
      priceScaleId: 'right',
    });
    ema50SeriesRef.current = chart.addSeries(LineSeries, {
      color: '#06B6D4',
      lineWidth: 2,
      title: 'EMA 50',
      priceScaleId: 'right',
    });
    ema200SeriesRef.current = chart.addSeries(LineSeries, {
      color: '#8B5CF6',
      lineWidth: 2,
      title: 'EMA 200',
      priceScaleId: 'right',
    });
    vwapSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#F97316',
      lineWidth: 2,
      title: 'VWAP',
      priceScaleId: 'right',
    });
    sma20SeriesRef.current = chart.addSeries(LineSeries, {
      color: '#3B82F6',
      lineWidth: 2,
      title: 'SMA 20',
      priceScaleId: 'right',
    });

    // 5. Crosshair Move Listener for OHLC Display
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData || !mainSeriesRef.current) {
        setOhlcData(null);
        return;
      }
      const data: any = param.seriesData.get(mainSeriesRef.current);
      if (data) {
        const timeVal = typeof param.time === 'number' ? param.time * 1000 : Date.now();
        setOhlcData({
          time: new Date(timeVal).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          open: data.open ?? data.value ?? 0,
          high: data.high ?? data.value ?? 0,
          low: data.low ?? data.value ?? 0,
          close: data.close ?? data.value ?? 0,
          volume: 0,
        });
      }
    });

    const handleResize = () => {
      if (chartContainerRef.current && chartApiRef.current) {
        const width = chartContainerRef.current.clientWidth;
        const height = chartContainerRef.current.clientHeight;
        if (width > 0 && height > 0) {
          chartApiRef.current.applyOptions({ width, height });
        }
      }
    };

    // ResizeObserver guarantees flawless canvas sizing on any layout change
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && chartContainerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(chartContainerRef.current);
    }

    window.addEventListener('resize', handleResize);

    setTimeout(() => {
      handleResize();
      if (chartApiRef.current) chartApiRef.current.timeScale().fitContent();
    }, 50);

    return () => {
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch (e) {}
      }
      window.removeEventListener('resize', handleResize);
      if (chartApiRef.current) {
        try {
          chartApiRef.current.remove();
        } catch (e) {}
        chartApiRef.current = null;
      }
      mainSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ema20SeriesRef.current = null;
      ema50SeriesRef.current = null;
      ema200SeriesRef.current = null;
      vwapSeriesRef.current = null;
      sma20SeriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, [chartType, theme]);

  // Dedicated Fullscreen Layout Adaptation
  useEffect(() => {
    if (!chartApiRef.current || !chartContainerRef.current) return;
    const adaptLayout = () => {
      if (chartContainerRef.current && chartApiRef.current) {
        const width = chartContainerRef.current.clientWidth;
        const height = chartContainerRef.current.clientHeight;
        if (width > 0 && height > 0) {
          chartApiRef.current.applyOptions({ width, height });
          chartApiRef.current.timeScale().fitContent();
        }
      }
    };
    const t1 = setTimeout(adaptLayout, 50);
    const t2 = setTimeout(adaptLayout, 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isFullscreen]);

  // 2. Populate Candlestick, Volume & Indicator Series Data
  useEffect(() => {
    if (!mainSeriesRef.current || !candles || candles.length === 0) return;

    const formattedCandles: CandlestickData<Time>[] = [];
    const formattedVolume: HistogramData<Time>[] = [];
    const linePrices: LineData<Time>[] = [];

    const sorted = [...candles].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const seenTimes = new Set<number>();

    sorted.forEach((c) => {
      const timeSec = Math.floor(new Date(c.timestamp).getTime() / 1000) as unknown as Time;
      const numTime = Number(timeSec);
      if (seenTimes.has(numTime)) return;
      seenTimes.add(numTime);

      const isUp = c.close >= c.open;
      formattedCandles.push({
        time: timeSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });

      formattedVolume.push({
        time: timeSec,
        value: c.volume,
        color: isUp ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)',
      });

      linePrices.push({
        time: timeSec,
        value: c.close,
      });
    });

    if (chartType === 'Candles' || chartType === 'Bar') {
      mainSeriesRef.current.setData(formattedCandles);
    } else {
      mainSeriesRef.current.setData(linePrices);
    }

    if (volumeSeriesRef.current && showVolume) {
      volumeSeriesRef.current.setData(formattedVolume);
    } else if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData([]);
    }

    // Calculate & Populate Indicators
    if (sorted.length > 5) {
      const calcEMA = (period: number) => {
        const k = 2 / (period + 1);
        let ema = sorted[0].close;
        return sorted.map((c) => {
          ema = c.close * k + ema * (1 - k);
          return {
            time: Math.floor(new Date(c.timestamp).getTime() / 1000) as unknown as Time,
            value: Number(ema.toFixed(2)),
          };
        });
      };

      const calcSMA = (period: number) => {
        return sorted
          .map((c, idx) => {
            if (idx < period - 1) return null;
            const slice = sorted.slice(idx - period + 1, idx + 1);
            const sum = slice.reduce((acc, curr) => acc + curr.close, 0);
            return {
              time: Math.floor(new Date(c.timestamp).getTime() / 1000) as unknown as Time,
              value: Number((sum / period).toFixed(2)),
            };
          })
          .filter((item): item is { time: Time; value: number } => item !== null);
      };

      const calcVWAP = () => {
        let cumVol = 0;
        let cumTypVol = 0;
        return sorted.map((c) => {
          const typ = (c.high + c.low + c.close) / 3;
          cumVol += c.volume;
          cumTypVol += typ * c.volume;
          return {
            time: Math.floor(new Date(c.timestamp).getTime() / 1000) as unknown as Time,
            value: cumVol > 0 ? Number((cumTypVol / cumVol).toFixed(2)) : c.close,
          };
        });
      };

      if (ema20SeriesRef.current) ema20SeriesRef.current.setData(showEMA20 ? calcEMA(20) : []);
      if (ema50SeriesRef.current) ema50SeriesRef.current.setData(showEMA50 ? calcEMA(50) : []);
      if (ema200SeriesRef.current) ema200SeriesRef.current.setData(showEMA200 ? calcEMA(200) : []);
      if (vwapSeriesRef.current) vwapSeriesRef.current.setData(showVWAP ? calcVWAP() : []);
      if (sma20SeriesRef.current) sma20SeriesRef.current.setData(showSMA20 ? calcSMA(20) : []);
    }
  }, [candles, chartType, showVolume, showEMA20, showEMA50, showEMA200, showVWAP, showSMA20]);

  // Fit content strictly when symbol or timeframe changes so manual pan/drag is never interrupted
  const prevSymbolTfRef = useRef<string>('');
  useEffect(() => {
    const key = `${symbol}_${timeframe}`;
    if (prevSymbolTfRef.current !== key && chartApiRef.current && candles.length > 0) {
      prevSymbolTfRef.current = key;
      chartApiRef.current.timeScale().fitContent();
    }
  }, [symbol, timeframe, candles.length]);

  // 3. Real-Time Incremental Tick Updates
  useEffect(() => {
    if (!mainSeriesRef.current || !candles || candles.length === 0 || !currentPrice) return;

    const lastCandle = candles[candles.length - 1];
    const timeSec = Math.floor(new Date(lastCandle.timestamp).getTime() / 1000) as unknown as Time;

    if (chartType === 'Candles' || chartType === 'Bar') {
      mainSeriesRef.current.update({
        time: timeSec,
        open: lastCandle.open,
        high: Math.max(lastCandle.high, currentPrice),
        low: Math.min(lastCandle.low, currentPrice),
        close: currentPrice,
      });
    } else {
      mainSeriesRef.current.update({
        time: timeSec,
        value: currentPrice,
      });
    }
  }, [currentPrice, chartType, candles]);

  // 4. Trade Setup Calculation & Guaranteed Native Price Lines
  const currSymbol = symbol === 'BTCUSDT' ? '$' : '₹';
  const isSignalForThisSymbol = signal && (!signal.symbol || signal.symbol === symbol);
  const effSignal = isSignalForThisSymbol ? signal : null;
  const isActualTradeActive =
    isTradeActive !== false &&
    !isLocallyCut &&
    !!effSignal &&
    effSignal.state !== 'SL_HIT' &&
    effSignal.state !== 'TP2_HIT' &&
    effSignal.state !== 'TP1_HIT' &&
    effSignal.state !== 'TP3_HIT' &&
    effSignal.grade !== 'NO_TRADE';

  const entryPrice = Number(
    (effSignal?.entryZone?.optimal || effSignal?.entryZone?.max || currentPrice).toFixed(2),
  );
  const slPrice = Number(
    (
      effSignal?.stopLoss ||
      (effSignal?.direction === 'BEARISH' ? entryPrice * 1.005 : entryPrice * 0.995)
    ).toFixed(2),
  );
  const tp1Price = Number(
    (
      effSignal?.takeProfits?.tp1 ||
      (effSignal?.direction === 'BEARISH'
        ? entryPrice - Math.abs(entryPrice - slPrice) * 1.5
        : entryPrice + Math.abs(entryPrice - slPrice) * 1.5)
    ).toFixed(2),
  );
  const tp2Price = Number(
    (
      effSignal?.takeProfits?.tp2 ||
      (effSignal?.direction === 'BEARISH'
        ? entryPrice - Math.abs(entryPrice - slPrice) * 2.5
        : entryPrice + Math.abs(entryPrice - slPrice) * 2.5)
    ).toFixed(2),
  );
  const tp3Price = effSignal?.takeProfits?.tp3
    ? Number(effSignal.takeProfits.tp3.toFixed(2))
    : Number(
        (effSignal?.direction === 'BEARISH'
          ? entryPrice - Math.abs(entryPrice - slPrice) * 4.0
          : entryPrice + Math.abs(entryPrice - slPrice) * 4.0
        ).toFixed(2),
      );

  const rrRatio =
    effSignal?.riskRewardRatios?.rr2 || effSignal?.riskRewardRatio || 2.5;

  // Synchronize Native Lightweight Charts PriceLines (Guarantees Y-axis visibility & scale pills)
  useEffect(() => {
    const series = mainSeriesRef.current;
    if (!series) return;

    // Clean previous price lines
    priceLinesRef.current.forEach((pl) => {
      try {
        series.removePriceLine(pl);
      } catch (e) {}
    });
    priceLinesRef.current = [];

    if (!showLevels || !isActualTradeActive || !entryPrice || !slPrice || !tp1Price || !tp2Price) return;

    try {
      const entryLine = series.createPriceLine({
        price: entryPrice,
        color: '#06B6D4',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'ENTRY',
      });

      const slLine = series.createPriceLine({
        price: slPrice,
        color: '#F43F5E',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL',
      });

      const tp1Line = series.createPriceLine({
        price: tp1Price,
        color: '#10B981',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP1 (1.5R)',
      });

      const tp2Line = series.createPriceLine({
        price: tp2Price,
        color: '#34D399',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP2 (2.5R)',
      });

      const newLines = [entryLine, slLine, tp1Line, tp2Line];

      if (tp3Price) {
        const tp3Line = series.createPriceLine({
          price: tp3Price,
          color: '#059669',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TP3 (4.0R)',
        });
        newLines.push(tp3Line);
      }

      priceLinesRef.current = newLines;
    } catch (e) {
      console.error('Failed to create price lines:', e);
    }

    return () => {
      priceLinesRef.current.forEach((pl) => {
        try {
          series.removePriceLine(pl);
        } catch (e) {}
      });
      priceLinesRef.current = [];
    };
  }, [showLevels, isActualTradeActive, entryPrice, slPrice, tp1Price, tp2Price, tp3Price, chartType]);

  // 5. PineScript-Style SMC Overlays Canvas Synchronization (Order Blocks, FVGs, Liquidity Pools & Sweeps, Dealing Range, BOS/CHoCH)
  const drawSMCOverlays = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const chart = chartApiRef.current;
    const series = mainSeriesRef.current;
    if (!canvas || !chart || !series) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(rect.width * dpr);
    const targetH = Math.floor(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const priceToY = (price: number) => {
      try {
        const coord = series.priceToCoordinate(price);
        return typeof coord === 'number' && !isNaN(coord) ? coord : null;
      } catch (e) {
        return null;
      }
    };

    // Find the Exact Entry Candle X-Coordinate
    let entryCandleX: number = width * 0.55;
    if (candles && candles.length > 0) {
      let entryTimestamp = effSignal?.timestamp;
      if (!entryTimestamp && clientSMC && clientSMC.orderBlocks.length > 0) {
        entryTimestamp = clientSMC.orderBlocks[0].timestamp;
      }
      if (!entryTimestamp) {
        const targetCandle = candles[Math.max(0, candles.length - 16)];
        entryTimestamp = targetCandle?.timestamp;
      }

      if (entryTimestamp) {
        const timeSec = Math.floor(new Date(entryTimestamp).getTime() / 1000) as unknown as Time;
        const coord = chart.timeScale().timeToCoordinate(timeSec);
        if (coord !== null) {
          entryCandleX = Math.max(20, Math.min(coord, width - 100));
        }
      }
    }

    // A-E. Pure SMC Overlays (Dealing Range, OB, FVG, Structure Breaks, Liquidity Pools)
    if (clientSMC) {
      // A. 50% Equilibrium Dealing Range
      if (showRange && clientSMC.dealingRange) {
        const dr = clientSMC.dealingRange;
        const topY = priceToY(dr.high);
        const botY = priceToY(dr.low);
        const midY = priceToY(dr.equilibrium);

        if (topY !== null && botY !== null && midY !== null) {
          const topYPos = Math.min(topY, botY);
          const botYPos = Math.max(topY, botY);

          ctx.fillStyle = 'rgba(244, 63, 94, 0.05)';
          ctx.fillRect(0, topYPos, width - 65, Math.abs(midY - topYPos));

          ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
          ctx.fillRect(0, midY, width - 65, Math.abs(botYPos - midY));

          ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(0, midY);
          ctx.lineTo(width - 65, midY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#94A3B8';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(`50% EQUILIBRIUM (₹${dr.equilibrium.toFixed(2)})`, 15, midY - 4);
        }
      }

      // B. Institutional Order Blocks (OB)
      if (showOB && clientSMC.orderBlocks && clientSMC.orderBlocks.length > 0) {
        clientSMC.orderBlocks.slice(0, 6).forEach((ob, idx) => {
          const obTopY = priceToY(ob.high);
          const obBotY = priceToY(ob.low);
          if (obTopY !== null && obBotY !== null) {
            const isBull = ob.direction === 'BULLISH';
            const boxH = Math.max(8, Math.abs(obBotY - obTopY));
            const boxY = Math.min(obTopY, obBotY);
            const startX = width * (0.3 + idx * 0.05);
            const boxW = width - 65 - startX;

            if (boxW > 20) {
              ctx.fillStyle = isBull ? 'rgba(8, 153, 129, 0.25)' : 'rgba(242, 54, 69, 0.25)';
              ctx.fillRect(startX, boxY, boxW, boxH);

              ctx.strokeStyle = isBull ? '#089981' : '#F23645';
              ctx.lineWidth = 1.4;
              ctx.strokeRect(startX, boxY, boxW, boxH);

              ctx.fillStyle = isBull ? '#089981' : '#F23645';
              ctx.font = 'bold 9px monospace';
              ctx.fillText(
                isBull ? `▲ Bullish OB [${ob.low.toFixed(2)} - ${ob.high.toFixed(2)}]` : `▼ Bearish OB [${ob.low.toFixed(2)} - ${ob.high.toFixed(2)}]`,
                startX + 6,
                boxY + Math.min(12, boxH - 2),
              );
            }
          }
        });
      }

      // C. Fair Value Gaps (FVG)
      if (showFVG && clientSMC.fairValueGaps && clientSMC.fairValueGaps.length > 0) {
        clientSMC.fairValueGaps.slice(0, 6).forEach((fvg, idx) => {
          const fvgTopY = priceToY(fvg.upperBound);
          const fvgBotY = priceToY(fvg.lowerBound);
          if (fvgTopY !== null && fvgBotY !== null) {
            const isBull = fvg.direction === 'BULLISH';
            const fvgH = Math.max(6, Math.abs(fvgBotY - fvgTopY));
            const fvgY = Math.min(fvgTopY, fvgBotY);
            const startX = width * (0.2 + idx * 0.05);
            const boxW = width - 65 - startX;

            if (boxW > 20) {
              ctx.fillStyle = isBull ? 'rgba(6, 182, 212, 0.18)' : 'rgba(244, 63, 94, 0.18)';
              ctx.fillRect(startX, fvgY, boxW, fvgH);

              ctx.strokeStyle = isBull ? 'rgba(6, 182, 212, 0.8)' : 'rgba(244, 63, 94, 0.8)';
              ctx.setLineDash([3, 3]);
              ctx.strokeRect(startX, fvgY, boxW, fvgH);
              ctx.setLineDash([]);

              ctx.fillStyle = isBull ? '#06B6D4' : '#F43F5E';
              ctx.font = 'bold 9px monospace';
              ctx.fillText(isBull ? `⚡ Bullish FVG` : `⚡ Bearish FVG`, startX + 6, fvgY + Math.min(10, fvgH - 2));
            }
          }
        });
      }

      // D. Structure Breaks (BOS & CHoCH) - Localized Structural Breakout Segments
      if (showCHoCH && clientSMC.changesOfCharacter && clientSMC.changesOfCharacter.length > 0) {
        clientSMC.changesOfCharacter.slice(-3).forEach((ch) => {
          const y = priceToY(ch.brokenLevel);
          if (y !== null) {
            const isBull = ch.direction === 'BULLISH';
            const timeSec = Math.floor(new Date(ch.timestamp).getTime() / 1000) as unknown as Time;
            const candleX = chart.timeScale().timeToCoordinate(timeSec);
            
            // Local bounded segment (anchored to the breakout candle)
            const endX = candleX !== null ? candleX + 15 : width * 0.75;
            const startX = candleX !== null ? Math.max(10, candleX - 85) : width * 0.55;

            ctx.strokeStyle = isBull ? '#089981' : '#F23645';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();

            // Compact CHoCH Tag centered on the local segment
            const midX = (startX + endX) / 2;
            ctx.fillStyle = isBull ? '#089981' : '#F23645';
            ctx.fillRect(midX - 26, y - 13, 52, 12);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 8.5px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(isBull ? 'CHoCH ▲' : 'CHoCH ▼', midX, y - 4);
            ctx.textAlign = 'left';
          }
        });
      }

      if (showBOS && clientSMC.breaksOfStructure && clientSMC.breaksOfStructure.length > 0) {
        clientSMC.breaksOfStructure.slice(-4).forEach((bos) => {
          const y = priceToY(bos.brokenLevel || bos.brokenSwingPoint?.price || bos.breakPrice);
          if (y !== null) {
            const isBull = bos.direction === 'BULLISH';
            const timeSec = Math.floor(new Date(bos.timestamp).getTime() / 1000) as unknown as Time;
            const candleX = chart.timeScale().timeToCoordinate(timeSec);
            
            // Local bounded dashed segment
            const endX = candleX !== null ? candleX + 15 : width * 0.7;
            const startX = candleX !== null ? Math.max(10, candleX - 75) : width * 0.55;

            ctx.strokeStyle = isBull ? 'rgba(8, 153, 129, 0.85)' : 'rgba(242, 54, 69, 0.85)';
            ctx.lineWidth = 1.3;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Compact BOS Tag centered on the local segment
            const midX = (startX + endX) / 2;
            ctx.fillStyle = isBull ? 'rgba(8, 153, 129, 0.9)' : 'rgba(242, 54, 69, 0.9)';
            ctx.fillRect(midX - 20, y - 12, 40, 11);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(isBull ? 'BOS ▲' : 'BOS ▼', midX, y - 3);
            ctx.textAlign = 'left';
          }
        });
      }

      // E. LIQUIDITY POOLS (BSL / SSL) & LIQUIDITY SWEEPS - Anchored Directly On Candle Wicks
      if (showLiq && clientSMC.liquidityPools && clientSMC.liquidityPools.length > 0) {
        // Draw resting unswept pools as local bounded lines
        clientSMC.liquidityPools.filter((lp) => !lp.isSwept).slice(0, 4).forEach((lp) => {
          const y = priceToY(lp.priceLevel);
          if (y !== null) {
            const isBSL = lp.type === 'BUY_SIDE' || lp.type === 'EQUAL_HIGHS';
            const timeSec = Math.floor(new Date(lp.firstTimestamp).getTime() / 1000) as unknown as Time;
            const startCoord = chart.timeScale().timeToCoordinate(timeSec);
            const startX = startCoord !== null ? Math.max(10, startCoord) : width * 0.3;
            const endX = width - 65;
            
            // Liquidity Level Local Segment
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Right Price Scale Tag
            ctx.fillStyle = '#F59E0B';
            ctx.fillRect(endX, y - 7, 65, 14);
            ctx.fillStyle = '#0F172A';
            ctx.font = 'bold 8.5px monospace';
            ctx.fillText(isBSL ? 'BSL $$$' : 'SSL $$$', endX + 4, y + 4);
          }
        });
      }

      // Render Liquidity Sweeps Directly Above/Below Candle Wicks (No Full Horizontal Lines)
      if (showLiq && clientSMC.liquiditySweeps && clientSMC.liquiditySweeps.length > 0) {
        clientSMC.liquiditySweeps.slice(-5).forEach((sweep) => {
          const sweepPrice = sweep.sweptPrice || sweep.priceLevel;
          const y = priceToY(sweepPrice);
          const sweepTime = sweep.sweptTimestamp || sweep.lastTimestamp || sweep.firstTimestamp;

          if (y !== null && sweepTime) {
            const timeSec = Math.floor(new Date(sweepTime).getTime() / 1000) as unknown as Time;
            const candleX = chart.timeScale().timeToCoordinate(timeSec);

            if (candleX !== null && candleX > 10 && candleX < width - 65) {
              const isBSLSweep = sweep.type === 'BUY_SIDE' || sweep.type === 'EQUAL_HIGHS';

              // Short 30px tick mark directly across the candle wick
              ctx.strokeStyle = '#F59E0B';
              ctx.lineWidth = 1.4;
              ctx.beginPath();
              ctx.moveTo(candleX - 15, y);
              ctx.lineTo(candleX + 15, y);
              ctx.stroke();

              if (isBSLSweep) {
                // Swept High (Downward pointer arrow right above candle wick)
                ctx.fillStyle = '#F59E0B';
                ctx.beginPath();
                ctx.moveTo(candleX, y - 2);
                ctx.lineTo(candleX - 4, y - 8);
                ctx.lineTo(candleX + 4, y - 8);
                ctx.closePath();
                ctx.fill();

                // Compact Pill directly on the candle
                ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
                ctx.fillRect(candleX - 28, y - 22, 56, 12);
                ctx.fillStyle = '#0F172A';
                ctx.font = 'bold 7.5px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('⚡ LIQ SWEEP', candleX, y - 13);
                ctx.textAlign = 'left';
              } else {
                // Swept Low (Upward pointer arrow right below candle wick)
                ctx.fillStyle = '#06B6D4';
                ctx.beginPath();
                ctx.moveTo(candleX, y + 2);
                ctx.lineTo(candleX - 4, y + 8);
                ctx.lineTo(candleX + 4, y + 8);
                ctx.closePath();
                ctx.fill();

                // Compact Pill directly on the candle
                ctx.fillStyle = 'rgba(6, 182, 212, 0.95)';
                ctx.fillRect(candleX - 28, y + 10, 56, 12);
                ctx.fillStyle = '#0F172A';
                ctx.font = 'bold 7.5px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('💧 LIQ SWEEP', candleX, y + 19);
                ctx.textAlign = 'left';
              }
            }
          }
        });
      }
    }

    // F. ENTRY, STOP LOSS (SL) & TAKE PROFIT (TP) SHADED BOXES & ANCHORS
    if (showLevels && isActualTradeActive && entryPrice && slPrice && tp2Price) {
      const rawEntryY = priceToY(entryPrice);
      const rawSlY = priceToY(slPrice);
      const rawTp1Y = tp1Price ? priceToY(tp1Price) : null;
      const rawTp2Y = priceToY(tp2Price);

      const entryY = rawEntryY !== null ? rawEntryY : height * 0.45;
      const slY = rawSlY !== null ? rawSlY : (effSignal?.direction === 'BEARISH' ? entryY - 40 : entryY + 40);
      const tp2Y = rawTp2Y !== null ? rawTp2Y : (effSignal?.direction === 'BEARISH' ? entryY + 70 : entryY - 70);
      const tp1Y = rawTp1Y !== null ? rawTp1Y : (effSignal?.direction === 'BEARISH' ? entryY + 40 : entryY - 40);

      const endX = width - 65; // Right price axis boundary
      const startX = Math.max(10, Math.min(entryCandleX, width - 130));
      const boxWidth = Math.max(20, endX - startX);

      // Shaded Profit Target Zone (Green)
      const topProfitY = Math.min(entryY, tp2Y);
      const profitHeight = Math.max(4, Math.abs(entryY - tp2Y));
      ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
      ctx.fillRect(startX, topProfitY, boxWidth, profitHeight);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(startX, topProfitY, boxWidth, profitHeight);

      // Shaded Risk Zone (Red)
      const topRiskY = Math.min(entryY, slY);
      const riskHeight = Math.max(4, Math.abs(entryY - slY));
      ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
      ctx.fillRect(startX, topRiskY, boxWidth, riskHeight);
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(startX, topRiskY, boxWidth, riskHeight);

      // Vertical Entry Anchor Marker Line
      ctx.strokeStyle = '#06B6D4';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(startX, Math.min(topProfitY, topRiskY));
      ctx.lineTo(startX, Math.max(topProfitY + profitHeight, topRiskY + riskHeight));
      ctx.stroke();
      ctx.setLineDash([]);

      // Entry Anchor Glowing Bead & Badge
      ctx.fillStyle = '#06B6D4';
      ctx.beginPath();
      ctx.arc(startX, entryY, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#06B6D4';
      ctx.fillRect(startX + 8, entryY - 9, 90, 18);
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('▲ ENTRY TRIGGER', startX + 12, entryY + 3);

      // SL Anchor Dot & Badge
      ctx.fillStyle = '#F43F5E';
      ctx.beginPath();
      ctx.arc(startX, slY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#F43F5E';
      ctx.fillRect(startX + 8, slY - 9, 50, 18);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('● SL', startX + 12, slY + 3);

      // TP1 Anchor Dot & Badge
      ctx.fillStyle = '#10B981';
      ctx.beginPath();
      ctx.arc(startX, tp1Y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#10B981';
      ctx.fillRect(startX + 8, tp1Y - 9, 78, 18);
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('● TP1 (1.5R)', startX + 12, tp1Y + 3);

      // TP2 Anchor Dot & Badge
      ctx.fillStyle = '#34D399';
      ctx.beginPath();
      ctx.arc(startX, tp2Y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#34D399';
      ctx.fillRect(startX + 8, tp2Y - 9, 78, 18);
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('● TP2 (2.5R)', startX + 12, tp2Y + 3);
    }

    // G. User Custom Drawings
    drawings.forEach((d) => {
      ctx.strokeStyle = d.color || '#06B6D4';
      ctx.lineWidth = d.width || 2;

      if (d.type === 'hline') {
        const y = priceToY(d.price);
        if (y !== null) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width - 65, y);
          ctx.stroke();
        }
      }
    });

    // H. Institutional Volume Profile (POC, VAH, VAL & Distribution Bins)
    if (showVolumeProfile && clientVP && clientVP.bins.length > 0) {
      const maxBinVolume = Math.max(...clientVP.bins.map((b) => b.totalVolume));
      const maxHistogramWidth = 110;

      clientVP.bins.forEach((bin) => {
        const y = priceToY(bin.priceLevel);
        if (y !== null && maxBinVolume > 0) {
          const binWidth = (bin.totalVolume / maxBinVolume) * maxHistogramWidth;
          const binH = Math.max(3, Math.min(8, (height / clientVP.bins.length) * 0.85));
          const startX = width - 65 - binWidth;

          // Buy vs Sell delta color
          const isBuyDominant = bin.delta >= 0;
          ctx.fillStyle = isBuyDominant ? 'rgba(6, 182, 212, 0.22)' : 'rgba(244, 63, 94, 0.22)';
          ctx.fillRect(startX, y - binH / 2, binWidth, binH);
        }
      });

      // Highlight POC (Point of Control)
      const pocY = priceToY(clientVP.poc);
      if (pocY !== null) {
        ctx.strokeStyle = '#F59E0B'; // Amber Gold
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(width - 200, pocY);
        ctx.lineTo(width - 65, pocY);
        ctx.stroke();

        ctx.fillStyle = '#F59E0B';
        ctx.fillRect(width - 200, pocY - 8, 80, 16);
        ctx.fillStyle = '#0F172A';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`★ POC ₹${clientVP.poc.toFixed(2)}`, width - 196, pocY + 4);
      }

      // Highlight VAH & VAL (70% Value Area)
      const vahY = priceToY(clientVP.vah);
      if (vahY !== null) {
        ctx.strokeStyle = '#06B6D4';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(width - 150, vahY);
        ctx.lineTo(width - 65, vahY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#06B6D4';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(`VAH ₹${clientVP.vah.toFixed(2)}`, width - 150, vahY - 3);
      }

      const valY = priceToY(clientVP.val);
      if (valY !== null) {
        ctx.strokeStyle = '#06B6D4';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(width - 150, valY);
        ctx.lineTo(width - 65, valY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#06B6D4';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(`VAL ₹${clientVP.val.toFixed(2)}`, width - 150, valY + 10);
      }
    }

    // I. Institutional Stop-Loss Liquidity Heatmap Density Overlay
    if (showLiquidityHeatmap && clientHeatmap && clientHeatmap.heatBands.length > 0) {
      clientHeatmap.heatBands.forEach((band) => {
        const topY = priceToY(band.maxPrice);
        const botY = priceToY(band.minPrice);
        if (topY !== null && botY !== null) {
          const y = Math.min(topY, botY);
          const h = Math.max(3, Math.abs(botY - topY));
          ctx.fillStyle = band.intensityColor;
          ctx.fillRect(0, y, width - 65, h);

          if (band.densityScore >= 60) {
            ctx.fillStyle = band.type === 'BSL_HEAT' ? '#F59E0B' : '#06B6D4';
            ctx.font = 'bold 8px monospace';
            ctx.fillText(band.label, 8, y + Math.min(10, h));
          }
        }
      });
    }

    // J. ICT Session / Kill Zone Watermark
    if (showKillZones && clientSession) {
      const isKZ = clientSession.isKillZone;
      ctx.fillStyle = isKZ ? 'rgba(16, 185, 129, 0.14)' : 'rgba(148, 163, 184, 0.08)';
      ctx.fillRect(width - 240, 10, 170, 22);
      ctx.strokeStyle = isKZ ? 'rgba(16, 185, 129, 0.4)' : 'rgba(148, 163, 184, 0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(width - 240, 10, 170, 22);

      ctx.fillStyle = isKZ ? '#10B981' : '#94A3B8';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(clientSession.badge, width - 232, 24);
    }

    ctx.restore();
  }, [
    clientSMC,
    clientVP,
    clientHeatmap,
    clientSession,
    showVolumeProfile,
    showLiquidityHeatmap,
    showKillZones,
    showOB,
    showFVG,
    showBOS,
    showCHoCH,
    showLiq,
    showLevels,
    showRange,
    entryPrice,
    slPrice,
    tp1Price,
    tp2Price,
    tp3Price,
    candles,
    drawings,
    effSignal,
  ]);

  // Hook drawing loop into timeScale changes and continuous animation loop
  useEffect(() => {
    let animId: number;
    const loop = () => {
      drawSMCOverlays();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [drawSMCOverlays]);

  // Zoom / Pan / Minimize Control Helpers
  const handleZoomIn = () => {
    if (!chartApiRef.current) return;
    const timeScale = chartApiRef.current.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (range) {
      const span = range.to - range.from;
      const newFrom = range.from + span * 0.15;
      const newTo = range.to - span * 0.15;
      timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
    }
  };

  const handleZoomOut = () => {
    if (!chartApiRef.current) return;
    const timeScale = chartApiRef.current.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (range) {
      const span = range.to - range.from;
      const newFrom = range.from - span * 0.25;
      const newTo = range.to + span * 0.25;
      timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
    }
  };

  const handleResetView = () => {
    if (!chartApiRef.current) return;
    chartApiRef.current.timeScale().fitContent();
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeDrawingTool || !mainSeriesRef.current) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const price = mainSeriesRef.current.coordinateToPrice(y);

    if (price === null) return;

    if (activeDrawingTool === 'hline') {
      const newD = [...drawings, { type: 'hline', price, color: '#06B6D4', width: 2 }];
      saveDrawings(newD);
      setActiveDrawingTool(null);
    }
  };

  const clearAllDrawings = () => {
    saveDrawings([]);
    setActiveDrawingTool(null);
  };

  const isBullish = effSignal?.direction !== 'BEARISH';

  return (
    <div
      className={`bg-[#0B0F19] border border-slate-800 rounded-xl shadow-2xl flex flex-col transition-all duration-200 ${
        isFullscreen
          ? 'fixed inset-0 z-50 rounded-none border-none h-screen w-screen p-4 bg-[#0B0F19]'
          : 'h-[620px] p-4'
      }`}
    >
      {/* 1. Main Professional Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800/80 mb-2">
        {/* Left: Symbol Selector & Live Price */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {onSymbolChange ? (
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs font-mono">
                {[
                  { sym: 'NIFTY', label: 'NIFTY' },
                  { sym: 'BANKNIFTY', label: 'BANKNIFTY' },
                  { sym: 'BTCUSDT', label: 'BTC ⚡' },
                  { sym: 'RELIANCE', label: 'RELIANCE' },
                  { sym: 'HDFCBANK', label: 'HDFC' },
                  { sym: 'INFY', label: 'INFY' },
                ].map((item) => (
                  <button
                    key={item.sym}
                    onClick={() => onSymbolChange(item.sym)}
                    className={`px-2 py-1 rounded transition-all font-bold ${
                      symbol === item.sym
                        ? 'bg-cyan-500 text-slate-950 shadow-sm font-black'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-xl font-black text-white font-mono tracking-tight">{symbol}</span>
            )}
            <span className="text-xs text-slate-400 font-mono bg-slate-800 px-2 py-1 rounded border border-slate-700">
              {timeframe}
            </span>
          </div>

          {/* Live Price Display */}
          <div className="flex items-center gap-2 pl-3 border-l border-slate-800">
            <span className="text-2xl font-black text-white font-mono tracking-tight">
              {currSymbol}{currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span
              className={`text-xs font-bold px-2 py-0.5 rounded flex items-center gap-0.5 ${
                liveChangePercent >= 0
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }`}
            >
              {liveChangePercent >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {liveChangePercent >= 0 ? '+' : ''}
              {liveChangePercent}%
            </span>
            <span className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-950/40 border border-cyan-800/40 px-2 py-0.5 rounded font-mono">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
              LIVE TICK
            </span>
          </div>
        </div>

        {/* Center: Timeframe Switcher */}
        {onTimeframeChange && (
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs font-mono">
            {timeframes.map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                className={`px-2.5 py-1 rounded transition-all font-bold ${
                  timeframe.toLowerCase() === tf.toLowerCase()
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {/* Right: Chart Controls & Modals */}
        <div className="flex items-center gap-2">
          {/* Zoom In & Zoom Out / Minimize Controls */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
            <button
              onClick={handleZoomIn}
              title="Zoom In (+)"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleZoomOut}
              title="Zoom Out / Minimize Candles (-)"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleResetView}
              title="Reset View / Fit Content"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Chart Type Selector */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs font-mono">
            {(['Candles', 'Bar', 'Line', 'Area'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setChartType(type)}
                className={`px-2 py-1 rounded transition-all ${
                  chartType === type
                    ? 'bg-slate-800 text-cyan-400 font-bold border border-slate-700'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* Indicators Modal Toggle */}
          <button
            onClick={() => setShowIndicatorsModal(!showIndicatorsModal)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
              showIndicatorsModal
                ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Indicators</span>
          </button>

          {/* Volume Profile Toggle */}
          <button
            onClick={() => setShowVolumeProfile(!showVolumeProfile)}
            title="Toggle Institutional Volume Profile (POC, VAH, VAL)"
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
              showVolumeProfile
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <span>📊 Vol Profile</span>
          </button>

          {/* Kill Zones Toggle */}
          <button
            onClick={() => setShowKillZones(!showKillZones)}
            title="Toggle ICT Kill Zones & Session Watermark"
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
              showKillZones
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Kill Zones</span>
          </button>

          {/* Liquidity Heatmap Toggle */}
          <button
            onClick={() => setShowLiquidityHeatmap(!showLiquidityHeatmap)}
            title="Toggle Resting Stop-Loss Liquidity Heatmap"
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
              showLiquidityHeatmap
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Droplets className="w-3.5 h-3.5" />
            <span>Liq Heatmap</span>
          </button>

          {/* SMC Overlays Toggle */}
          <button
            onClick={() => setShowSMCModal(!showSMCModal)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
              showSMCModal
                ? 'bg-purple-500/20 text-purple-400 border-purple-500/40'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>SMC Pro</span>
          </button>

          {/* Drawing Tools Dropdown */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
            <button
              onClick={() => setActiveDrawingTool(activeDrawingTool === 'hline' ? null : 'hline')}
              title="Horizontal Line"
              className={`p-1.5 rounded transition-colors ${
                activeDrawingTool === 'hline'
                  ? 'bg-cyan-500/20 text-cyan-400'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            {drawings.length > 0 && (
              <button
                onClick={clearAllDrawings}
                title="Clear All Drawings"
                className="p-1.5 text-rose-400 hover:bg-slate-800 rounded transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Fullscreen Maximize / Minimize Button */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Minimize Window (ESC)' : 'Maximize Fullscreen'}
            className={`p-1.5 rounded-lg border transition-all ${
              isFullscreen
                ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
            }`}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* 2. Real-Time Dynamic Trade Status & Setup Level Pills Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-1.5 px-3 bg-slate-900/90 border border-slate-800 rounded-lg mb-2 text-xs font-mono shadow-md">
        <div className="flex flex-wrap items-center gap-2.5">
          {paperPosition && !isLocallyCut ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <span className="font-black text-cyan-300 flex items-center gap-1">
                RUNNING {paperPosition.quantity} {symbol === 'BTCUSDT' ? 'BTC' : 'Qty'} @ {currSymbol}{Number(paperPosition.averageEntryPrice).toFixed(2)}
              </span>
              <span
                className={`px-2.5 py-0.5 rounded font-black border flex items-center gap-1 ${
                  paperPosition.unrealizedPnL >= 0
                    ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50 shadow-sm shadow-emerald-500/20'
                    : 'bg-rose-950/80 text-rose-400 border-rose-500/50'
                }`}
              >
                UNREALIZED P&L: {paperPosition.unrealizedPnL >= 0 ? '+' : ''}{currSymbol}{Math.abs(paperPosition.unrealizedPnL).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          ) : isLocallyCut ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
              </span>
              <span className="bg-amber-950/90 text-amber-300 border border-amber-500/50 px-2.5 py-0.5 rounded font-black flex items-center gap-1">
                ⚡ POSITION EXITED (MANUAL MARKET EXIT)
              </span>
              <span className="text-slate-400 text-[11px]">
                Status: <strong className="text-amber-300">Position Cut & Closed</strong>
              </span>
            </div>
          ) : effSignal?.state === 'SL_HIT' ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
              </span>
              <span className="bg-rose-950/90 text-rose-300 border border-rose-500/50 px-2.5 py-0.5 rounded font-black flex items-center gap-1">
                🛑 TRADE CUT & CLOSED (STOP LOSS HIT)
              </span>
              <span className="text-slate-400 text-[11px]">
                Exit: <strong className="text-rose-400">{currSymbol}{slPrice.toFixed(2)}</strong> | Realized: <strong className="text-rose-400">-1.0R</strong>
              </span>
            </div>
          ) : effSignal?.state === 'TP2_HIT' || effSignal?.state === 'TP3_HIT' ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-teal-500" />
              </span>
              <span className="bg-teal-950/90 text-teal-300 border border-teal-500/50 px-2.5 py-0.5 rounded font-black flex items-center gap-1">
                🎯 TRADE COMPLETED (TARGET 2 HIT)
              </span>
              <span className="text-slate-400 text-[11px]">
                Exit: <strong className="text-teal-300">{currSymbol}{tp2Price.toFixed(2)}</strong> | Realized: <strong className="text-teal-300">+2.5R</strong>
              </span>
            </div>
          ) : effSignal?.state === 'TP1_HIT' ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <span className="bg-emerald-950/90 text-emerald-300 border border-emerald-500/50 px-2.5 py-0.5 rounded font-black flex items-center gap-1">
                ✅ TARGET 1 HIT (+2.0R) — RUNNER ACTIVE
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-slate-600" />
              <span className="text-slate-400 font-bold">
                STANDBY: Order Block Entry ({currSymbol}{entryPrice.toFixed(2)})
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`px-3 py-1 rounded-lg text-xs font-black transition-all flex items-center gap-1.5 shadow-md ${
              isBullish
                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-emerald-500/10'
                : 'bg-rose-500/20 border border-rose-500/40 text-rose-300 shadow-rose-500/10'
            }`}
          >
            {isBullish ? '🟢 BULLISH ORDER FLOW' : '🔴 BEARISH ORDER FLOW'}
          </span>
        </div>
      </div>

      {/* 2. Glassmorphic Dual Telemetry Floating Island */}
      <div className="bg-[#0B101D]/90 border border-slate-800/90 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono shadow-2xl backdrop-blur-2xl relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-transparent to-emerald-500/5 pointer-events-none" />

        {/* Left: Trade Levels (Sniper SL & Asymmetric Targets) */}
        <div className="flex flex-wrap items-center gap-2 relative z-10">
          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 px-2 py-1 rounded-lg">
            <span className="text-[10px] text-slate-400 font-bold uppercase">ENTRY:</span>
            <span className="text-white font-black">{currSymbol}{entryPrice.toFixed(2)}</span>
          </div>

          <div className="flex items-center gap-1.5 bg-rose-950/40 border border-rose-500/40 px-2 py-1 rounded-lg">
            <span className="text-[10px] text-rose-300 font-bold uppercase">SL:</span>
            <span className="text-rose-400 font-black">{currSymbol}{slPrice.toFixed(2)}</span>
          </div>

          <div className="flex items-center gap-1.5 bg-emerald-950/40 border border-emerald-500/40 px-2 py-1 rounded-lg">
            <span className="text-[10px] text-emerald-300 font-bold uppercase">TP1 (2.0R):</span>
            <span className="text-emerald-400 font-black">{currSymbol}{tp1Price.toFixed(2)}</span>
          </div>

          <div className="flex items-center gap-1.5 bg-teal-950/40 border border-teal-500/40 px-2 py-1 rounded-lg">
            <span className="text-[10px] text-teal-300 font-bold uppercase">TP2 (3.5R):</span>
            <span className="text-teal-400 font-black">{currSymbol}{tp2Price.toFixed(2)}</span>
          </div>

          {tp3Price && (
            <div className="hidden sm:flex items-center gap-1.5 bg-purple-950/40 border border-purple-500/40 px-2 py-1 rounded-lg">
              <span className="text-[10px] text-purple-300 font-bold uppercase">TP3 (6.0R):</span>
              <span className="text-purple-300 font-black">{currSymbol}{tp3Price.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Right: Deterministic SMC Score vs AI ML Probability & Expectancy */}
        <div className="flex flex-wrap items-center gap-2 relative z-10">
          <div className="bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800 flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400 font-bold uppercase">SMC:</span>
            <strong className="text-cyan-300 font-black">{aiPredictionInfo?.deterministicScore || effSignal?.score || 85}/100</strong>
          </div>

          <div className="bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800 flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400 font-bold uppercase">AI PROB:</span>
            <strong className="text-emerald-400 font-black">
              {aiPredictionInfo ? `${(aiPredictionInfo.winProbability * 100).toFixed(0)}%` : '78%'}
            </strong>
          </div>

          <div className="bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800 flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400 font-bold uppercase">EV:</span>
            <strong className="text-cyan-300 font-black">
              {aiPredictionInfo ? `${aiPredictionInfo.expectedValueR >= 0 ? '+' : ''}${aiPredictionInfo.expectedValueR.toFixed(2)}R` : '+1.45R'}
            </strong>
          </div>

          <span
            className={`px-3 py-1 rounded-lg font-black border text-[10px] uppercase tracking-wider flex items-center gap-1 shadow-sm ${
              (aiPredictionInfo?.recommendation || 'HIGH_CONFIDENCE') === 'HIGH_CONFIDENCE'
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50 shadow-emerald-500/10'
                : (aiPredictionInfo?.recommendation) === 'MODERATE_CONFIDENCE'
                ? 'bg-teal-950/80 text-teal-300 border-teal-500/50'
                : 'bg-slate-850 text-slate-300 border-slate-700'
            }`}
          >
            ⚡ {aiPredictionInfo?.recommendation || 'HIGH_CONFIDENCE'}
          </span>
        </div>
      </div>

      {/* 3. OHLC Dynamic Crosshair Header Bar (TradingView Style) */}
      {ohlcData && (
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-400 pb-2">
          <span>Time: <strong className="text-cyan-400">{ohlcData.time}</strong></span>
          <span>O: <strong className="text-slate-200">{ohlcData.open.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          <span>H: <strong className="text-slate-200">{ohlcData.high.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          <span>L: <strong className="text-slate-200">{ohlcData.low.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          <span>C: <strong className={ohlcData.close >= ohlcData.open ? 'text-[#089981]' : 'text-[#F23645]'}>{ohlcData.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          {(() => {
            const diff = ohlcData.close - ohlcData.open;
            const pct = ohlcData.open > 0 ? (diff / ohlcData.open) * 100 : 0;
            const isUp = diff >= 0;
            return (
              <span className={`font-bold ${isUp ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                {isUp ? '+' : ''}{diff.toFixed(2)} ({isUp ? '+' : ''}{pct.toFixed(2)}%)
              </span>
            );
          })()}
        </div>
      )}

      {/* 4. Indicators Dropdown Drawer */}
      {showIndicatorsModal && (
        <div className="bg-slate-900/95 border border-slate-800 rounded-lg p-3 mb-2 grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs font-mono animate-in fade-in">
          <label className="flex items-center gap-2 cursor-pointer text-amber-400">
            <input type="checkbox" checked={showEMA20} onChange={(e) => setShowEMA20(e.target.checked)} />
            <span>EMA 20</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-cyan-400">
            <input type="checkbox" checked={showEMA50} onChange={(e) => setShowEMA50(e.target.checked)} />
            <span>EMA 50</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-purple-400">
            <input type="checkbox" checked={showEMA200} onChange={(e) => setShowEMA200(e.target.checked)} />
            <span>EMA 200</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-orange-400">
            <input type="checkbox" checked={showVWAP} onChange={(e) => setShowVWAP(e.target.checked)} />
            <span>VWAP</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-blue-400">
            <input type="checkbox" checked={showSMA20} onChange={(e) => setShowSMA20(e.target.checked)} />
            <span>SMA 20</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-300">
            <input type="checkbox" checked={showVolume} onChange={(e) => setShowVolume(e.target.checked)} />
            <span>Volume</span>
          </label>
        </div>
      )}

      {/* 5. SMC Overlays Dropdown Drawer */}
      {showSMCModal && (
        <div className="bg-slate-900/95 border border-slate-800 rounded-lg p-3 mb-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-xs font-mono animate-in fade-in">
          <label className="flex items-center gap-2 cursor-pointer text-emerald-400">
            <input type="checkbox" checked={showOB} onChange={(e) => setShowOB(e.target.checked)} />
            <span>Order Blocks</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-cyan-400">
            <input type="checkbox" checked={showFVG} onChange={(e) => setShowFVG(e.target.checked)} />
            <span>Fair Value Gaps</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-teal-400">
            <input type="checkbox" checked={showBOS} onChange={(e) => setShowBOS(e.target.checked)} />
            <span>BOS Lines</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-indigo-400">
            <input type="checkbox" checked={showCHoCH} onChange={(e) => setShowCHoCH(e.target.checked)} />
            <span>CHoCH Lines</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-amber-400">
            <input type="checkbox" checked={showLiq} onChange={(e) => setShowLiq(e.target.checked)} />
            <span>Liquidity Pools</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-rose-400">
            <input type="checkbox" checked={showLevels} onChange={(e) => setShowLevels(e.target.checked)} />
            <span>SL / TP Levels</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-purple-400">
            <input type="checkbox" checked={showRange} onChange={(e) => setShowRange(e.target.checked)} />
            <span>50% Dealing Range</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-yellow-400">
            <input type="checkbox" checked={showSMCDash} onChange={(e) => setShowSMCDash(e.target.checked)} />
            <span>SMC Dashboard</span>
          </label>
        </div>
      )}

      {/* 6. Chart Viewport Container (Lightweight Charts + Canvas Overlay + SMC HUD + MTF Permission) */}
      <div className="relative flex-1 w-full min-h-0">
        <div ref={chartContainerRef} className="w-full h-full" />
        <canvas
          ref={overlayCanvasRef}
          onClick={handleCanvasClick}
          className={`absolute inset-0 w-full h-full z-10 ${
            activeDrawingTool ? 'cursor-crosshair pointer-events-auto' : 'cursor-default pointer-events-none'
          }`}
        />

        {/* Floating MTF Trade Permission Badge */}
        {clientMTF && (
          <div className="absolute top-3 left-3 z-20 bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-lg px-2.5 py-1.5 shadow-xl text-[10px] font-mono flex items-center gap-2 pointer-events-auto">
            <span
              className={`h-2 w-2 rounded-full animate-ping ${
                clientMTF.overallBias === 'STRONG_BULLISH'
                  ? 'bg-emerald-400'
                  : clientMTF.overallBias === 'STRONG_BEARISH'
                  ? 'bg-rose-400'
                  : 'bg-amber-400'
              }`}
            />
            <span className="text-slate-400 font-bold">RADAR:</span>
            <span
              className={`font-black ${
                clientMTF.overallBias === 'STRONG_BULLISH'
                  ? 'text-emerald-400'
                  : clientMTF.overallBias === 'STRONG_BEARISH'
                  ? 'text-rose-400'
                  : 'text-amber-400'
              }`}
            >
              {clientMTF.tradePermission.replace(/_/g, ' ')}
            </span>
            <span className="text-slate-500 font-normal">({clientMTF.alignmentScore}/4 TIERS)</span>
          </div>
        )}

        {/* SMC Pro HUD Status Dashboard (PineScript Inspired Table) */}
        {showSMCDash && (
          <div className="absolute top-3 right-16 bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-lg p-2.5 shadow-xl text-[11px] font-mono space-y-1.5 pointer-events-auto">
            <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-1">
              <span className="text-slate-400 font-bold flex items-center gap-1">
                <Shield className="w-3 h-3 text-cyan-400" />
                SMC Metric
              </span>
              <span className="text-slate-400 font-bold">Status / Value</span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-300">Market Bias</span>
              <span
                className={`font-bold flex items-center gap-1 ${
                  isBullish ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isBullish ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {isBullish ? 'BULLISH ▲' : 'BEARISH ▼'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-300">Active OBs</span>
              <span className="text-yellow-400 font-bold">{clientSMC?.orderBlocks?.length || 0}</span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-300">Active FVGs</span>
              <span className="text-cyan-400 font-bold">{clientSMC?.fairValueGaps?.length || 0}</span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-300">Liq Pools (BSL/SSL)</span>
              <span className="text-amber-400 font-bold">{clientSMC?.liquidityPools?.length || 0}</span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-300">Target R:R</span>
              <span className="text-emerald-400 font-bold">
                1 : {typeof rrRatio === 'number' ? rrRatio.toFixed(1) : rrRatio}
              </span>
            </div>

            {effSignal?.score !== undefined && (
              <div className="flex items-center justify-between gap-4 pt-1 border-t border-slate-800/80">
                <span className="text-slate-300">Setup Score</span>
                <span className="text-cyan-400 font-bold">{effSignal.score}/100</span>
              </div>
            )}
          </div>
        )}

        {/* Active Drawing Tool Banner */}
        {activeDrawingTool && (
          <div className="absolute top-2 left-2 bg-cyan-500 text-slate-950 px-3 py-1 rounded-lg text-xs font-mono font-bold shadow-lg flex items-center gap-2">
            <Pencil className="w-3.5 h-3.5" />
            <span>Click on the chart to place {activeDrawingTool.toUpperCase()}</span>
            <button
              onClick={() => setActiveDrawingTool(null)}
              className="ml-2 bg-slate-950 text-white px-1.5 py-0.5 rounded text-[10px]"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
