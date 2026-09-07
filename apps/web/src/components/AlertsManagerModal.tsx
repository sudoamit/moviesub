'use client';

import React, { useState, useEffect } from 'react';
import {
  Bell,
  X,
  Send,
  CheckCircle2,
  Trash2,
  AlertTriangle,
  Zap,
  Radio,
  Sliders,
  Shield,
  Bot,
  MessageSquare,
} from 'lucide-react';

interface AlertsManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AlertsManagerModal: React.FC<AlertsManagerModalProps> = ({ isOpen, onClose }) => {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [channel, setChannel] = useState<'TELEGRAM' | 'DISCORD' | 'WEBHOOK'>('DISCORD');
  const [target, setTarget] = useState<string>('');
  const [minScore, setMinScore] = useState<number>(75);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [testStatus, setTestStatus] = useState<{ success?: boolean; message?: string } | null>(
    null,
  );

  const fetchAlerts = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/alerts');
      const data = await res.json();
      if (Array.isArray(data)) setAlerts(data);
    } catch (e) {
      console.error('Failed to load alerts:', e);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchAlerts();
    }
  }, [isOpen]);

  const handleCreateAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    try {
      setIsSubmitting(true);
      await fetch('http://localhost:3001/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          target,
          minScore: Number(minScore),
          minGrade: minScore >= 90 ? 'A+' : 'A',
          isActive: true,
        }),
      });

      setTarget('');
      setTestStatus({ success: true, message: `✓ ${channel} Alert Rule Saved Successfully!` });
      setTimeout(() => setTestStatus(null), 4000);
      fetchAlerts();
    } catch (err: any) {
      setTestStatus({ success: false, message: `Failed to save alert rule: ${err.message}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTestAlert = async () => {
    if (!target) {
      setTestStatus({
        success: false,
        message: 'Please enter a valid webhook URL or Telegram chat ID.',
      });
      return;
    }
    try {
      setTestStatus({ message: 'Dispatching test notification...' });
      const res = await fetch('http://localhost:3001/api/alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          target,
          symbol: 'NIFTY',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setTestStatus({ success: true, message: `✓ Test Notification Dispatched to ${channel}!` });
      } else {
        setTestStatus({
          success: false,
          message: `❌ Dispatch Failed: ${data.message || 'Check URL/Chat ID'}`,
        });
      }
      setTimeout(() => setTestStatus(null), 6000);
    } catch (e: any) {
      setTestStatus({ success: false, message: `❌ Error: ${e.message}` });
    }
  };

  const handleDeleteAlert = async (id: string) => {
    try {
      await fetch(`http://localhost:3001/api/alerts/${id}`, { method: 'DELETE' });
      fetchAlerts();
    } catch (e) {
      console.error(e);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-[#111827] border border-cyan-500/40 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden font-mono text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-[#0B0F19]">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase text-white flex items-center gap-2">
                MULTI-CHANNEL INSTITUTIONAL ALERTS
                <span className="bg-cyan-500/20 text-cyan-300 text-[10px] px-2 py-0.5 rounded border border-cyan-500/30">
                  REAL-TIME PUSH
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Telegram Bot, Discord Webhooks & Custom Endpoint Dispatcher
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          {/* Channel Selector */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setChannel('DISCORD')}
              className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                channel === 'DISCORD'
                  ? 'bg-indigo-950/80 border-indigo-500 text-indigo-200 shadow-lg shadow-indigo-950/50'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800'
              }`}
            >
              <MessageSquare className="w-5 h-5 text-indigo-400" />
              <span className="text-xs font-bold">Discord Webhook</span>
            </button>

            <button
              type="button"
              onClick={() => setChannel('TELEGRAM')}
              className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                channel === 'TELEGRAM'
                  ? 'bg-sky-950/80 border-sky-500 text-sky-200 shadow-lg shadow-sky-950/50'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Bot className="w-5 h-5 text-sky-400" />
              <span className="text-xs font-bold">Telegram Bot</span>
            </button>

            <button
              type="button"
              onClick={() => setChannel('WEBHOOK')}
              className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                channel === 'WEBHOOK'
                  ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200 shadow-lg shadow-cyan-950/50'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Zap className="w-5 h-5 text-cyan-400" />
              <span className="text-xs font-bold">Custom Webhook</span>
            </button>
          </div>

          {/* Form */}
          <form
            onSubmit={handleCreateAlert}
            className="space-y-4 bg-slate-900/80 p-4 rounded-xl border border-slate-800"
          >
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                {channel === 'DISCORD'
                  ? 'DISCORD WEBHOOK URL:'
                  : channel === 'TELEGRAM'
                    ? 'TELEGRAM CHAT ID / CHANNEL ID:'
                    : 'CUSTOM JSON WEBHOOK ENDPOINT URL:'}
              </label>
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={
                  channel === 'DISCORD'
                    ? 'https://discord.com/api/webhooks/...'
                    : channel === 'TELEGRAM'
                      ? '@your_channel or -100123456789'
                      : 'https://api.yourdomain.com/trading-alerts'
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">
                  MINIMUM CONFLUENCE SCORE:
                </label>
                <select
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value={75}>Score ≥ 75 (Grade A & A+)</option>
                  <option value={85}>Score ≥ 85 (Grade A+ Only)</option>
                  <option value={90}>Score ≥ 90 (Institutional Elite)</option>
                </select>
              </div>

              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={handleTestAlert}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold py-2 rounded-lg text-xs border border-slate-700 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  Test Push
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black py-2 rounded-lg text-xs transition-colors flex items-center justify-center gap-1.5"
                >
                  Save Alert Rule
                </button>
              </div>
            </div>

            {testStatus && (
              <div
                className={`p-2.5 rounded-lg text-xs text-center border ${
                  testStatus.success
                    ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300'
                    : testStatus.success === false
                      ? 'bg-rose-950/80 border-rose-500 text-rose-300'
                      : 'bg-slate-800 text-cyan-300 border-slate-700'
                }`}
              >
                {testStatus.message}
              </div>
            )}
          </form>

          {/* Active Alert Rules List */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              CONFIGURED ALERT DESTINATIONS ({alerts.length})
            </h4>

            {alerts.length === 0 ? (
              <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500">
                No active alert webhooks configured yet. Add your Discord Webhook or Telegram Chat
                above.
              </div>
            ) : (
              <div className="space-y-2">
                {alerts.map((al) => (
                  <div
                    key={al.id}
                    className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded text-[10px] font-bold border border-cyan-500/30">
                        {al.channel}
                      </span>
                      <span className="truncate text-slate-300 max-w-sm">{al.target}</span>
                      <span className="text-[10px] text-slate-500 shrink-0">
                        (Min: {al.minScore}+)
                      </span>
                    </div>

                    <button
                      onClick={() => handleDeleteAlert(al.id)}
                      className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                      title="Delete Alert Rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
