import { TRADING_ENGINE_VERSION } from '../index';

describe('Trading Engine Package', () => {
  it('should export version identifier', () => {
    expect(TRADING_ENGINE_VERSION).toBe('2.0.0');
  });
});
