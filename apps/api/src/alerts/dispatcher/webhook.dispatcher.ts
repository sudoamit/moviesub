import { Injectable, Logger } from '@nestjs/common';
import { ISignalSetup } from '@quant/shared';

@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);

  async dispatchWebhook(
    url: string,
    signal: ISignalSetup,
  ): Promise<{ success: boolean; status?: number }> {
    const isDiscord =
      url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks');
    const isBull = signal.direction === 'BULLISH';
    const embedColor = isBull ? 0x10b981 : 0xf43f5e; // Emerald or Rose

    let payload: any;

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
                value:
                  (signal.reasoning.confirmedChecklist || [])
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
    } else {
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Quant-Trading-Platform/1.0',
      };
      if (signal.id) {
        headers['X-Quant-Event-ID'] = signal.id;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      return { success: res.ok, status: res.status };
    } catch (err) {
      this.logger.error(`Webhook delivery error to ${url}: ${(err as Error).message}`);
      return { success: false };
    }
  }

  async dispatchTradeAlert(
    url: string,
    tradePayload: import('@quant/shared').TradeAlertPayload,
  ): Promise<{ success: boolean; status?: number }> {
    const isDiscord =
      url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks');
    const isBull =
      String(tradePayload.direction).toUpperCase().includes('BUY') ||
      String(tradePayload.direction).toUpperCase().includes('LONG');
    const embedColor = isBull ? 0x10b981 : 0xf43f5e; // Emerald or Rose

    let payload: any;

    if (isDiscord) {
      payload = {
        username: 'Quant Institutional Trade Engine',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/2620/2620602.png',
        embeds: [
          {
            title: `⚡ [${tradePayload.eventType}] ${tradePayload.symbol} ${tradePayload.direction}`,
            description: tradePayload.reason || `Execution event: ${tradePayload.eventType}`,
            color: embedColor,
            fields: [
              { name: 'Symbol', value: `\`${tradePayload.symbol}\``, inline: true },
              { name: 'Quantity', value: `\`${tradePayload.quantity}\``, inline: true },
              { name: 'Price', value: `\`${tradePayload.price}\``, inline: true },
              ...(tradePayload.realizedPnL !== undefined
                ? [
                    {
                      name: 'Realized PnL',
                      value: `**${tradePayload.realizedPnL >= 0 ? '+' : ''}${tradePayload.realizedPnL.toFixed(2)}**`,
                      inline: true,
                    },
                  ]
                : []),
              ...(tradePayload.positionId
                ? [{ name: 'Position ID', value: `\`${tradePayload.positionId}\``, inline: true }]
                : []),
              { name: 'Event ID', value: `\`${tradePayload.eventId}\``, inline: false },
            ],
            footer: { text: 'Quant Intelligence Platform • Trade Execution Engine' },
            timestamp: new Date(tradePayload.timestamp).toISOString(),
          },
        ],
      };
    } else {
      payload = {
        event: tradePayload.eventType,
        eventId: tradePayload.eventId,
        timestamp: new Date(tradePayload.timestamp).toISOString(),
        trade: {
          symbol: tradePayload.symbol,
          direction: tradePayload.direction,
          quantity: tradePayload.quantity,
          price: tradePayload.price,
          realizedPnL: tradePayload.realizedPnL,
          positionId: tradePayload.positionId,
          orderId: tradePayload.orderId,
          reason: tradePayload.reason,
          metadata: tradePayload.metadata,
        },
      };
    }

    try {
      this.logger.log(
        `Dispatching trade webhook to ${url} for ${tradePayload.symbol} (${tradePayload.eventType}) [Event: ${tradePayload.eventId}]`,
      );
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Quant-Trading-Platform/1.0',
          'X-Quant-Event-ID': tradePayload.eventId,
        },
        body: JSON.stringify(payload),
      });

      return { success: res.ok, status: res.status };
    } catch (err) {
      this.logger.error(`Trade webhook delivery error to ${url}: ${(err as Error).message}`);
      return { success: false };
    }
  }
}
