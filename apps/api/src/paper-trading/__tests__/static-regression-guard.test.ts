import * as fs from 'fs';
import * as path from 'path';
import { PointInTimeCurrencyConverter } from '@quant/shared';
import { ExecutionMode } from '../execution-provider.interface';

describe('AI FIX 148 — Static Regression Guard & Architectural Invariants', () => {
  const rootDir = path.resolve(__dirname, '../../../../../');

  function getFiles(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        if (file !== 'node_modules' && file !== 'dist' && file !== '.git') {
          getFiles(filePath, fileList);
        }
      } else if (
        (file.endsWith('.ts') || file.endsWith('.tsx')) &&
        !file.includes('.spec.') &&
        !file.includes('.test.') &&
        !filePath.includes('__tests__')
      ) {
        fileList.push(filePath);
      }
    }
    return fileList;
  }

  const productionDirs = [
    path.join(rootDir, 'apps/api/src'),
    path.join(rootDir, 'apps/worker/src'),
    path.join(rootDir, 'apps/web/src'),
    path.join(rootDir, 'packages/shared/src'),
    path.join(rootDir, 'packages/risk-engine/src'),
    path.join(rootDir, 'packages/trading-engine/src'),
  ];

  const productionFiles = productionDirs.flatMap((d) => getFiles(d));

  it('RULE 1: Zero occurrences of USDT_INR_RATE or USD_INR_RATE in production code', () => {
    const forbiddenTokens = ['USDT_INR_RATE', 'USD_INR_RATE'];
    for (const file of productionFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const token of forbiddenTokens) {
        const matches = content.includes(token);
        expect({ file, token, matches }).toEqual({ file, token, matches: false });
      }
    }
  });

  it('RULE 2: Zero occurrences of hardcoded FX rate 92.0 or 87.0 in production code', () => {
    for (const file of productionFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // Look for 92.0 or standalone 87.0 used as a numeric literal (not part of larger numbers like 1287.0)
      const matches92 = /(?<!\d)92\.0(?!\d)/.test(content);
      const matches87 = /(?<!\d)87\.0(?!\d)/.test(content);
      expect({ file, matches92, matches87 }).toEqual({ file, matches92: false, matches87: false });
    }
  });

  it('RULE 3: Zero unapproved ad-hoc priceDiff * arithmetic outside TradeAccountingEngine', () => {
    for (const file of productionFiles) {
      if (file.endsWith('trade-accounting-engine.ts')) continue;
      const content = fs.readFileSync(file, 'utf8');
      const hasAdHocPriceDiff = /priceDiff\s*\*/.test(content);
      expect({ file, hasAdHocPriceDiff }).toEqual({ file, hasAdHocPriceDiff: false });
    }
  });

  it('RULE 4: Frontend web app contains zero PointInTimeCurrencyConverter calls (Presentation Only)', () => {
    const webFiles = getFiles(path.join(rootDir, 'apps/web/src'));
    for (const file of webFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const usesConverter = content.includes('PointInTimeCurrencyConverter');
      expect({ file, usesConverter }).toEqual({ file, usesConverter: false });
    }
  });

  it('RULE 5: PointInTimeCurrencyConverter starts with ZERO hardcoded rates (Strict Fail-Closed)', () => {
    PointInTimeCurrencyConverter.resetInstance();
    const freshConverter = PointInTimeCurrencyConverter.getInstance();
    expect(() => freshConverter.getRate('USDT', 'INR', Date.now())).toThrow(/MISSING_FX_RATE/);
    expect(() => freshConverter.getRate('USD', 'INR', Date.now())).toThrow(/MISSING_FX_RATE/);
    expect(() => freshConverter.getRate('EUR', 'INR', Date.now())).toThrow(/MISSING_FX_RATE/);
  });

  it('RULE 6: ExecutionMode enum strictly defines LIVE and LIVE_MARKET', () => {
    expect(ExecutionMode.LIVE_MARKET).toBe('LIVE_MARKET');
    expect(ExecutionMode.LIVE).toBe('LIVE');
    expect(ExecutionMode.TEST).toBe('TEST');
    expect(ExecutionMode.SIMULATED).toBe('SIMULATED');
  });

  it('RULE 7: Single Accounting Authority Structural Invariant — PaperPositionMonitorService and PaperTradingService have zero local financial P&L math and strictly require immutable lifecycle snapshots', () => {
    const monitorFile = path.join(rootDir, 'apps/api/src/paper-trading/paper-position-monitor.service.ts');
    const monitorContent = fs.readFileSync(monitorFile, 'utf8');

    // 1. Monitor must invoke TradeAccountingEngine.settleExecutionLeg
    expect(monitorContent).toContain('TradeAccountingEngine.settleExecutionLeg');
    // 2. Monitor must NOT have custom price diff calculations, convertPnL, or calculateTradePnl calls
    expect(monitorContent).not.toContain('calculateTradePnl');
    expect(monitorContent).not.toContain('convertPnL');
    expect(monitorContent).not.toMatch(/\b(livePrice\s*-\s*entryPrice)\s*\*/);
    expect(monitorContent).not.toMatch(/\b(entryPrice\s*-\s*livePrice)\s*\*/);
    expect(monitorContent).not.toMatch(/\b(price\s*-\s*entry)\s*\*/);
    expect(monitorContent).not.toMatch(/\bdelta\s*\*\s*fx/);
    // 3. Monitor must strictly fail closed if openingSnapshot is missing during TP1 scale-out (NO silent converter.getRate fallback!)
    expect(monitorContent).toContain('[MALFORMED_LIFECYCLE] Cannot execute partial TP1 scale-out');
    expect(monitorContent).not.toMatch(/openingSnapshot\?\.fxRate\s*\?\?\s*PointInTimeCurrencyConverter/);

    const tradingFile = path.join(rootDir, 'apps/api/src/paper-trading/paper-trading.service.ts');
    const tradingContent = fs.readFileSync(tradingFile, 'utf8');

    // 4. Trading service must invoke TradeAccountingEngine.settleExecutionLeg
    expect(tradingContent).toContain('TradeAccountingEngine.settleExecutionLeg');
    // 5. closePosition derives canonicalRealizedPnL strictly from leg.netPnL sum
    expect(tradingContent).toContain('allLegsBreakdown.reduce((sum, leg) => sum + Number(leg.netPnL || 0), 0)');
    // 6. Zero fallback or ad-hoc calculation in closePosition
    expect(tradingContent).not.toContain('fullLifecycleCalc');
    expect(tradingContent).not.toContain('convertPnL');
    expect(tradingContent).not.toMatch(/\b(exitPrice\s*-\s*entryPrice)\s*\*/);
    expect(tradingContent).not.toMatch(/\b(entryPrice\s*-\s*exitPrice)\s*\*/);
    expect(tradingContent).not.toMatch(/\bdelta\s*\*\s*fx/);
    // 7. Trading service must strictly fail closed if openingSnapshot is missing during closePosition (NO ad-hoc snapshot building!)
    expect(tradingContent).toContain('[MALFORMED_LIFECYCLE] Cannot close position');
    expect(tradingContent).not.toMatch(/openingSnapshot\s*\?\?\s*buildAccountingSnapshot/);
  });

  it('RULE 8: Definitive Repository-Wide Mechanical Clean Scan across all production source files', () => {
    const violations: { file: string; rule: string; matched: string }[] = [];

    for (const file of productionFiles) {
      const content = fs.readFileSync(file, 'utf8');

      if (content.includes('USDT_INR_RATE')) {
        violations.push({ file, rule: 'USDT_INR_RATE', matched: 'USDT_INR_RATE' });
      }
      if (content.includes('USD_INR_RATE')) {
        violations.push({ file, rule: 'USD_INR_RATE', matched: 'USD_INR_RATE' });
      }
      const m92 = content.match(/(?<!\d)92\.0(?!\d)/);
      if (m92) {
        violations.push({ file, rule: '92.0', matched: m92[0] });
      }
      const m87 = content.match(/(?<!\d)87\.0(?!\d)/);
      if (m87) {
        violations.push({ file, rule: '87.0', matched: m87[0] });
      }
      if (!file.endsWith('trade-accounting-engine.ts')) {
        const mDiff = content.match(/priceDiff\s*\*/);
        if (mDiff) {
          violations.push({ file, rule: 'priceDiff *', matched: mDiff[0] });
        }
      }
    }

    expect(violations).toEqual([]);
    expect(productionFiles.length).toBeGreaterThanOrEqual(100);
  });

  it('RULE 9: AI FIX 153 Structural Guards — Zero Date.now() marketEventTime fallback, no unauthenticated Redis LIVE_PROVIDER elevation, and RECONNECTING fails closed', () => {
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');

    // 1. Streamer must not use Date.now() as marketEventTime fallback
    expect(streamerContent).not.toMatch(/marketEventTime\s*=\s*[^;\n]*\?\s*[^;\n]*:\s*now/);
    expect(streamerContent).not.toMatch(/marketEventTime:\s*[^,\n]*\?\?\s*now/);
    expect(streamerContent).not.toMatch(/marketEventTime:\s*[^,\n]*\?\?\s*Date\.now\(\)/);

    // 2. Streamer must have isExecutionDataHealthy() predicate
    expect(streamerContent).toContain('isExecutionDataHealthy()');

    // 3. Monitor must use parseAndValidateRedisOptionQuote
    const monitorFile = path.join(rootDir, 'apps/api/src/paper-trading/paper-position-monitor.service.ts');
    const monitorContent = fs.readFileSync(monitorFile, 'utf8');
    expect(monitorContent).toContain('parseAndValidateRedisOptionQuote');

    // 4. Invariant: Monitor must NEVER assign LIVE_PROVIDER directly from arbitrary unverified Redis parsed object
    expect(monitorContent).not.toMatch(/provenance:\s*parsed\.provenance/);

    // 5. Invariant: Monitor must fail closed when streamer is in RECONNECTING state
    expect(streamerContent).toMatch(/connectionState === 'CONNECTED' \|\| (this\.|state\.)?connectionState === 'RECONNECTED'/);
  });

  it('RULE 10: AI FIX 155 Structural Guards — canonical option authority is provider-derived and explicitly signed', () => {
    const validatorFile = path.join(rootDir, 'packages/shared/src/market-data/execution-quote-validator.ts');
    const validatorContent = fs.readFileSync(validatorFile, 'utf8');
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');

    expect(validatorContent).toContain('process.env.CANONICAL_OPTION_QUOTE_SECRET');
    expect(validatorContent).not.toContain('process.env.JWT_SECRET');
    expect(validatorContent).not.toContain('process.env.SESSION_SECRET');
    expect(validatorContent).not.toContain('signingSecret?: string');
    expect(validatorContent).toContain('crypto.timingSafeEqual');
    expect(validatorContent).toContain('providerInstanceId');
    expect(validatorContent).toContain('providerConnectionId');
    expect(validatorContent).toContain('providerTransport');

    expect(streamerContent).toContain('private async publishCanonicalOptionQuote');
    expect(streamerContent).not.toMatch(/public async publishCanonicalOptionQuote/);
    const publishFn = streamerContent.match(/publishCanonicalOptionQuote\([\s\S]*?\}\n/)?.[0] || '';
    expect(publishFn).not.toMatch(/providerId\s*:\s*params\.providerId/);
    expect(streamerContent).toContain('NSE_STREAM_OPTION_PROVIDER_ADAPTER.toCanonicalExecutionTick');
    expect(streamerContent).toContain('NSE_REST_OPTION_PROVIDER_ADAPTER.toCanonicalExecutionTick');
    expect(streamerContent).toContain('getCurrentOptionProviderConnection(params.providerId)');
  });

  it('RULE 11: AI FIX 159 Structural Guards — Final Transport-Specific Connection Authority', () => {
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');

    // 1. Zero references to global providerConnectionEpoch field in streamer
    expect(streamerContent).not.toMatch(/private\s+providerConnectionEpoch\b/);
    expect(streamerContent).not.toMatch(/this\.providerConnectionEpoch\b/);

    // 2. Zero references to global providerConnected field in streamer
    expect(streamerContent).not.toMatch(/private\s+providerConnected\b/);

    // 3. getCurrentOptionProviderConnection must reject unknown providerId and not default to a valid provider connection
    expect(streamerContent).toContain('getCurrentOptionProviderConnection');
    expect(streamerContent).toContain('[UNKNOWN_PROVIDER_ID_REJECTED]');
    expect(streamerContent).not.toMatch(/default:\s*\n?\s*return\s+this\.(stream|rest)ProviderConnection/);

    // 4. Stream reconnect creates stream connection ONLY (no global beginProviderConnections or REST reset)
    expect(streamerContent).toContain('this.beginStreamProviderConnection');
    expect(streamerContent).not.toContain('this.beginProviderConnections()');
    const handleReconnectFn = streamerContent.match(/handleStreamProviderReconnect\(\)[\s\S]*?this\.logger\.log/)?.[0] || '';
    expect(handleReconnectFn).not.toContain('beginRestProviderConnection');

    // 5. REST recovery creates REST connection ONLY (no global beginProviderConnections or Stream reset)
    expect(streamerContent).toContain('this.beginRestProviderConnection');
    const setRestHealthFn = streamerContent.match(/setRestHealthState\([^)]*\):[\s\S]*?\}\n/)?.[0] || '';
    expect(setRestHealthFn).not.toContain('beginStreamProviderConnection');
  });

  it('RULE 12: AI FIX 160 Structural Guards — Production-Hardening Spot Authority & Truthful Transport Identity', () => {
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');

    // 1. updateTicker rejects unbranded generic LIVE_PROVIDER input
    expect(streamerContent).toContain('[UNAUTHORITATIVE_SPOT_TICK_REJECTED]');
    expect(streamerContent).toContain('[UNAUTHORITATIVE_OPTION_TICK_REJECTED]');

    // 2. Sealed spot ingestion path required
    expect(streamerContent).toContain('public ingestCanonicalSpotTick');

    // 3. Binance PAXG polling uses BINANCE_REST_SPOT_PROVIDER_ADAPTER
    expect(streamerContent).toContain('BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick');

    // 4. getValidatedTicker calls validateAuthoritativeExecutionQuote
    expect(streamerContent).toContain('validateAuthoritativeExecutionQuote');
  });

  it('RULE 13: AI FIX 161 Structural Guards — Final Execution-Authority Hardening', () => {
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');
    const validatorFile = path.join(rootDir, 'packages/shared/src/market-data/execution-quote-validator.ts');
    const validatorContent = fs.readFileSync(validatorFile, 'utf8');

    // 1. ingestCanonicalSpotTick must use ValidatedCanonicalSpotProviderTick (NOT option tick!)
    expect(streamerContent).toContain('ingestCanonicalSpotTick(\n    canonicalTick: ValidatedCanonicalSpotProviderTick');
    expect(streamerContent).not.toContain('ingestCanonicalSpotTick(\n    canonicalTick: ValidatedCanonicalOptionProviderTick');

    // 2. getCurrentStreamProviderConnection must be pure and throw [UNKNOWN_PROVIDER_ID_REJECTED] without creating connections
    const getStreamConnFn = streamerContent.match(/getCurrentStreamProviderConnection\([^)]*\):[\s\S]*?\}\n/)?.[0] || '';
    expect(getStreamConnFn).not.toContain('this.beginStreamProviderConnection');
    expect(getStreamConnFn).toContain('[UNKNOWN_PROVIDER_ID_REJECTED]');

    // 3. getCurrentRestProviderConnection must be pure and throw [UNKNOWN_PROVIDER_ID_REJECTED] without creating connections
    const getRestConnFn = streamerContent.match(/getCurrentRestProviderConnection\([^)]*\):[\s\S]*?\}\n/)?.[0] || '';
    expect(getRestConnFn).not.toContain('this.beginRestProviderConnection');
    expect(getRestConnFn).toContain('[UNKNOWN_PROVIDER_ID_REJECTED]');

    // 4. normalizeCanonicalProviderId must throw [UNKNOWN_PROVIDER_ID_REJECTED] on unknown provider IDs
    expect(validatorContent).toContain('normalizeCanonicalProviderId');
    expect(validatorContent).toContain('[UNKNOWN_PROVIDER_ID_REJECTED]');

    // 5. validateCurrentProviderExecutionQuote helper must exist
    expect(validatorContent).toContain('export function validateCurrentProviderExecutionQuote');
  });

  it('RULE 14: AI FIX 162 Structural Guards — Final Provider-Runtime-State Hardening', () => {
    const streamerFile = path.join(rootDir, 'apps/api/src/market-data/real-market-streamer.service.ts');
    const streamerContent = fs.readFileSync(streamerFile, 'utf8');

    // 1. Zero global streamConnectionState field in RealMarketStreamerService
    expect(streamerContent).not.toMatch(/private\s+streamConnectionState\s*:\s*ProviderConnectionState/);

    // 2. Zero global streamProviderConnected field in RealMarketStreamerService
    expect(streamerContent).not.toMatch(/private\s+streamProviderConnected\s*=/);

    // 3. streamRuntimeStateMap exists and manages provider-scoped state
    expect(streamerContent).toContain('private streamRuntimeStateMap: Map<string,');

    // 4. getCurrentProviderConnection enforces providerTransport check
    expect(streamerContent).toContain('[PROVIDER_TRANSPORT_MISMATCH]');

    // 5. Freshness invalidation on reconnect is provider-scoped (no global clear in handleStreamProviderReconnect)
    const handleReconnectFn = streamerContent.match(/handleStreamProviderReconnect\([\s\S]*?\}\n  \}/)?.[0] || '';
    expect(handleReconnectFn).not.toContain('this.freshSymbolsAfterReconnect.clear()');
    expect(handleReconnectFn).toContain('WEBSOCKET_STREAM:');

    // 6. beginStreamProviderConnection and beginRestProviderConnection validate shared existingConnection identity
    expect(streamerContent).toContain('[INVALID_SHARED_CONNECTION_IDENTITY]');
  });
});

