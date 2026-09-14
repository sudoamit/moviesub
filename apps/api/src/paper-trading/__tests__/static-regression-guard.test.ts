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
});
