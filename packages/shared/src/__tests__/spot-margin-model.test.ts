import {
  canonicalizeExecutionSymbol,
  getAuthoritativeInstrument,
  resolveMarginModel,
} from '../instrument/instrument-registry';

describe('True spot margin model cannot be bypassed', () => {
  const btcSpot = getAuthoritativeInstrument('BTCUSDT_SPOT');

  it('canonicalizes every BTC alias to BTCUSDT_SPOT and leaves other symbols unchanged', () => {
    for (const alias of ['btc', 'BTCUSD', 'BTCUSDT', ' btcusdt_spot ']) {
      expect(canonicalizeExecutionSymbol(alias)).toBe('BTCUSDT_SPOT');
    }
    expect(canonicalizeExecutionSymbol('nifty')).toBe('NIFTY');
    expect(canonicalizeExecutionSymbol('XAUUSD')).toBe('XAUUSD');
  });

  it('resolves BTCUSDT_SPOT to 1x SPOT with no liquidation', () => {
    const model = resolveMarginModel(btcSpot);
    expect(model.marginMode).toBe('SPOT');
    expect(model.effectiveLeverage).toBe(1);
    expect(model.liquidationModel).toBe('SPOT_NONE');
  });

  it('rejects 50x whether requested via requestedLeverage or customLeverage (never clamps to 1x)', () => {
    expect(() => resolveMarginModel(btcSpot, { requestedLeverage: 50 })).toThrow(/LEVERAGE_EXCEEDS_MAX/);
    expect(() => resolveMarginModel(btcSpot, { customLeverage: 50 })).toThrow(/LEVERAGE_EXCEEDS_MAX/);
  });

  it('ignores a venue override that tries to turn spot into a margin product', () => {
    const model = resolveMarginModel(btcSpot, {
      venueOverride: { marginMode: 'ISOLATED', maxLeverage: 50, initialMarginRate: 0.02 },
    });
    expect(model.marginMode).toBe('SPOT');
    expect(model.effectiveLeverage).toBe(1);

    const composed = getAuthoritativeInstrument('BTCUSDT_SPOT', { marginMode: 'ISOLATED', maxLeverage: 50 });
    expect(composed.marginMode).toBe('SPOT');
    expect(composed.maxLeverage).toBe(1);
  });

  it('still allows leverage within limits on genuine margin instruments', () => {
    const gold = getAuthoritativeInstrument('XAUUSD');
    expect(resolveMarginModel(gold, { requestedLeverage: 5 }).effectiveLeverage).toBe(5);
  });
});

describe('BTCUSDT_SPOT vs BTCUSDT_PERP are distinct, unambiguous instruments', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getAuthoritativeDescriptor } = require('../instrument/instrument-descriptor');

  it('every legacy BTC alias resolves to SPOT in the authoritative registry (never the leveraged spec)', () => {
    for (const alias of ['BTCUSDT', 'btcusdt', 'BTCUSD', 'BTC', 'BTCUSDT_SPOT']) {
      const inst = getAuthoritativeInstrument(alias);
      expect(inst.symbol).toBe('BTCUSDT_SPOT');
      expect(inst.marginMode).toBe('SPOT');
      expect(inst.maxLeverage).toBe(1);
    }
  });

  it('spot: long-only, 1x, full notional, no liquidation', () => {
    expect(getAuthoritativeDescriptor('BTCUSDT_SPOT').supportsShort).toBe(false);
    const spot = getAuthoritativeInstrument('BTCUSDT');
    const m = resolveMarginModel(spot, { requestedLeverage: 1 });
    expect(m).toMatchObject({ marginMode: 'SPOT', effectiveLeverage: 1, initialMarginRate: 1, liquidationModel: 'SPOT_NONE' });
    // 50x on spot (incl. through the legacy alias) is rejected, never clamped to 1x
    expect(() => resolveMarginModel(spot, { requestedLeverage: 50 })).toThrow(/LEVERAGE_EXCEEDS_MAX/);
  });

  it('perp: long and short, isolated margin, up to the configured 50x', () => {
    const perp = getAuthoritativeInstrument('BTCUSDT_PERP');
    expect(perp.symbol).toBe('BTCUSDT_PERP');
    expect(perp.marginMode).toBe('ISOLATED');
    expect(perp.maxLeverage).toBe(50);
    expect(getAuthoritativeDescriptor('BTCUSDT_PERP').supportsShort).toBe(true);
    const m = resolveMarginModel(perp, { requestedLeverage: 20 });
    expect(m.marginMode).toBe('ISOLATED');
    expect(m.effectiveLeverage).toBe(20);
    expect(m.liquidationModel).not.toBe('SPOT_NONE');
  });
});
