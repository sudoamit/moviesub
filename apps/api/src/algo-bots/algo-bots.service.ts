import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AlertsService } from '../alerts/alerts.service';
import { ISignalSetup } from '@quant/shared';

export interface IAlgoBot {
  id: string;
  name: string;
  symbol: string;
  direction: 'BULLISH' | 'BEARISH' | 'ANY';
  timeframe: string;
  minScore: number;
  smcCondition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE';
  lots: number;
  autoExecutePaper: boolean;
  notifyWebhook: boolean;
  isActive: boolean;
  createdAt: string;
  triggerCount: number;
  lastTriggeredAt?: string;
  lastTriggerDetails?: string;
}

@Injectable()
export class AlgoBotsService {
  private readonly logger = new Logger(AlgoBotsService.name);

  // In-memory store of active algorithmic bots initialized with preset institutional bots
  private bots: IAlgoBot[] = [
    {
      id: 'bot_nifty_smc_pro',
      name: 'NIFTY 15m Institutional Order Flow Scalper',
      symbol: 'NIFTY',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 80,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 3,
      lastTriggeredAt: new Date(Date.now() - 3600000).toISOString(),
      lastTriggerDetails: 'Triggered Bearish OB Rejection @ 24,160.00 (Score: 90)',
    },
    {
      id: 'bot_banknifty_fvg',
      name: 'BANKNIFTY 15m Fair Value Gap Hunter',
      symbol: 'BANKNIFTY',
      direction: 'BEARISH',
      timeframe: '15m',
      minScore: 85,
      smcCondition: 'FVG',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 2,
      lastTriggeredAt: new Date(Date.now() - 7200000).toISOString(),
      lastTriggerDetails: 'Triggered Bearish FVG Inversion @ 57,550.00 (Score: 94)',
    },
    {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT 15m Liquidity Pool Sweeper',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'LIQUIDITY_SWEEP',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: false,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 4,
      lastTriggeredAt: new Date(Date.now() - 1800000).toISOString(),
      lastTriggerDetails: 'Triggered Bullish Liquidity Sweep @ $79,350.00 (Score: 88)',
    },
  ];

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly alertsService: AlertsService,
  ) {
    this.logger.log(`Algo Strategy Studio initialized with ${this.bots.length} active automated bots.`);
  }

  async listBots(): Promise<IAlgoBot[]> {
    return this.bots;
  }

  async createBot(dto: Partial<IAlgoBot>): Promise<IAlgoBot> {
    const newBot: IAlgoBot = {
      id: `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: dto.name || `${dto.symbol || 'NIFTY'} Custom SMC Bot`,
      symbol: (dto.symbol || 'NIFTY').toUpperCase(),
      direction: dto.direction || 'ANY',
      timeframe: dto.timeframe || '15m',
      minScore: Number(dto.minScore || 80),
      smcCondition: dto.smcCondition || 'ANY_CONFLUENCE',
      lots: Number(dto.lots || 1),
      autoExecutePaper: dto.autoExecutePaper !== false,
      notifyWebhook: dto.notifyWebhook !== false,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    this.bots.unshift(newBot);
    this.logger.log(`✓ [ALGO BOT CREATED] '${newBot.name}' (${newBot.symbol} ${newBot.direction})`);
    return newBot;
  }

  async toggleBot(id: string): Promise<IAlgoBot> {
    const bot = this.bots.find((b) => b.id === id);
    if (!bot) {
      throw new NotFoundException(`Bot '${id}' not found`);
    }
    bot.isActive = !bot.isActive;
    this.logger.log(`✓ Bot '${bot.name}' is now ${bot.isActive ? 'ACTIVE' : 'PAUSED'}`);
    return bot;
  }

  async deleteBot(id: string): Promise<{ success: boolean }> {
    const index = this.bots.findIndex((b) => b.id === id);
    if (index === -1) {
      throw new NotFoundException(`Bot '${id}' not found`);
    }
    this.bots.splice(index, 1);
    return { success: true };
  }

  /**
   * Evaluates incoming signal against all active bot strategies
   */
  async evaluateSignalForBots(signal: ISignalSetup) {
    for (const bot of this.bots) {
      if (!bot.isActive) continue;
      if (bot.symbol !== signal.symbol) continue;
      if (bot.direction !== 'ANY' && bot.direction !== signal.direction) continue;
      if (signal.score < bot.minScore) continue;

      // Update bot trigger metadata
      bot.triggerCount += 1;
      bot.lastTriggeredAt = new Date().toISOString();
      bot.lastTriggerDetails = `${signal.direction} Trigger @ ₹${signal.entryZone.optimal.toFixed(2)} (Score: ${signal.score}/100)`;

      this.logger.log(`🤖 [BOT TRIGGERED] '${bot.name}' -> ${signal.symbol} ${signal.direction} @ ₹${signal.entryZone.optimal}`);

      // Automated Paper Execution
      if (bot.autoExecutePaper) {
        try {
          const portfolio = await this.paperTradingService.getPortfolio();
          const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
          if (alreadyOpen) {
            continue;
          }

          const lotMultiplier = bot.symbol === 'NIFTY' ? 65 : bot.symbol === 'BANKNIFTY' ? 15 : bot.symbol === 'BTCUSDT' ? 0.20 : 100;
          await this.paperTradingService.placeOrder({
            symbol: bot.symbol,
            direction: signal.direction === 'BULLISH' ? 'BUY' : 'SELL',
            quantity: bot.lots * lotMultiplier,
            orderType: 'MARKET',
            price: signal.entryZone.optimal,
            stopLoss: signal.stopLoss,
            target1: signal.takeProfits.tp1,
            target2: signal.takeProfits.tp2,
            target3: signal.takeProfits.tp3,
          });
        } catch (e: any) {
          this.logger.error(`Bot execution failed: ${e.message}`);
        }
      }
    }
  }
}
