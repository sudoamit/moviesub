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
