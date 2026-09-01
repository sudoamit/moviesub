import { BACKTESTING_VERSION } from '../index';

describe('Backtesting Package', () => {
  it('should export version identifier', () => {
    expect(BACKTESTING_VERSION).toBe('1.0.0');
  });
});
