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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = DashboardPage;
const react_1 = __importStar(require("react"));
const dynamic_1 = __importDefault(require("next/dynamic"));
const MarketStreamContext_1 = require("../context/MarketStreamContext");
const Header_1 = require("../components/Header");
const LiveTickerBar_1 = require("../components/LiveTickerBar");
const ScoreGauge_1 = require("../components/ScoreGauge");
const ReasoningCard_1 = require("../components/ReasoningCard");
const RiskWidget_1 = require("../components/RiskWidget");
const TradeJournal_1 = require("../components/TradeJournal");
const LivePositionTracker_1 = require("../components/LivePositionTracker");
const MTFHeatmap_1 = require("../components/MTFHeatmap");
const ScannerTable_1 = require("../components/ScannerTable");
const BacktestDashboard_1 = require("../components/BacktestDashboard");
const SmartStrikeCard_1 = require("../components/SmartStrikeCard");
const OptionChainModal_1 = require("../components/OptionChainModal");
const OptionsSuiteView_1 = require("../components/OptionsSuiteView");
const PaperTradingWidget_1 = require("../components/PaperTradingWidget");
const MultiChartGrid_1 = require("../components/MultiChartGrid");
const CorrelationMatrix_1 = require("../components/CorrelationMatrix");
const AlertsManagerModal_1 = require("../components/AlertsManagerModal");
const AlgoStrategyBuilder_1 = require("../components/AlgoStrategyBuilder");
const MacroCalendarWidget_1 = require("../components/MacroCalendarWidget");
const SMTDivergenceWidget_1 = require("../components/SMTDivergenceWidget");
const MTFFlowRadarWidget_1 = require("../components/MTFFlowRadarWidget");
const AITradeLearningWidget_1 = require("../components/AITradeLearningWidget");
const QuantIntelligencePanel_1 = require("../components/QuantIntelligencePanel");
const LearningEngineDashboard_1 = require("../components/LearningEngineDashboard");
const ResearchStudio_1 = require("../components/ResearchStudio");
const lucide_react_1 = require("lucide-react");
const TradingChart = (0, dynamic_1.default)(() => Promise.resolve().then(() => __importStar(require('../components/TradingChart'))).then((mod) => mod.TradingChart), {
    ssr: false,
    loading: () => (<div className="w-full h-[520px] bg-[#0c121e] rounded-xl flex flex-col items-center justify-center text-slate-500 border border-slate-800 animate-pulse">
        <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-3"></div>
        <p className="text-xs font-mono text-slate-400">
          Loading High-Performance Trading Chart...
        </p>
      </div>),
});
function getInitialCandlesForSymbol(symbol) {
    const basePrice = symbol === 'BTCUSDT'
        ? 79200
        : symbol === 'XAUUSD' || symbol === 'GOLD'
            ? 2885.5
            : symbol === 'BANKNIFTY'
                ? 57450
                : symbol === 'RELIANCE'
                    ? 1285
                    : symbol === 'HDFCBANK'
                        ? 720
                        : symbol === 'INFY'
                            ? 1140
                            : 24150;
    // Fixed deterministic epoch anchor to guarantee 100% deterministic SSR/client hydration match
    const anchorTime = 1756972800000;
    const stepMs = 15 * 60 * 1000;
    const count = 120;
    const result = [];
    let price = basePrice * 0.985;
    for (let i = count; i >= 0; i--) {
        const timestamp = new Date(anchorTime - i * stepMs);
        const change = (Math.sin(i / 6) * 0.0025 + ((i % 5) - 2) * 0.001) * price;
        const open = Number(price.toFixed(2));
        const close = Number((price + change).toFixed(2));
        const high = Number((Math.max(open, close) + 0.0015 * price).toFixed(2));
        const low = Number((Math.min(open, close) - 0.0015 * price).toFixed(2));
        const volume = Math.floor(25000 + ((i * 137) % 30000));
        price = close;
        result.push({ timestamp, open, high, low, close, volume, isClosed: true });
    }
    return result;
}
function DashboardContent() {
    const [mounted, setMounted] = (0, react_1.useState)(false);
    const [activeTab, setActiveTab] = (0, react_1.useState)('terminal');
    const [selectedSymbol, setSelectedSymbol] = (0, react_1.useState)('NIFTY');
    const [selectedTimeframe, setSelectedTimeframe] = (0, react_1.useState)('15m');
    const [selectedStrategy, setSelectedStrategy] = (0, react_1.useState)('SMC');
    const [candles, setCandles] = (0, react_1.useState)(() => getInitialCandlesForSymbol('NIFTY'));
    const [signals, setSignals] = (0, react_1.useState)([]);
    const [selectedSignal, setSelectedSignal] = (0, react_1.useState)(null);
    const [isOptionChainModalOpen, setIsOptionChainModalOpen] = (0, react_1.useState)(false);
    const [isAlertsModalOpen, setIsAlertsModalOpen] = (0, react_1.useState)(false);
    const [isAICopilotModalOpen, setIsAICopilotModalOpen] = (0, react_1.useState)(false);
    const [activeToast, setActiveToast] = (0, react_1.useState)(null);
    const { isConnected, tickers, signals: streamSignals, isScanning, activeToast: streamToast, subscribeToSymbol, triggerScan, showToast, } = (0, MarketStreamContext_1.useMarketStream)();
    (0, react_1.useEffect)(() => {
        setMounted(true);
        if (typeof window !== 'undefined') {
            const savedTab = localStorage.getItem('quant_active_tab');
            const validTabs = [
                'terminal',
                'quant',
                'learning',
                'research',
                'options',
                'multichart',
                'radar',
                'smt',
                'correlation',
                'paper',
                'algo',
                'macro',
                'scanner',
                'backtest',
                'journal',
                'risk',
            ];
            if (savedTab && validTabs.includes(savedTab)) {
                setActiveTab(savedTab);
            }
            const savedSymbol = localStorage.getItem('quant_selected_symbol');
            if (savedSymbol) {
                setSelectedSymbol(savedSymbol);
                setCandles(getInitialCandlesForSymbol(savedSymbol));
            }
            const savedStrat = localStorage.getItem('quant_selected_strategy');
            if (savedStrat === 'SAIYAN_OCC' || savedStrat === 'HYBRID' || savedStrat === 'SMC') {
                setSelectedStrategy(savedStrat);
            }
        }
    }, []);
    // 1. Initial Data Fetching
    const fetchSignals = async (tf = selectedTimeframe, strat = selectedStrategy) => {
        try {
            const res = await fetch(`http://localhost:3001/api/signals?timeframe=${tf}&strategy=${strat}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setSignals(data);
                const current = data.find((s) => s.symbol === selectedSymbol);
                if (current)
                    setSelectedSignal(current);
            }
        }
        catch (e) {
            console.error('Failed to fetch signals:', e);
        }
    };
    const handleSelectStrategy = (strat) => {
        setSelectedStrategy(strat);
        if (typeof window !== 'undefined') {
            localStorage.setItem('quant_selected_strategy', strat);
        }
        const label = strat === 'SMC'
            ? 'Institutional Smart Money Concepts (SMC)'
            : strat === 'SAIYAN_OCC'
                ? 'Saiyan OCC (ALMA Open-Close Cross + Supply/Demand)'
                : 'Hybrid Confluence (SMC + Saiyan OCC)';
        showToast({
            title: '⚡ Strategy Mode Switched',
            message: `Active Engine: ${label}`,
            type: 'info',
        });
        fetchSignals(selectedTimeframe, strat);
    };
    const handleSelectTab = (tab) => {
        setActiveTab(tab);
        if (typeof window !== 'undefined') {
            localStorage.setItem('quant_active_tab', tab);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };
    const fetchCandles = async (sym, tf) => {
        try {
            const res = await fetch(`http://localhost:3001/api/candles/chart-data?symbol=${sym}&timeframe=${tf}&limit=200`);
            const data = await res.json();
            if (data && Array.isArray(data.candles)) {
                const parsedCandles = data.candles.map((c) => ({
                    timestamp: new Date(c.time * 1000),
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume,
                    isClosed: true,
                }));
                setCandles(parsedCandles);
            }
        }
        catch (e) {
            console.error('Failed to fetch chart data:', e);
        }
    };
    (0, react_1.useEffect)(() => {
        fetchSignals(selectedTimeframe, selectedStrategy);
        fetchCandles(selectedSymbol, selectedTimeframe);
        subscribeToSymbol(selectedSymbol);
    }, [selectedSymbol, selectedTimeframe, selectedStrategy, subscribeToSymbol]);
    const handleSelectSymbol = (rawSym) => {
        const s = (rawSym || '').toUpperCase();
        const sym = s === 'BTC' || s === 'BTC/USDT' || s === 'BITCOIN'
            ? 'BTCUSDT'
            : s === 'GOLD' || s === 'XAU' || s === 'XAU/USD' || s === 'SPOTGOLD'
                ? 'XAUUSD'
                : s;
        setSelectedSymbol(sym);
        if (typeof window !== 'undefined') {
            localStorage.setItem('quant_selected_symbol', sym);
        }
        setCandles(getInitialCandlesForSymbol(sym)); // Immediate rich fallback to prevent blank chart
        const signalForSymbol = signals.find((item) => item.symbol === sym);
        setSelectedSignal(signalForSymbol || null);
        fetchCandles(sym, selectedTimeframe);
    };
    const handleTriggerScan = async () => {
        await triggerScan();
        await fetchSignals(selectedTimeframe, selectedStrategy);
    };
    const handleTradeClosedAlert = (trade) => {
        const isTP = trade.state === 'TP2_HIT' || trade.state === 'TP1_HIT';
        setActiveToast({
            title: isTP ? `🎯 Target Hit: ${trade.symbol}` : `🛑 Stop Loss Hit: ${trade.symbol}`,
            message: `Exit @ ₹${Number(trade.exitPrice).toFixed(2)} | Realized PnL: ${trade.pnlAmount >= 0 ? '+' : ''}₹${Number(trade.pnlAmount).toFixed(2)} (${trade.pnlRMultiple}R)`,
            type: isTP ? 'success' : 'danger',
        });
        setTimeout(() => setActiveToast(null), 8000);
        fetchSignals(selectedTimeframe);
    };
    const defaultPrice = selectedSymbol === 'BTCUSDT'
        ? 79230.0
        : selectedSymbol === 'XAUUSD' || selectedSymbol === 'GOLD'
            ? 2885.5
            : selectedSymbol === 'BANKNIFTY'
                ? 57496.3
                : 24175.65;
    const currentTicker = tickers[selectedSymbol] || {
        symbol: selectedSymbol,
        price: candles.length > 0 &&
            ((selectedSymbol === 'BTCUSDT' && candles[candles.length - 1].close > 50000) ||
                (selectedSymbol === 'XAUUSD' &&
                    candles[candles.length - 1].close > 2000 &&
                    candles[candles.length - 1].close < 4000) ||
                (selectedSymbol !== 'BTCUSDT' &&
                    selectedSymbol !== 'XAUUSD' &&
                    candles[candles.length - 1].close < 60000))
            ? candles[candles.length - 1].close
            : defaultPrice,
        changePercent: 0,
        changeAmount: 0,
        high: 0,
        low: 0,
        volume: 0,
        isRealTime: true,
    };
    const isPositionActive = (0, react_1.useMemo)(() => {
        if (!selectedSignal)
            return false;
        const direction = selectedSignal.direction || 'BEARISH';
        if (typeof window !== 'undefined' &&
            localStorage.getItem(`quant_pos_cut_${selectedSymbol}_${direction}`) === 'true') {
            return false;
        }
        if (selectedSignal.state === 'SL_HIT' ||
            selectedSignal.state === 'TP2_HIT' ||
            selectedSignal.state === 'TP1_HIT' ||
            selectedSignal.state === 'TP3_HIT') {
            return false;
        }
        const currentCMP = currentTicker.price ||
            (candles.length > 0 ? candles[candles.length - 1].close : selectedSignal.entryZone.optimal);
        if (!currentCMP || !selectedSignal.stopLoss)
            return true;
        const isBull = selectedSignal.direction === 'BULLISH';
        const isSLReached = isBull
            ? currentCMP <= selectedSignal.stopLoss
            : currentCMP >= selectedSignal.stopLoss;
        if (isSLReached)
            return false;
        const tp2 = selectedSignal.takeProfits?.tp2;
        const tp3 = selectedSignal.takeProfits?.tp3;
        const isTPReached = isBull
            ? (tp3 && currentCMP >= tp3) || (tp2 && currentCMP >= tp2)
            : (tp3 && currentCMP <= tp3) || (tp2 && currentCMP <= tp2);
        if (isTPReached)
            return false;
        return true;
    }, [selectedSignal, currentTicker.price, candles, selectedSymbol]);
    return (<div className="min-h-screen bg-[#0A0E17] text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      <Header_1.Header activeTab={activeTab} onSelectTab={handleSelectTab} isConnected={isConnected} onTriggerScan={handleTriggerScan} isScanning={isScanning} selectedStrategy={selectedStrategy} onSelectStrategy={handleSelectStrategy} onOpenAlertsModal={() => setIsAlertsModalOpen(true)} onOpenAICopilotModal={() => setIsAICopilotModalOpen(true)}/>

      {/* Real-time Tickers Bar with Live Market Quotes */}
      <LiveTickerBar_1.LiveTickerBar tickers={tickers} selectedSymbol={selectedSymbol} onSelectSymbol={handleSelectSymbol}/>

      {/* Global Toast Notification */}
      {activeToast && (<div className="fixed top-20 right-6 z-50 animate-in fade-in slide-in-from-top-4 duration-300 max-w-md">
          <div className={`p-4 rounded-xl border shadow-2xl backdrop-blur-md font-mono ${activeToast.type === 'danger'
                ? 'bg-rose-950/90 border-rose-500/80 text-rose-200'
                : activeToast.type === 'success'
                    ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-200'
                    : 'bg-slate-900/90 border-cyan-500/80 text-cyan-200'}`}>
            <div className="flex items-start gap-3">
              {activeToast.type === 'danger' ? (<lucide_react_1.ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5"/>) : activeToast.type === 'success' ? (<lucide_react_1.CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5"/>) : (<lucide_react_1.Zap className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5"/>)}
              <div>
                <h4 className="font-bold text-xs uppercase tracking-wide">{activeToast.title}</h4>
                <p className="text-xs mt-1 text-slate-300">{activeToast.message}</p>
              </div>
            </div>
          </div>
        </div>)}

      {/* Main Content Workspace */}
      <main className="flex-1 p-3 sm:p-5 max-w-[1720px] mx-auto w-full space-y-5">
        {/* TAB 1: LIVE TERMINAL */}
        {activeTab === 'terminal' && (<div className="space-y-5">
            {/* Active Strategy Selector Bar */}
            <div className="bg-[#111827]/80 backdrop-blur-md border border-slate-800 rounded-xl p-3 shadow-lg flex flex-wrap items-center justify-between gap-3 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <lucide_react_1.Sliders className="w-3.5 h-3.5 text-cyan-400"/>
                  Trading Strategy Engine:
                </span>
                <span className="text-xs font-black text-white px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                  {selectedStrategy === 'SMC'
                ? '🏛️ Institutional Smart Money Concepts (SMC)'
                : selectedStrategy === 'SAIYAN_OCC'
                    ? '⚡ Saiyan OCC (ALMA Open-Close Cross + Supply/Demand)'
                    : '🛡️ Hybrid Confluence (SMC + Saiyan OCC Momentum)'}
                </span>
              </div>

              <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                <button onClick={() => handleSelectStrategy('SMC')} className={`px-3 py-1 rounded-md font-bold transition-all flex items-center gap-1.5 ${selectedStrategy === 'SMC'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20 scale-[1.02]'
                : 'text-slate-400 hover:text-slate-200'}`}>
                  <lucide_react_1.Sparkles className="w-3.5 h-3.5"/> Institutional SMC
                </button>
                <button onClick={() => handleSelectStrategy('SAIYAN_OCC')} className={`px-3 py-1 rounded-md font-bold transition-all flex items-center gap-1.5 ${selectedStrategy === 'SAIYAN_OCC'
                ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/20 scale-[1.02]'
                : 'text-slate-400 hover:text-slate-200'}`}>
                  <lucide_react_1.Zap className="w-3.5 h-3.5 text-amber-950"/> Saiyan OCC + S/D
                </button>
                <button onClick={() => handleSelectStrategy('HYBRID')} className={`px-3 py-1 rounded-md font-bold transition-all flex items-center gap-1.5 ${selectedStrategy === 'HYBRID'
                ? 'bg-emerald-400 text-slate-950 shadow-md shadow-emerald-400/20 scale-[1.02]'
                : 'text-slate-400 hover:text-slate-200'}`}>
                  <lucide_react_1.ShieldAlert className="w-3.5 h-3.5"/> Hybrid Confluence
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 space-y-4">
                <TradingChart symbol={selectedSymbol} timeframe={selectedTimeframe} candles={candles} signal={selectedSignal} livePrice={currentTicker.price} liveChangePercent={currentTicker.changePercent} isTradeActive={isPositionActive} onTimeframeChange={setSelectedTimeframe} onSymbolChange={handleSelectSymbol}/>
                {(selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY') && (<SmartStrikeCard_1.SmartStrikeCard symbol={selectedSymbol} direction={selectedSignal?.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH'} spotPrice={currentTicker.price} onOpenChain={() => setIsOptionChainModalOpen(true)}/>)}
              </div>
              <div className="space-y-5">
                <ScoreGauge_1.ScoreGauge score={selectedSignal?.score || 0} grade={selectedSignal?.grade || 'NO_TRADE'} breakdown={selectedSignal?.scoreBreakdown}/>
                <MTFHeatmap_1.MTFHeatmap selectedSymbol={selectedSymbol} onSelectSymbol={handleSelectSymbol} signals={signals}/>
              </div>
            </div>

            {/* Live Active Position Tracker (Running PnL, Trailing SL, 50% Scale-Out) */}
            <LivePositionTracker_1.LivePositionTracker symbol={selectedSymbol} signal={selectedSignal} livePrice={currentTicker.price} onClosePosition={(exitP, pnl, r, reason) => {
                handleTradeClosedAlert({
                    symbol: selectedSymbol,
                    direction: selectedSignal?.direction || 'BULLISH',
                    state: r >= 2.5 ? 'TP2_HIT' : r >= 1.5 ? 'TP1_HIT' : 'SL_HIT',
                    exitPrice: exitP,
                    pnlAmount: pnl,
                    pnlRMultiple: r,
                });
            }}/>

            {/* Quant Intelligence Engine Panel */}
            <QuantIntelligencePanel_1.QuantIntelligencePanel currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price}/>

            {/* Middle Row: Reasoning Card & Risk Management Widget */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <ReasoningCard_1.ReasoningCard signal={selectedSignal}/>
              <RiskWidget_1.RiskWidget selectedSignal={selectedSignal}/>
            </div>

            {/* Bottom Row: Completed Trades History & Journal */}
            <div>
              <TradeJournal_1.TradeJournal currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price} onTradeClosedNotification={handleTradeClosedAlert}/>
            </div>
          </div>)}

        {/* TAB: QUANT INTELLIGENCE FULL COMMAND CENTER */}
        {activeTab === 'quant' && (<div className="space-y-5">
            <QuantIntelligencePanel_1.QuantIntelligencePanel currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price}/>
          </div>)}

        {/* TAB: AI TRADE LEARNING & SELF-IMPROVING ENGINE COMMAND CENTER */}
        {activeTab === 'learning' && (<div className="space-y-6">
            <LearningEngineDashboard_1.LearningEngineDashboard />
            <AITradeLearningWidget_1.AITradeLearningWidget initialSymbol={selectedSymbol}/>
          </div>)}

        {/* TAB: QUANT RESEARCH LAB & SELF-IMPROVEMENT SUITE */}
        {activeTab === 'research' && (<div className="space-y-6">
            <ResearchStudio_1.ResearchStudio />
          </div>)}

        {/* TAB 2: OPTIONS SUITE & DERIVATIVES MATRIX */}
        {activeTab === 'options' && (<div className="space-y-5">
            <OptionsSuiteView_1.OptionsSuiteView initialSymbol={selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY'
                ? selectedSymbol
                : 'NIFTY'} liveSpotPrice={tickers[selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY'
                ? selectedSymbol
                : 'NIFTY']?.price || currentTicker.price}/>
          </div>)}

        {/* TAB 3: MULTI-CHART GRID (Dual & Quad Views) */}
        {activeTab === 'multichart' && (<div className="space-y-5">
            <MultiChartGrid_1.MultiChartGrid signals={signals} tickers={tickers}/>
          </div>)}

        {/* TAB: 4-TIER MULTI-TIMEFRAME ORDER FLOW RADAR */}
        {activeTab === 'radar' && (<div className="space-y-5">
            <MTFFlowRadarWidget_1.MTFFlowRadarWidget symbol={selectedSymbol}/>
          </div>)}

        {/* TAB: SMT CORRELATION DIVERGENCE RADAR */}
        {activeTab === 'smt' && (<div className="space-y-5">
            <SMTDivergenceWidget_1.SMTDivergenceWidget />
          </div>)}

        {/* TAB 4: HEAVYWEIGHT CORRELATION MATRIX */}
        {activeTab === 'correlation' && (<div className="space-y-5">
            <CorrelationMatrix_1.CorrelationMatrix tickers={tickers}/>
          </div>)}

        {/* TAB 5: PAPER TRADING SIMULATOR */}
        {activeTab === 'paper' && (<div className="space-y-5">
            <PaperTradingWidget_1.PaperTradingWidget currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price}/>
          </div>)}

        {/* TAB 6: NO-CODE ALGO STRATEGY STUDIO */}
        {activeTab === 'algo' && (<div className="space-y-5">
            <AlgoStrategyBuilder_1.AlgoStrategyBuilder />
          </div>)}

        {/* TAB 7: MACRO CALENDAR & INDIA VIX VOLATILITY GUARD */}
        {activeTab === 'macro' && (<div className="space-y-5">
            <MacroCalendarWidget_1.MacroCalendarWidget />
          </div>)}

        {/* TAB 8: TRADE JOURNAL */}
        {activeTab === 'journal' && (<div className="space-y-5">
            <TradeJournal_1.TradeJournal currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price} onTradeClosedNotification={handleTradeClosedAlert}/>
          </div>)}

        {/* TAB 7: SCANNER MATRIX */}
        {activeTab === 'scanner' && (<div className="space-y-5">
            <ScannerTable_1.ScannerTable signals={signals} selectedSymbol={selectedSymbol} onSelectSignal={(s) => {
                setSelectedSymbol(s.symbol);
                setSelectedSignal(s);
                handleSelectTab('terminal');
            }} onRefreshScan={handleTriggerScan} isScanning={isScanning}/>
            <MTFHeatmap_1.MTFHeatmap selectedSymbol={selectedSymbol} onSelectSymbol={handleSelectSymbol}/>
          </div>)}

        {/* TAB 8: STRATEGY BACKTEST */}
        {activeTab === 'backtest' && (<div className="space-y-5">
            <BacktestDashboard_1.BacktestDashboard initialSymbol={selectedSymbol}/>
          </div>)}

        {/* TAB 9: RISK ENGINE */}
        {activeTab === 'risk' && (<div className="space-y-5 max-w-3xl mx-auto">
            <RiskWidget_1.RiskWidget selectedSignal={selectedSignal}/>
            <ReasoningCard_1.ReasoningCard signal={selectedSignal}/>
          </div>)}
      </main>

      {/* Option Chain Modal */}
      <OptionChainModal_1.OptionChainModal isOpen={isOptionChainModalOpen} onClose={() => setIsOptionChainModalOpen(false)} symbol={selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY' ? selectedSymbol : 'NIFTY'} spotPrice={tickers[selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY' ? selectedSymbol : 'NIFTY']?.price || currentTicker.price}/>

      {/* Multi-Channel Alerts Manager Modal */}
      <AlertsManagerModal_1.AlertsManagerModal isOpen={isAlertsModalOpen} onClose={() => setIsAlertsModalOpen(false)}/>

      {/* Toast Notification */}
      {(streamToast || activeToast) && (<div className="fixed bottom-5 right-5 z-50 max-w-sm w-full bg-[#111827]/95 backdrop-blur-md border border-cyan-500/50 rounded-xl p-4 shadow-2xl flex items-start gap-3 animate-in slide-in-from-bottom-5 font-mono">
          <lucide_react_1.Zap className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5"/>
          <div className="flex-1">
            <h4 className="text-xs font-bold text-white uppercase">
              {(streamToast || activeToast)?.title}
            </h4>
            <p className="text-xs text-slate-300 mt-0.5">{(streamToast || activeToast)?.message}</p>
          </div>
        </div>)}

      <footer className="border-t border-slate-800/80 bg-[#0B0F19] px-5 py-3 text-center text-xs text-slate-500 font-mono">
        QUANT INTELLIGENCE PLATFORM • REAL-TIME MARKET STRUCTURE & SMC ENGINE • NOT FINANCIAL ADVICE
      </footer>
    </div>);
}
function DashboardPage() {
    return (<MarketStreamContext_1.MarketStreamProvider>
      <DashboardContent />
    </MarketStreamContext_1.MarketStreamProvider>);
}
//# sourceMappingURL=page.js.map