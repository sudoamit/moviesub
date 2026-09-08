"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var TelegramDispatcher_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramDispatcher = void 0;
const common_1 = require("@nestjs/common");
let TelegramDispatcher = TelegramDispatcher_1 = class TelegramDispatcher {
    logger = new common_1.Logger(TelegramDispatcher_1.name);
    botToken = process.env.TELEGRAM_BOT_TOKEN;
    async dispatchAlert(chatId, signal) {
        const isBull = signal.direction === 'BULLISH';
        const dirEmoji = isBull ? '🟢 LONG' : '🔴 SHORT';
        const gradeEmoji = signal.grade === 'A+' ? '🌟' : '⭐';
        const text = [
            `🚨 *QUANT TRADE ALERT: ${signal.symbol}*`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `*Action:* ${dirEmoji} [${signal.timeframe}]`,
            `*Score:* ${signal.score}/100 (${gradeEmoji} Grade ${signal.grade})`,
            ``,
            `🎯 *Trade Levels:*`,
            `• *Optimal Entry:* \`${signal.entryZone.optimal}\``,
            `• *Stop Loss:* \`${signal.stopLoss}\``,
            `• *Target 1 (1.5R):* \`${signal.takeProfits.tp1}\``,
            `• *Target 2 (2.5R):* \`${signal.takeProfits.tp2}\``,
            `• *Risk-to-Reward:* \`1:${signal.riskRewardRatios.rr2}\``,
            ``,
            `🧠 *Quantitative Rationale:*`,
            `_${signal.reasoning.summary}_`,
            ``,
            `✅ *Confirmed Checklist:*`,
            ...(signal.reasoning.confirmedChecklist || []).map((c) => `• ${c}`),
            `━━━━━━━━━━━━━━━━━━━━`,
            `⚠️ _Analytical alert only. Follow strict risk management._`,
        ].join('\n');
        if (!this.botToken) {
            this.logger.log(`[TELEGRAM MOCK DISPATCH] -> Chat: ${chatId} | Alert: ${signal.symbol} (${signal.direction} Grade ${signal.grade})`);
            return { success: true, messageId: `mock-tg-${Date.now()}` };
        }
        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: 'Markdown',
                }),
            });
            const data = await res.json();
            if (data.ok) {
                this.logger.log(`Telegram alert sent to ${chatId} for ${signal.symbol}`);
                return { success: true, messageId: String(data.result.message_id) };
            }
            else {
                this.logger.error(`Telegram API error: ${JSON.stringify(data)}`);
                return { success: false };
            }
        }
        catch (err) {
            this.logger.error(`Failed to dispatch Telegram message: ${err.message}`);
            return { success: false };
        }
    }
};
exports.TelegramDispatcher = TelegramDispatcher;
exports.TelegramDispatcher = TelegramDispatcher = TelegramDispatcher_1 = __decorate([
    (0, common_1.Injectable)()
], TelegramDispatcher);
//# sourceMappingURL=telegram.dispatcher.js.map