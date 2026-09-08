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
exports.Header = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const Header = ({ activeTab, onSelectTab, isConnected, onTriggerScan, isScanning, selectedStrategy = 'SMC', onSelectStrategy, onOpenAlertsModal, onOpenAICopilotModal, }) => {
    const [timeString, setTimeString] = (0, react_1.useState)('');
    (0, react_1.useEffect)(() => {
        const updateTime = () => {
            const now = new Date();
            setTimeString(now.toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }));
        };
        updateTime();
        const interval = setInterval(updateTime, 1000);
        return () => clearInterval(interval);
    }, []);
    const navItems = [
        { id: 'terminal', label: 'Terminal', icon: <lucide_react_1.Activity className="w-3.5 h-3.5"/> },
        {
            id: 'quant',
            label: 'Quant Intelligence',
            icon: <lucide_react_1.BrainCircuit className="w-3.5 h-3.5 text-cyan-400"/>,
            badge: 'v2.0',
        },
        {
            id: 'learning',
            label: 'AI Learning',
            icon: <lucide_react_1.Brain className="w-3.5 h-3.5 text-cyan-400"/>,
            badge: 'ML',
        },
        {
            id: 'research',
            label: 'Research Lab',
            icon: <lucide_react_1.FlaskConical className="w-3.5 h-3.5 text-emerald-400"/>,
            badge: 'OOS',
        },
        {
            id: 'options',
            label: 'Options Suite',
            icon: <lucide_react_1.Layers className="w-3.5 h-3.5"/>,
            badge: 'BSM',
        },
        { id: 'multichart', label: 'Multi-Chart', icon: <lucide_react_1.Grid2X2 className="w-3.5 h-3.5"/> },
        {
            id: 'radar',
            label: 'Flow Radar',
            icon: <lucide_react_1.Compass className="w-3.5 h-3.5"/>,
            badge: '4-Tier',
        },
        { id: 'smt', label: 'SMT Divergence', icon: <lucide_react_1.Sliders className="w-3.5 h-3.5"/> },
        { id: 'correlation', label: 'Correlation', icon: <lucide_react_1.PieChart className="w-3.5 h-3.5"/> },
        { id: 'paper', label: 'Paper Trading', icon: <lucide_react_1.Wallet className="w-3.5 h-3.5"/> },
        { id: 'algo', label: 'Algo Bots', icon: <lucide_react_1.Cpu className="w-3.5 h-3.5"/>, badge: 'AUTO' },
        { id: 'macro', label: 'Macro Calendar', icon: <lucide_react_1.Clock className="w-3.5 h-3.5"/> },
        { id: 'scanner', label: 'SMC Scanner', icon: <lucide_react_1.Search className="w-3.5 h-3.5"/> },
        { id: 'backtest', label: 'Backtesting', icon: <lucide_react_1.BarChart2 className="w-3.5 h-3.5"/> },
        { id: 'journal', label: 'Journal', icon: <lucide_react_1.BookOpen className="w-3.5 h-3.5"/> },
        { id: 'risk', label: 'Risk Desk', icon: <lucide_react_1.Shield className="w-3.5 h-3.5"/> },
    ];
    return (<header className="border-b border-slate-800/80 bg-[#080C14]/90 backdrop-blur-xl sticky top-0 z-50 px-3 sm:px-6 py-2.5 shadow-2xl">
      <div className="flex flex-col xl:flex-row items-center justify-between gap-3">
        {/* Brand & Market Status */}
        <div className="flex items-center justify-between w-full xl:w-auto gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-teal-400 to-emerald-400 flex items-center justify-center shadow-lg shadow-cyan-500/25 ring-1 ring-white/20">
                <lucide_react_1.Zap className="w-5 h-5 text-slate-950 fill-current"/>
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[#080C14] animate-pulse"/>
            </div>

            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm sm:text-base font-black tracking-wider text-white uppercase font-mono">
                  QUANT INTELLIGENCE{' '}
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-emerald-400">
                    PRO
                  </span>
                </h1>
                <span className="text-[9px] font-bold bg-cyan-950/80 text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 rounded">
                  v2.8
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-mono tracking-tight flex items-center gap-1">
                <span>Institutional SMC & Volatility Terminal</span>
                <span className="text-slate-600">•</span>
                <span className="text-emerald-400 font-bold" suppressHydrationWarning>
                  {timeString ? `${timeString} IST` : '09:15-15:30'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Strategy Selection Switcher */}
            {onSelectStrategy && (<div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-[10px] font-mono font-bold shadow-inner">
                <button type="button" onClick={() => onSelectStrategy('SMC')} className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${selectedStrategy === 'SMC'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-white'}`} title="Institutional Smart Money Concepts">
                  <lucide_react_1.Sparkles className="w-3 h-3"/> SMC
                </button>
                <button type="button" onClick={() => onSelectStrategy('SAIYAN_OCC')} className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${selectedStrategy === 'SAIYAN_OCC'
                ? 'bg-amber-400 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-white'}`} title="Saiyan OCC ALMA Open-Close Cross + Supply/Demand">
                  <lucide_react_1.Zap className="w-3 h-3 text-amber-900"/> SAIYAN OCC
                </button>
                <button type="button" onClick={() => onSelectStrategy('HYBRID')} className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${selectedStrategy === 'HYBRID'
                ? 'bg-emerald-400 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-white'}`} title="Hybrid Confluence: SMC + Saiyan OCC Confirmation">
                  <lucide_react_1.Shield className="w-3 h-3"/> HYBRID
                </button>
              </div>)}

            {/* Live WS Status Pill */}
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] font-mono">
              <span className="flex h-2 w-2 relative">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`}/>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`}/>
              </span>
              <span className="text-[10px] text-slate-300 font-bold">
                {isConnected ? 'LIVE FEED' : 'RECONNECTING'}
              </span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs Bar */}
        <div className="w-full xl:w-auto overflow-x-auto pb-1 xl:pb-0 scrollbar-none">
          <div className="flex items-center gap-1 bg-slate-950/80 border border-slate-800/90 rounded-xl p-1 text-xs font-mono min-w-max shadow-inner">
            {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (<button type="button" key={item.id} onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectTab(item.id);
                }} className={`px-2.5 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 relative whitespace-nowrap ${isActive
                    ? 'bg-gradient-to-r from-cyan-500 to-teal-400 text-slate-950 shadow-md shadow-cyan-500/25 scale-[1.02]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'}`}>
                  {item.icon}
                  <span>{item.label}</span>
                  {item.badge && (<span className={`text-[8px] px-1 py-0.5 rounded font-black ${isActive
                        ? 'bg-slate-950 text-cyan-300'
                        : 'bg-cyan-950/80 text-cyan-400 border border-cyan-800/60'}`}>
                      {item.badge}
                    </span>)}
                </button>);
        })}
          </div>
        </div>

        {/* Right Action Trigger Buttons (Desktop) */}
        <div className="hidden xl:flex items-center gap-2.5">
          {/* AI Copilot Button */}
          {onOpenAICopilotModal && (<button type="button" onClick={onOpenAICopilotModal} className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-violet-600/20 via-purple-600/20 to-indigo-600/20 hover:from-violet-600/30 hover:to-indigo-600/30 text-purple-300 border border-purple-500/40 hover:border-purple-400 text-xs font-mono font-bold flex items-center gap-1.5 transition-all shadow-sm hover:shadow-purple-500/20">
              <lucide_react_1.Brain className="w-3.5 h-3.5 text-purple-400"/>
              <span>AI Copilot</span>
              <span className="text-[9px] bg-purple-950 text-purple-300 px-1 py-0.5 rounded border border-purple-800">
                ⌘K
              </span>
            </button>)}

          {/* Alerts Button */}
          {onOpenAlertsModal && (<button type="button" onClick={onOpenAlertsModal} className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 hover:text-cyan-300 transition-all text-xs relative" title="Manage Trading Alerts">
              <lucide_react_1.Bell className="w-4 h-4"/>
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-cyan-400 animate-pulse"/>
            </button>)}

          {/* 1-Click Scan Button */}
          <button type="button" onClick={onTriggerScan} disabled={isScanning} className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-black text-xs font-mono flex items-center gap-1.5 transition-all shadow-lg shadow-cyan-500/20 active:scale-95 disabled:opacity-50">
            <lucide_react_1.Radio className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`}/>
            <span>{isScanning ? 'SCANNING...' : 'SCAN ALL'}</span>
          </button>
        </div>
      </div>

      {/* Mobile Actions Bar */}
      <div className="flex xl:hidden items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-800/60">
        <button type="button" onClick={onTriggerScan} disabled={isScanning} className="flex-1 py-1 px-3 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-950 font-black text-xs font-mono flex items-center justify-center gap-1.5 shadow-sm">
          <lucide_react_1.Radio className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`}/>
          <span>{isScanning ? 'SCANNING...' : 'SCAN ALL'}</span>
        </button>

        {onOpenAICopilotModal && (<button type="button" onClick={onOpenAICopilotModal} className="py-1 px-3 rounded-lg bg-purple-950/80 border border-purple-500/40 text-purple-300 font-bold text-xs font-mono flex items-center gap-1.5">
            <lucide_react_1.Brain className="w-3.5 h-3.5 text-purple-400"/>
            <span>AI Copilot</span>
          </button>)}

        {onOpenAlertsModal && (<button type="button" onClick={onOpenAlertsModal} className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300" title="Manage Alerts">
            <lucide_react_1.Bell className="w-4 h-4 text-cyan-400"/>
          </button>)}
      </div>
    </header>);
};
exports.Header = Header;
//# sourceMappingURL=Header.js.map