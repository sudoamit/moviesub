import * as path from 'path';
import * as fs from 'fs';
import {
  FileShadowExecutionStore,
  ProductionTradingPipeline,
  ShadowExecutionSimulator,
  TradingDecision,
  LiveMarketEvent,
  LivePortfolioAccountState,
  ModelIdentity
} from '../../shadow-execution';

interface WorkerPayload {
  testFile: string;
  marketEvent: LiveMarketEvent;
  portfolioState: LivePortfolioAccountState;
  championModel: ModelIdentity;
  challengerModel: ModelIdentity;
  strategyConfig: Record<string, any>;
  liveOrdersLogFile?: string;
}

process.on('message', async (data: WorkerPayload) => {
  const { testFile, marketEvent, portfolioState, championModel, challengerModel, strategyConfig, liveOrdersLogFile } = data;

  try {
    const store = new FileShadowExecutionStore(testFile);
    const shadowSimulator = new ShadowExecutionSimulator();

    const mockLivePort = {
      isLiveBroker: true as const,
      submitLiveOrder: async (decision: TradingDecision) => {
        if (liveOrdersLogFile) {
          fs.appendFileSync(liveOrdersLogFile, JSON.stringify({ pid: process.pid, clientOrderId: decision.clientOrderId, ts: Date.now() }) + '\n', 'utf-8');
        }
        // Realistic broker network latency ensuring concurrent sibling workers encounter the active EXECUTING lock
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { liveOrderId: `live-order-${process.pid}`, status: 'PLACED' as const };
      },
      cancelLiveOrder: async () => true,
    };

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      strategyConfig,
    });

    const { championDecision, pairPromise } = await pipeline.processMarketEvent(marketEvent, portfolioState);
    const pair = await pairPromise;

    if (process.send) {
      process.send({
        success: true,
        pid: process.pid,
        decisionId: championDecision.decisionId,
        pairId: pair.pairId,
        clientOrderId: championDecision.clientOrderId,
      });
    }
    process.exit(0);
  } catch (err: any) {
    if (process.send) {
      process.send({
        success: false,
        pid: process.pid,
        error: err.message,
        isConcurrentLock: typeof err.message === 'string' && err.message.includes('CONCURRENT_EXECUTION_LOCK_ACQUIRED'),
      });
    }
    process.exit(0);
  }
});
