import { PaperTradingService } from '../paper-trading.service';

/**
 * Option quotes are polled every 2s from a chain whose last-trade times are whole seconds and already 1-4s old,
 * so a quote can cross the 5s freshness limit between polls. A stale/missing quote triggers one immediate chain
 * refresh and one re-check against the same limit; it never relaxes the limit.
 */
describe('getValidatedOptionPrice refresh-on-stale', () => {
  const build = (ticker: () => any, refresh: () => Promise<void>) =>
    new PaperTradingService({} as any, {} as any, {
      getOptionTicker: ticker,
      refreshNseOptionQuotesNow: refresh,
    } as any);

  it('refreshes the chain once and accepts the fresh quote', async () => {
    let quote = { price: 150, marketEventTime: Date.now() - 8000 };
    const refresh = jest.fn(async () => {
      quote = { price: 152, marketEventTime: Date.now() - 1000 };
    });
    const service = build(() => quote, refresh);

    const res = await service.getValidatedOptionPrice('NIFTY 22600 PE', 5);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(res.price).toBe(152);
  });

  it('still fails closed when the refreshed quote is stale too', async () => {
    const refresh = jest.fn(async () => undefined);
    const service = build(() => ({ price: 150, marketEventTime: Date.now() - 8000 }), refresh);

    await expect(service.getValidatedOptionPrice('NIFTY 22600 PE', 5)).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
