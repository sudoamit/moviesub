import { Injectable, Logger } from '@nestjs/common';
import { ISignalSetup } from '@quant/shared';

@Injectable()
export class TelegramDispatcher {
  private readonly logger = new Logger(TelegramDispatcher.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;

  async dispatchAlert(
    chatId: string,
    signal: ISignalSetup,
  ): Promise<{ success: boolean; messageId?: string }> {
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
      this.logger.log(
        `[TELEGRAM MOCK DISPATCH] -> Chat: ${chatId} | Alert: ${signal.symbol} (${signal.direction} Grade ${signal.grade})`,
      );
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
      } else {
        this.logger.error(`Telegram API error: ${JSON.stringify(data)}`);
        return { success: false };
      }
    } catch (err) {
      this.logger.error(`Failed to dispatch Telegram message: ${(err as Error).message}`);
      return { success: false };
    }
  }

  async dispatchTradeAlert(
    chatId: string,
    payload: import('@quant/shared').TradeAlertPayload,
  ): Promise<{ success: boolean; messageId?: string }> {
    const isBull = String(payload.direction).toUpperCase().includes('BUY') || String(payload.direction).toUpperCase().includes('LONG');
    const dirEmoji = isBull ? '🟢 LONG' : '🔴 SHORT';
    
    let eventEmoji = '⚡';
    if (payload.eventType.includes('OPEN')) eventEmoji = '🚀';
    else if (payload.eventType.includes('CLOSE')) eventEmoji = '🏁';
    else if (payload.eventType.includes('TP')) eventEmoji = '🎯';
    else if (payload.eventType.includes('SL')) eventEmoji = '🛡️';
    else if (payload.eventType.includes('RISK')) eventEmoji = '🚨';

    const pnlLine = payload.realizedPnL !== undefined
      ? `• *Realized PnL:* \`${payload.realizedPnL >= 0 ? '+' : ''}${payload.realizedPnL.toFixed(2)}\`\n`
      : '';

    const text = [
      `${eventEmoji} *TRADE ALERT: [${payload.eventType}]*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `*Symbol:* \`${payload.symbol}\``,
      `*Direction:* ${dirEmoji}`,
      `*Quantity:* \`${payload.quantity}\``,
      `*Execution Price:* \`${payload.price}\``,
      pnlLine ? pnlLine.trimEnd() : '',
      payload.positionId ? `*Position ID:* \`${payload.positionId}\`` : '',
      payload.reason ? `*Reason:* _${payload.reason}_` : '',
      `*Event ID:* \`${payload.eventId}\``,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🕒 _${new Date(payload.timestamp).toISOString()}_`,
    ].filter(Boolean).join('\n');

    if (!this.botToken) {
      this.logger.log(
        `[TELEGRAM MOCK TRADE DISPATCH] -> Chat: ${chatId} | ${payload.eventType} for ${payload.symbol} (Event: ${payload.eventId})`,
      );
      return { success: true, messageId: `mock-trade-tg-${payload.eventId}` };
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
        this.logger.log(`Telegram trade alert sent to ${chatId} for ${payload.symbol} (${payload.eventType})`);
        return { success: true, messageId: String(data.result.message_id) };
      } else {
        this.logger.error(`Telegram API error: ${JSON.stringify(data)}`);
        return { success: false };
      }
    } catch (err) {
      this.logger.error(`Failed to dispatch Telegram trade message: ${(err as Error).message}`);
      return { success: false };
    }
  }
}
