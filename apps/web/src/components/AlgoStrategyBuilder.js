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
exports.AlgoStrategyBuilder = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const AlgoStrategyBuilder = () => {
    const [bots, setBots] = (0, react_1.useState)([]);
    const [isLoading, setIsLoading] = (0, react_1.useState)(true);
    const [isCreating, setIsCreating] = (0, react_1.useState)(false);
    // Form State
    const [botName, setBotName] = (0, react_1.useState)('');
    const [symbol, setSymbol] = (0, react_1.useState)('NIFTY');
    const [direction, setDirection] = (0, react_1.useState)('ANY');
    const [timeframe, setTimeframe] = (0, react_1.useState)('15m');
    const [minScore, setMinScore] = (0, react_1.useState)(80);
    const [smcCondition, setSmcCondition] = (0, react_1.useState)('ORDER_BLOCK');
    const [lots, setLots] = (0, react_1.useState)(1);
    const [autoExecutePaper, setAutoExecutePaper] = (0, react_1.useState)(true);
    const [notifyWebhook, setNotifyWebhook] = (0, react_1.useState)(true);
    const [statusMsg, setStatusMsg] = (0, react_1.useState)(null);
    const fetchBots = async () => {
        try {
            setIsLoading(true);
            const res = await fetch('http://localhost:3001/api/algo-bots');
            const data = await res.json();
            if (Array.isArray(data))
                setBots(data);
        }
        catch (e) {
            console.error('Failed to load algo bots:', e);
        }
        finally {
            setIsLoading(false);
        }
    };
    (0, react_1.useEffect)(() => {
        fetchBots();
    }, []);
    const handleCreateBot = async (e) => {
        e.preventDefault();
        try {
            setIsCreating(true);
            const res = await fetch('http://localhost:3001/api/algo-bots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: botName || `${symbol} ${timeframe} ${direction} ${smcCondition} Bot`,
                    symbol,
                    direction,
                    timeframe,
                    minScore: Number(minScore),
                    smcCondition,
                    lots: Number(lots),
                    autoExecutePaper,
                    notifyWebhook,
                }),
            });
            const data = await res.json();
            setStatusMsg(`✓ Automated Algorithmic Strategy '${data.name}' Created & Deployed!`);
            setTimeout(() => setStatusMsg(null), 5000);
            setBotName('');
            fetchBots();
        }
        catch (err) {
            setStatusMsg(`❌ Failed to deploy strategy: ${err.message}`);
        }
        finally {
            setIsCreating(false);
        }
    };
    const handleToggleBot = async (id) => {
        try {
            await fetch(`http://localhost:3001/api/algo-bots/${id}/toggle`, { method: 'POST' });
            fetchBots();
        }
        catch (e) {
            console.error(e);
        }
    };
    const handleDeleteBot = async (id) => {
        try {
            await fetch(`http://localhost:3001/api/algo-bots/${id}`, { method: 'DELETE' });
            fetchBots();
        }
        catch (e) {
            console.error(e);
        }
    };
    return (<div className="space-y-5 font-mono">
      {/* Header Banner */}
      <div className="bg-[#111827]/95 backdrop-blur-md border border-cyan-500/30 rounded-xl p-5 shadow-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <lucide_react_1.Bot className="w-5 h-5"/>
            </div>
            <div>
              <h3 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
                NO-CODE ALGORITHMIC STRATEGY STUDIO & BOT RUNNER
                <span className="bg-cyan-500/20 text-cyan-300 text-[9px] px-2 py-0.5 rounded border border-cyan-500/30">
                  REAL-TIME AUTOPILOT
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Build custom Smart Money Concept logic and auto-execute paper orders
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Active Bots Running:</span>
            <strong className="text-emerald-400">
              {bots.filter((b) => b.isActive).length} / {bots.length}
            </strong>
          </div>
        </div>

        {/* Visual Strategy Composer Form */}
        <form onSubmit={handleCreateBot} className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-300 border-b border-slate-800/80 pb-2">
            <lucide_react_1.Plus className="w-4 h-4 text-cyan-400"/>
            <span>COMPOSE NEW ALGORITHMIC EXECUTION RULE:</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                STRATEGY NAME (OPTIONAL):
              </label>
              <input type="text" value={botName} onChange={(e) => setBotName(e.target.value)} placeholder="e.g. NIFTY Premium Sweeper" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"/>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                TARGET ASSET / SYMBOL:
              </label>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500">
                <option value="NIFTY">NIFTY 50 Index</option>
                <option value="BANKNIFTY">BANKNIFTY Index</option>
                <option value="BTCUSDT">BTCUSDT Crypto</option>
                <option value="XAUUSD">XAUUSD Gold Spot</option>
                <option value="RELIANCE">RELIANCE Industries</option>
                <option value="HDFCBANK">HDFC Bank Ltd.</option>
                <option value="INFY">INFOSYS Ltd.</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                DIRECTION BIAS:
              </label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500">
                <option value="ANY">Any Direction (Long & Short)</option>
                <option value="BULLISH">Bullish Long Only</option>
                <option value="BEARISH">Bearish Short Only</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                SMC TRIGGER REQUIREMENT:
              </label>
              <select value={smcCondition} onChange={(e) => setSmcCondition(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500">
                <option value="ORDER_BLOCK">Institutional Order Block</option>
                <option value="FVG">Fair Value Gap Inversion</option>
                <option value="LIQUIDITY_SWEEP">High/Low Liquidity Sweep</option>
                <option value="ANY_CONFLUENCE">Any Multi-Confluence</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-1">
            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                MIN CONFLUENCE SCORE:
              </label>
              <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500">
                <option value={75}>Score ≥ 75 (Grade A & A+)</option>
                <option value={80}>Score ≥ 80 (High Quality)</option>
                <option value={85}>Score ≥ 85 (Grade A+ Only)</option>
                <option value={90}>Score ≥ 90 (Institutional Elite)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 font-bold mb-1">
                AUTO ORDER SIZE:
              </label>
              <select value={lots} onChange={(e) => setLots(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-cyan-500">
                <option value={1}>
                  1 Lot ({symbol === 'NIFTY' ? 65 : symbol === 'BANKNIFTY' ? 15 : 100} Qty)
                </option>
                <option value={2}>
                  2 Lots ({symbol === 'NIFTY' ? 130 : symbol === 'BANKNIFTY' ? 30 : 200} Qty)
                </option>
                <option value={5}>
                  5 Lots ({symbol === 'NIFTY' ? 325 : symbol === 'BANKNIFTY' ? 75 : 500} Qty)
                </option>
              </select>
            </div>

            <div className="flex items-end">
              <button type="submit" disabled={isCreating} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black py-2 rounded-lg text-xs transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-cyan-500/20 disabled:opacity-50">
                <lucide_react_1.Zap className="w-3.5 h-3.5"/>
                {isCreating ? 'Deploying...' : 'Deploy Algorithmic Bot'}
              </button>
            </div>
          </div>

          {statusMsg && (<div className="p-2.5 rounded-lg bg-slate-950 border border-cyan-500/40 text-cyan-300 text-xs text-center">
              {statusMsg}
            </div>)}
        </form>

        {/* Active Bots Matrix */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <lucide_react_1.Layers className="w-3.5 h-3.5 text-cyan-400"/>
            DEPLOYED ALGORITHMIC STRATEGIES ({bots.length})
          </h4>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {bots.map((bot) => (<div key={bot.id} className={`p-4 rounded-xl border transition-all ${bot.isActive
                ? 'bg-slate-900/90 border-cyan-500/40 shadow-lg shadow-cyan-950/20'
                : 'bg-slate-950/60 border-slate-800 opacity-60'}`}>
                <div className="flex items-start justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                  <div>
                    <span className="text-xs font-black text-white block">{bot.name}</span>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="bg-cyan-500/20 text-cyan-300 text-[9px] px-1.5 py-0.5 rounded font-bold border border-cyan-500/30">
                        {bot.symbol}
                      </span>
                      <span className="bg-slate-800 text-slate-300 text-[9px] px-1.5 py-0.5 rounded">
                        {bot.direction}
                      </span>
                      <span className="bg-slate-800 text-slate-300 text-[9px] px-1.5 py-0.5 rounded">
                        {bot.timeframe}
                      </span>
                    </div>
                  </div>

                  <button onClick={() => handleToggleBot(bot.id)} className={`p-1.5 rounded-lg border transition-colors ${bot.isActive
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-700 hover:bg-emerald-900'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'}`} title={bot.isActive ? 'Pause Bot' : 'Activate Bot'}>
                    {bot.isActive ? (<lucide_react_1.Pause className="w-3.5 h-3.5"/>) : (<lucide_react_1.Play className="w-3.5 h-3.5"/>)}
                  </button>
                </div>

                <div className="py-2.5 space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-500">Condition:</span>
                    <strong className="text-white">{bot.smcCondition}</strong>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-500">Min Score:</span>
                    <strong className="text-cyan-300">≥ {bot.minScore}/100</strong>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-500">Auto Execution:</span>
                    <strong className="text-emerald-400">{bot.lots} Lot(s) Paper Trading</strong>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-500">Total Triggers:</span>
                    <strong className="text-white">{bot.triggerCount} Executions</strong>
                  </div>
                </div>

                {bot.lastTriggerDetails && (<div className="p-2 rounded bg-slate-950 border border-slate-800/80 text-[10px] text-slate-400">
                    <span className="text-cyan-400 font-bold block">Last Trigger:</span>
                    <p className="truncate mt-0.5">{bot.lastTriggerDetails}</p>
                  </div>)}

                <div className="pt-2 mt-2 border-t border-slate-800 flex items-center justify-between text-[10px]">
                  <span className={bot.isActive ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                    {bot.isActive ? '● BOT RUNNING LIVE' : '○ BOT PAUSED'}
                  </span>
                  <button onClick={() => handleDeleteBot(bot.id)} className="text-slate-500 hover:text-rose-400 transition-colors p-1" title="Delete Bot">
                    <lucide_react_1.Trash2 className="w-3.5 h-3.5"/>
                  </button>
                </div>
              </div>))}
          </div>
        </div>
      </div>
    </div>);
};
exports.AlgoStrategyBuilder = AlgoStrategyBuilder;
//# sourceMappingURL=AlgoStrategyBuilder.js.map