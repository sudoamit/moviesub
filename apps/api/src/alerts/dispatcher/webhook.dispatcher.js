"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var WebhookDispatcher_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookDispatcher = void 0;
const common_1 = require("@nestjs/common");
let WebhookDispatcher = WebhookDispatcher_1 = class WebhookDispatcher {
    logger = new common_1.Logger(WebhookDispatcher_1.name);
    async dispatchWebhook(url, signal) {
        const isDiscord = url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks');
        const isBull = signal.direction === 'BULLISH';
        const embedColor = isBull ? 0x10b981 : 0xf43f5e; // Emerald or Rose
        let payload;
        if (isDiscord) {
            payload = {
                username: 'Quant Institutional SMC Engine',
                avatar_url: 'https://cdn-icons-png.flaticon.com/512/2620/2620602.png',
                embeds: [
                    {
                        title: `🚨 ${signal.symbol} ${signal.direction} SMC TRADE SETUP`,
                        description: signal.reasoning.summary,
                        color: embedColor,
                        fields: [
                            {
                                name: 'Confluence Score',
                                value: `**${signal.score}/100** (Grade ${signal.grade})`,
                                inline: true,
                            },
                            { name: 'Timeframe', value: `\`${signal.timeframe}\``, inline: true },
                            { name: 'Risk/Reward', value: `**1:${signal.riskRewardRatios.rr2}**`, inline: true },
                            {
                                name: 'Optimal Entry',
                                value: `\`₹${signal.entryZone.optimal.toFixed(2)}\``,
                                inline: true,
                            },
                            { name: 'Stop Loss', value: `\`₹${signal.stopLoss.toFixed(2)}\``, inline: true },
                            {
                                name: 'Target 2 (2.5R)',
                                value: `\`₹${signal.takeProfits.tp2.toFixed(2)}\``,
                                inline: true,
                            },
                            {
                                name: 'Confirmed SMC Confluences',
                                value: (signal.reasoning.confirmedChecklist || [])
                                    .slice(0, 3)
                                    .map((c) => `• ${c}`)
                                    .join('\n') || '• Order block rejection confirmed',
                            },
                        ],
                        footer: { text: 'Quant Intelligence Platform • Real-Time Market Structure' },
                        timestamp: new Date().toISOString(),
                    },
                ],
            };
        }
        else {
            payload = {
                event: 'TRADE_SETUP_GENERATED',
                timestamp: new Date().toISOString(),
                signal: {
                    symbol: signal.symbol,
                    direction: signal.direction,
                    score: signal.score,
                    grade: signal.grade,
                    timeframe: signal.timeframe,
                    levels: {
                        entryOptimal: signal.entryZone.optimal,
                        entryMin: signal.entryZone.min,
                        entryMax: signal.entryZone.max,
                        stopLoss: signal.stopLoss,
                        takeProfit1: signal.takeProfits.tp1,
                        takeProfit2: signal.takeProfits.tp2,
                        riskReward: signal.riskRewardRatios.rr2,
                    },
                    reasoning: signal.reasoning,
                },
            };
        }
        try {
            this.logger.log(`Dispatching webhook to ${url} for ${signal.symbol}`);
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Quant-Trading-Platform/1.0',
                },
                body: JSON.stringify(payload),
            });
            return { success: res.ok, status: res.status };
        }
        catch (err) {
            this.logger.error(`Webhook delivery error to ${url}: ${err.message}`);
            return { success: false };
        }
    }
};
exports.WebhookDispatcher = WebhookDispatcher;
exports.WebhookDispatcher = WebhookDispatcher = WebhookDispatcher_1 = __decorate([
    (0, common_1.Injectable)()
], WebhookDispatcher);
//# sourceMappingURL=webhook.dispatcher.js.map