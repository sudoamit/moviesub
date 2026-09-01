import { Injectable, Logger } from '@nestjs/common';
import { SignalsService } from '../signals/signals.service';
import { SMCService } from '../smc/smc.service';
import { Timeframe } from '@quant/shared';

@Injectable()
export class AISummaryService {
  private readonly logger = new Logger(AISummaryService.name);

  constructor(
    private readonly signalsService: SignalsService,
    private readonly smcService: SMCService,
  ) {}

  async generateSymbolSummary(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const sym = symbol.toUpperCase();
    const signal = await this.signalsService.generateSignalForSymbol(sym, timeframe);
    const smc = await this.smcService.getSMCAnalysis(sym, timeframe);

    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const bias = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL';

    const executiveSummary = isBull
      ? `${sym} is demonstrating clear structural strength on the ${timeframe} timeframe with institutional accumulation in the 50% Discount zone. The quantitative setup score is ${signal.score}/100 (Grade ${signal.grade}).`
      : isBear
      ? `${sym} exhibits institutional distribution on the ${timeframe} timeframe following buy-side liquidity sweeps in the 50% Premium zone. The quantitative setup score is ${signal.score}/100 (Grade ${signal.grade}).`
      : `${sym} is currently consolidating in a neutral dealing range without high-conviction institutional displacement. No active trade trigger is confirmed.`;

    const marketStructureNarrative = [
      `Market Regime: ${smc.marketRegime.regime.replace('_', ' ')} with ATR volatility at ${smc.marketRegime.atr.toFixed(2)} pts.`,
      `Higher Timeframe Alignment: 1H trend is ${signal.htfBias}, ${signal.scoreBreakdown.htfBias >= 15 ? 'strictly aligning with intraday execution.' : 'divergent from execution timeframe.'}`,
      signal.reasoning.liquidityReason,
    ].join(' ');

    const institutionalFootprint = [
      signal.reasoning.triggerReason,
      `Unmitigated Fair Value Gaps: ${(smc.fairValueGaps || []).filter((f: any) => !f.isFilled).length} active zones.`,
      `Order Block Zones: ${(smc.orderBlocks || []).filter((o: any) => !o.isMitigated).length} institutional anchors.`,
    ].join(' ');

    const riskParameters = {
      optimalEntry: signal.entryZone.optimal,
      entryRange: `[${signal.entryZone.min} - ${signal.entryZone.max}]`,
      invalidationStopLoss: signal.stopLoss,
      riskDistancePts: Number(Math.abs(signal.entryZone.optimal - signal.stopLoss).toFixed(2)),
      targets: {
        tp1: signal.takeProfits.tp1,
        tp2: signal.takeProfits.tp2,
        tp3: signal.takeProfits.tp3,
      },
      riskRewardRatio: `1:${signal.riskRewardRatios.rr2}`,
    };

    return {
      symbol: sym,
      timeframe,
      bias,
      score: signal.score,
      grade: signal.grade,
      executiveSummary,
      marketStructureNarrative,
      institutionalFootprint,
      riskParameters,
      confirmedChecklist: signal.reasoning.confirmedChecklist,
      generatedAt: new Date().toISOString(),
      disclaimer: 'Deterministic quantitative market intelligence. Generated strictly from mathematical structural engines with zero LLM hallucination.',
    };
  }

  async generateDailyBriefing(timeframe: Timeframe = Timeframe.M15) {
    const symbols = ['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'];
    const summaries = await Promise.all(
      symbols.map((sym) => this.generateSymbolSummary(sym, timeframe)),
    );

    const highConviction = summaries.filter((s) => s.score >= 80);
    const bullishCount = summaries.filter((s) => s.bias === 'BULLISH').length;
    const bearishCount = summaries.filter((s) => s.bias === 'BEARISH').length;

    return {
      title: 'Daily Institutional Market Intelligence Briefing',
      date: new Date().toISOString().split('T')[0],
      marketBreadth: {
        totalAnalyzed: symbols.length,
        bullishAssets: bullishCount,
        bearishAssets: bearishCount,
        highConvictionSetups: highConviction.length,
      },
      topOpportunities: highConviction.map((h) => ({
        symbol: h.symbol,
        direction: h.bias,
        score: h.score,
        grade: h.grade,
        summary: h.executiveSummary,
        optimalEntry: h.riskParameters.optimalEntry,
        stopLoss: h.riskParameters.invalidationStopLoss,
        tp2: h.riskParameters.targets.tp2,
        rr: h.riskParameters.riskRewardRatio,
      })),
      assetSummaries: summaries,
    };
  }
}
