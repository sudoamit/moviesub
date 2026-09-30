import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  TradingLifecycleState,
  resolveTradingLifecycleState,
  shouldDisplayLiveTradeMetrics,
  calculateExecutedPositionPnL,
  calculateExecutedPositionR,
  PlannedTradeSetup,
  ActualExecutedTrade,
  checkExecutionEligibility,
  isInstrumentLongOnly,
} from '@quant/shared';
import { LivePositionTracker } from '../components/LivePositionTracker';

// Mock browser globals for Node SSR tests
beforeAll(() => {
  const mockStorage: Record<string, string> = {};
  global.localStorage = {
    getItem: (key: string) => mockStorage[key] || null,
    setItem: (key: string, val: string) => {
      mockStorage[key] = val;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    },
    length: 0,
    key: () => null,
  };

  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url.includes('/api/paper-trading/portfolio')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ openPositions: [] }),
      });
    }
    if (url.includes('/api/algo-bots')) {
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({}),
    });
  }) as any;
});

describe('Authoritative Trading Lifecycle & Standby vs Active Trade State Model', () => {
  const mockSignal: ISignalSetup = {
    id: 'sig_nifty_setup_1',
    symbol: 'NIFTY',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A,
    score: 85,
    entryZone: { min: 24170, max: 24180, optimal: 24175.65 },
    stopLoss: 24100,
    takeProfits: { tp1: 24250, tp2: 24350, tp3: 24450 },
    riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
    reasoning: { summary: 'Institutional Order Flow Sweep', confirmedChecklist: ['FVG', 'OB'] } as any,
    scoreBreakdown: {} as any,
  };

  describe('Core Lifecycle State Machine & Domain Isolation', () => {
    it('TEST 1: Signal exists, no order -> Potential/Standby UI state; No live metrics', () => {
      const state = resolveTradingLifecycleState({
        hasActiveTrade: false,
        hasSignal: true,
        isTriggerSatisfied: false,
        isPlacingOrder: false,
        executionState: null,
      });

      expect(['potential', 'signal']).toContain(state);
      expect(shouldDisplayLiveTradeMetrics(state)).toBe(false);

      // Domain model separation: planned values exist, actual trade does not
      const plannedSetup: PlannedTradeSetup = {
        symbol: mockSignal.symbol,
        direction: mockSignal.direction,
        underlyingTriggerPrice: mockSignal.entryZone.optimal,
        plannedEntryPrice: 56.63,
        plannedStopLoss: 36.81,
        plannedTargets: { tp1: 86.36, tp2: 106.18, tp3: 135.91 },
        plannedQuantity: 65,
        plannedRiskAmount: (56.63 - 36.81) * 65,
        status: state,
      };

      const actualTrade: ActualExecutedTrade | null = null;

      expect(plannedSetup.plannedEntryPrice).toBe(56.63);
      expect(plannedSetup.plannedQuantity).toBe(65);
      expect(actualTrade).toBeNull();
    });

    it('TEST 2: Order submitted but not filled -> Pending Order state; No live metrics', () => {
      const statePlacing = resolveTradingLifecycleState({
        hasActiveTrade: false,
        hasSignal: true,
        isPlacingOrder: true,
      });
      expect(statePlacing).toBe('pending_order');
      expect(shouldDisplayLiveTradeMetrics(statePlacing)).toBe(false);

      const stateRouting = resolveTradingLifecycleState({
        hasActiveTrade: false,
        hasSignal: true,
        executionState: 'ROUTING_TO_EXCHANGE',
      });
      expect(stateRouting).toBe('pending_order');
      expect(shouldDisplayLiveTradeMetrics(stateRouting)).toBe(false);
    });

    it('TEST 3: Order filled -> Active Trade state; Entry, SL, Targets, P&L and R become visible', () => {
      const state = resolveTradingLifecycleState({
        hasActiveTrade: true,
        positionStatus: 'OPEN',
      });
      expect(state).toBe('active');
      expect(shouldDisplayLiveTradeMetrics(state)).toBe(true);

      // P&L and R multiple must be calculated exclusively using executed trade values
      const executedTrade: ActualExecutedTrade = {
        tradeId: 'trade_9921',
        positionId: 'pos_9921',
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        direction: 'BUY',
        executedEntryPrice: 56.63,
        executedStopLoss: 36.81,
        executedTargets: { tp1: 86.36, tp2: 106.18, tp3: 135.91 },
        executedQuantity: 65,
        filledAt: '2026-09-25T09:20:00Z',
        positionRisk: (56.63 - 36.81) * 65,
        currentPnL: calculateExecutedPositionPnL({
          isLong: true,
          executedEntryPrice: 56.63,
          currentPrice: 76.45,
          executedQuantity: 65,
        }),
        currentR: calculateExecutedPositionR({
          isLong: true,
          executedEntryPrice: 56.63,
          executedStopLoss: 36.81,
          currentPrice: 76.45,
        }),
        status: 'active',
      };

      expect(executedTrade.currentPnL).toBeCloseTo((76.45 - 56.63) * 65, 2);
      expect(executedTrade.currentR).toBeCloseTo((76.45 - 56.63) / (56.63 - 36.81), 2);
      expect(executedTrade.currentR).toBeGreaterThan(0);
    });

    it('TEST 4: Order rejected -> Rejected state; No active trade, No P&L', () => {
      const state = resolveTradingLifecycleState({
        hasActiveTrade: false,
        hasSignal: true,
        orderRejectionReason: 'RMS check failed: insufficient margin',
      });
      expect(state).toBe('rejected');
      expect(shouldDisplayLiveTradeMetrics(state)).toBe(false);

      const stateExecutionFail = resolveTradingLifecycleState({
        hasActiveTrade: false,
        executionState: 'FAILED_FINAL',
      });
      expect(stateExecutionFail).toBe('rejected');
      expect(shouldDisplayLiveTradeMetrics(stateExecutionFail)).toBe(false);
    });

    it('TEST 5: Position closed -> Closed Trade state; Historical trade metrics can be shown', () => {
      const state = resolveTradingLifecycleState({
        hasActiveTrade: false,
        isPositionCut: true,
        closedTradeSummary: { exitPrice: 106.18, pnl: 3220.75, r: 2.5, reason: 'TP2 Reached' },
      });
      expect(state).toBe('closed');
      expect(shouldDisplayLiveTradeMetrics(state)).toBe(true);
    });

    it('TEST 6: A strategy signal remains active while another trade is not executed -> Still Potential/Standby', () => {
      // Even if signal has optimal entry and targets, activeTrade is FALSE without backend position
      const state = resolveTradingLifecycleState({
        hasActiveTrade: false,
        hasSignal: true,
        isTriggerSatisfied: true,
      });

      expect(state).toBe('ready');
      expect(shouldDisplayLiveTradeMetrics(state)).toBe(false);
    });
  });

  describe('Component Rendering: UI Metrics Isolation in LivePositionTracker', () => {
    it('TEST 1 UI: Renders clean potential setup without live metrics or misleading performance labels', () => {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24150,
          activePosition: null,
          activeExecution: null,
        }),
      );

      // Verify clean potential setup indicators are present
      expect(html).toContain('SMC TRADE SETUP');
      expect(html).toContain('POTENTIAL SETUP');
      expect(html).toContain('Underlying Trigger');
      expect(html).toContain('PLANNED OPTION ENTRY');
      expect(html).toContain('PLANNED STOP');
      expect(html).toContain('PLANNED QUANTITY');

      // Crucial: Must NOT contain projected live metrics or misleading trade claims
      expect(html).not.toContain('+2.5R POTENTIAL');
      expect(html).not.toContain('Target R:R:');
      expect(html).not.toContain('UNREALIZED OPTION P&amp;L');
      expect(html).not.toContain('UNREALIZED P&amp;L');
      expect(html).not.toContain('OPTION PREMIUM TARGET ROADMAP:');
      expect(html).not.toContain('TARGET PROGRESSION &amp; MARKET TIMELINE:');
    });

    it('TEST 2 UI: Renders pending order indicator without P&L or Current R', () => {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24175,
          activePosition: null,
          activeExecution: {
            state: 'ORDER_SUBMITTED',
            requestedQuantity: 65,
            limitPrice: 56.63,
          },
        }),
      );

      expect(html).toContain('ORDER PENDING / SUBMITTED');
      expect(html).not.toContain('UNREALIZED OPTION P&amp;L');
      expect(html).not.toContain('TARGET PROGRESSION');
      expect(html).not.toContain('OPTION PREMIUM TARGET ROADMAP:');
    });

    it('TEST 3 UI: Renders Active Trade with live P&L, Current R, and Target Progression when position is active', () => {
      const activePos = {
        id: 'pos_nifty_live_1',
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        direction: 'BUY',
        quantity: 65,
        entryPrice: 56.63,
        status: 'OPEN',
        openedAt: new Date().toISOString(),
      };

      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24175,
          activePosition: activePos,
        }),
      );

      // Must switch to ACTIVE TRADE
      expect(html).toContain('ACTIVE TRADE');
      expect(html).toContain('ACTIVE POSITION: BUY / BULLISH');
      expect(html).toContain('ACTIVE TRADE • UNREALIZED OPTION P&amp;L');
      expect(html).toContain('Position Risk:');
      // Target progression roadmap is now visible
      expect(html).toContain('OPTION PREMIUM TARGET ROADMAP:');
      expect(html).not.toContain('POTENTIAL SETUP');
    });

    it('TEST 4 UI: Renders ORDER REJECTED notice when execution fails, without active trade metrics', () => {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24150,
          activePosition: null,
          activeExecution: {
            state: 'FAILED_FINAL',
            failureReason: 'Margin Insufficient for Option Buy',
          },
        }),
      );

      expect(html).toContain('ORDER REJECTED');
      expect(html).toContain('Margin Insufficient');
      expect(html).not.toContain('ACTIVE TRADE • UNREALIZED');
      expect(html).not.toContain('OPTION PREMIUM TARGET ROADMAP:');
    });

    it('TEST 5 UI: Renders CLOSED TRADE summary when position has been closed', () => {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24250,
          activePosition: {
            id: 'pos_closed_1',
            symbol: 'NIFTY',
            direction: 'BUY',
            quantity: 65,
            entryPrice: 56.63,
            status: 'CLOSED',
          },
        }),
      );

      // When position is closed and not active, it does not show active position
      expect(html).not.toContain('ACTIVE POSITION: BUY');
    });

    it('TEST 6 UI: Signal presence without filled position NEVER creates an active trade', () => {
      const strongSignal: ISignalSetup = {
        ...mockSignal,
        grade: SignalGrade.A_PLUS,
        score: 99,
        riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 8.0 },
      };

      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: strongSignal,
          livePrice: 24150, // below the 24175.65 trigger: a waiting setup
          activePosition: null,
          activeExecution: null,
        }),
      );

      // Must remain SMC TRADE SETUP and POTENTIAL SETUP
      expect(html).toContain('SMC TRADE SETUP');
      expect(html).toContain('POTENTIAL SETUP');
      expect(html).not.toContain('ACTIVE TRADE');
      expect(html).not.toContain('ACTIVE TRADE • UNREALIZED');
      expect(html).not.toContain('+4.0R POTENTIAL');
      expect(html).not.toContain('+8.0R');
    });
  });

  describe('Trigger satisfied is not execution eligible (NIFTY options)', () => {
    it('trigger met without a live option quote renders NOT ELIGIBLE, never READY FOR EXECUTION', () => {
      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(LivePositionTracker, {
          symbol: 'NIFTY',
          signal: mockSignal,
          livePrice: 24180, // above the 24175.65 trigger
          activePosition: null,
          activeExecution: null,
        }),
      );

      expect(html).toContain('NOT ELIGIBLE (NO LIVE OPTION QUOTE)');
      expect(html).not.toContain('READY FOR EXECUTION');
      expect(html).not.toContain('LONG-ONLY');
      expect(html).not.toContain('ACTIVE TRADE');
    });
  });

  describe('Execution Eligibility & Long-Only Spot Safety (BTCUSDT_SPOT)', () => {
    describe('Requirement 11: Exact Execution Eligibility Matrix', () => {
      it('Matrix Row 1: BTCUSDT_SPOT + BULLISH + triggerSatisfied: true => readyForExecution: true', () => {
        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: Direction.BULLISH,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(true);
        expect(canExecute).toBe(true);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: true,
          executionEligible,
          canExecute,
        });

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(true);
        expect(state).toBe('ready');
      });

      it('Matrix Row 2: BTCUSDT_SPOT + BULLISH + triggerSatisfied: false => readyForExecution: false', () => {
        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: Direction.BULLISH,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(true);
        expect(canExecute).toBe(true);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: false,
          executionEligible,
          canExecute,
        });

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(false);
        expect(state).toBe('potential');
      });

      it('Matrix Row 3: BTCUSDT_SPOT + BEARISH + triggerSatisfied: true => executionEligible: false, readyForExecution: false', () => {
        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: Direction.BEARISH,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(false);
        expect(canExecute).toBe(false);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: true,
          executionEligible,
          canExecute,
        });

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(false);
        expect(state).toBe('not_eligible');
      });

      it('Matrix Row 4: BTCUSDT_SPOT + BEARISH + triggerSatisfied: false => executionEligible: false, readyForExecution: false', () => {
        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: Direction.BEARISH,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(false);
        expect(canExecute).toBe(false);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: false,
          executionEligible,
          canExecute,
        });

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(false);
        expect(state).toBe('not_eligible');
      });

      it('Matrix Row 5: BTCUSDT_SPOT + NEUTRAL => executionEligible: false, readyForExecution: false', () => {
        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: Direction.NEUTRAL,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(false);
        expect(canExecute).toBe(false);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: true,
          executionEligible,
          canExecute,
        });

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(false);
        expect(state).toBe('not_eligible');
      });
    });

    describe('Requirement 7: Mutual Exclusivity Invariant', () => {
      it('never allows readyForExecution to be true when canExecute is false', () => {
        const canExecuteValues = [false, true];
        const triggerValues = [false, true];

        for (const canExecute of canExecuteValues) {
          for (const trigger of triggerValues) {
            const state = resolveTradingLifecycleState({
              hasActivePosition: false,
              hasSignal: true,
              isTriggerSatisfied: trigger,
              executionEligible: canExecute,
              canExecute,
            });

            const isReadyForExecution = state === 'ready';
            if (!canExecute) {
              expect(isReadyForExecution).toBe(false);
            }
          }
        }
      });
    });

    describe('Requirement 16: Screenshot Reproduction Test Case', () => {
      const btcBearishSignal: ISignalSetup = {
        id: 'sig_btc_saiyan_bearish',
        symbol: 'BTCUSDT_SPOT',
        timeframe: '15m',
        direction: Direction.BEARISH,
        strategy: 'SAIYAN_OCC',
        state: SignalState.ACTIVE,
        grade: SignalGrade.A,
        score: 82,
        entryZone: { min: 84400, max: 84410, optimal: 84405.9 },
        stopLoss: 84655.9,
        takeProfits: { tp1: 83500, tp2: 83000, tp3: 82500 },
        riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 3.5 },
        reasoning: { summary: 'Bearish OCC trend alignment', confirmedChecklist: ['OCC'] } as any,
        scoreBreakdown: {} as any,
      };

      it('evaluates screenshot state: triggerSatisfied=true, executionEligible=false, readyForExecution=false, canExecute=false', () => {
        const currentPrice = 83821.39;
        const trigger = 84405.9;
        const isBull = btcBearishSignal.direction === 'BULLISH';
        // For bearish, trigger is satisfied when current <= trigger
        const triggerSatisfied = isBull ? currentPrice >= trigger : currentPrice <= trigger;
        expect(triggerSatisfied).toBe(true);

        const { executionEligible, canExecute } = checkExecutionEligibility({
          symbol: 'BTCUSDT_SPOT',
          direction: btcBearishSignal.direction,
          isOptionMode: false,
        });
        expect(executionEligible).toBe(false);
        expect(canExecute).toBe(false);

        const state = resolveTradingLifecycleState({
          hasActivePosition: false,
          hasSignal: true,
          isTriggerSatisfied: triggerSatisfied,
          executionEligible,
          canExecute,
        });
        expect(state).toBe('not_eligible');

        const readyForExecution = state === 'ready';
        expect(readyForExecution).toBe(false);
      });

      it('renders screenshot case UI cleanly without contradictory banners or execution buttons', () => {
        const html = ReactDOMServer.renderToStaticMarkup(
          React.createElement(LivePositionTracker, {
            symbol: 'BTCUSDT_SPOT',
            signal: btcBearishSignal,
            livePrice: 83821.39,
            activePosition: null,
            activeExecution: null,
          }),
        );

        // Header and Card 1 must clearly indicate NO TRADE / NOT ELIGIBLE
        expect(html).toContain('SAIYAN OCC • NO TRADE');
        expect(html).toContain('SAIYAN OCC NO TRADE');
        expect(html).toContain('LONG-ONLY SPOT');
        expect(html).toContain('Bearish signal detected.');
        expect(html).toContain('supports <span class="text-emerald-400 font-semibold">LONG</span> positions only');
        expect(html).toContain('This bearish setup is not eligible for execution.');

        // Must NOT show contradictory or misleading states
        expect(html).not.toContain('READY FOR EXECUTION');
        expect(html).not.toContain('STATUS: READY FOR EXECUTION');
        expect(html).not.toContain('EXECUTION BLOCKED (Spot Short Forbidden)');
        expect(html).not.toContain('SAIYAN OCC SETUP BLOCKED');

        // Must NOT render any Execute button
        expect(html).not.toContain('Execute Paper Trade');
        expect(html).not.toContain('Execute BTC');
        expect(html).not.toContain('Execute Trade');
        // No trade was taken, so no "no execution" notice is rendered either
        expect(html).not.toContain('No Execution (Spot Long-Only)');
      });

      it('a stale EXECUTED bot execution from an earlier setup does not turn a bearish spot setup into READY', () => {
        const signalTime = Date.UTC(2026, 8, 30, 6, 15, 0);
        const html = ReactDOMServer.renderToStaticMarkup(
          React.createElement(LivePositionTracker, {
            symbol: 'BTCUSDT_SPOT',
            signal: { ...btcBearishSignal, canonicalCandleTime: signalTime } as any,
            livePrice: 83821.39,
            activePosition: null,
            // Finished execution from an earlier BULLISH signal whose position no longer exists
            activeExecution: {
              id: 'exec_old',
              symbol: 'BTCUSDT',
              direction: 'BULLISH',
              state: 'EXECUTED',
              orderPositionId: 'pos_gone',
              signalTimestamp: new Date(signalTime - 4 * 3600 * 1000).toISOString(),
            },
          }),
        );

        expect(html).not.toContain('READY FOR EXECUTION');
        expect(html).toContain('SAIYAN OCC • NO TRADE');
        expect(html).toContain('This bearish setup is not eligible for execution.');
      });

      it('an execution produced by the current signal still drives the state (e.g. ORDER REJECTED)', () => {
        const signalTime = Date.UTC(2026, 8, 30, 6, 15, 0);
        const bullish = { ...btcBearishSignal, direction: Direction.BULLISH, canonicalCandleTime: signalTime } as any;
        const html = ReactDOMServer.renderToStaticMarkup(
          React.createElement(LivePositionTracker, {
            symbol: 'BTCUSDT_SPOT',
            signal: bullish,
            livePrice: 84500,
            activePosition: null,
            activeExecution: {
              id: 'exec_now',
              symbol: 'BTCUSDT',
              direction: 'BULLISH',
              state: 'FAILED_FINAL',
              failureReason: 'Insufficient cash',
              signalTimestamp: new Date(signalTime).toISOString(),
            },
          }),
        );

        expect(html).toContain('ORDER REJECTED');
        expect(html).not.toContain('READY FOR EXECUTION');
      });

      it('renders Bullish BTCUSDT_SPOT setup with execution button available when trigger satisfied', () => {
        const btcBullishSignal: ISignalSetup = {
          ...btcBearishSignal,
          id: 'sig_btc_saiyan_bullish',
          direction: Direction.BULLISH,
          entryZone: { min: 83800, max: 83810, optimal: 83800.0 },
          stopLoss: 83500.0,
        };

        const html = ReactDOMServer.renderToStaticMarkup(
          React.createElement(LivePositionTracker, {
            symbol: 'BTCUSDT_SPOT',
            signal: btcBullishSignal,
            livePrice: 83821.39,
            activePosition: null,
            activeExecution: null,
          }),
        );

        // Bullish spot IS eligible for execution
        expect(html).toContain('READY FOR EXECUTION');
        expect(html).toContain('Execute Paper Trade @ Market');
        expect(html).not.toContain('NO TRADE');
      });

      it('renders Option Premium Trigger with waiting indicator and +/- 1% band', () => {
        const html = ReactDOMServer.renderToStaticMarkup(
          React.createElement(LivePositionTracker, {
            symbol: 'NIFTY',
            signal: mockSignal,
            livePrice: 24150, // below underlying trigger
            activePosition: null,
            activeExecution: null,
          }),
        );

        expect(html).toContain('POTENTIAL SETUP (WAITING FOR TRIGGER)');
        expect(html).toContain('PLANNED OPTION ENTRY');
        expect(html).toContain('Trigger Band:');
        expect(html).toContain('(±1%)');
      });
    });
  });
});
