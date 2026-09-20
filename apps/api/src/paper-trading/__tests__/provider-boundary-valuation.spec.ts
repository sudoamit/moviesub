import { Test, TestingModule } from '@nestjs/testing';
import { PositionValuationService } from '../position-valuation.service';
import { RealMarketStreamerService, ILiveRealTicker } from '../../market-data/real-market-streamer.service';
import { MarketDataUnavailableError } from '@quant/shared';

describe('FIX 203: Real Provider Boundary & Position Valuation Test', () => {
  let valuationService: PositionValuationService;
  let mockStreamerService: Partial<RealMarketStreamerService>;

  beforeEach(async () => {
    mockStreamerService = {
      getOptionTicker: jest.fn(),
      getValidatedTicker: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionValuationService,
        {
          provide: RealMarketStreamerService,
          useValue: mockStreamerService,
        },
      ],
    }).compile();

    valuationService = module.get<PositionValuationService>(PositionValuationService);
  });

  describe('Strict Authoritative Valuation (resolveLivePositionQuote)', () => {
    it('Invariant 1: Option valuation requires exact contract symbol and LIVE_PROVIDER provenance', () => {
      const now = Date.now();
      const validOptionTick: ILiveRealTicker = {
        symbol: 'NIFTY 24100 CE',
        price: 152.5,
        lastUpdated: now,
        marketEventTime: now - 500, // 500ms fresh
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM',
        providerTransport: 'WEBSOCKET_STREAM',
      };

      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue(validOptionTick);

      const quote = valuationService.resolveLivePositionQuote({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24100 CE',
        instrumentType: 'OPTION',
      });

      expect(quote.price).toBe(152.5);
      expect(quote.provenance).toBe('LIVE_PROVIDER');
      expect(quote.isFresh).toBe(true);
      expect(mockStreamerService.getOptionTicker).toHaveBeenCalledWith('NIFTY 24100 CE');
    });

    it('Invariant 2: Option valuation fails closed if provenance is BOOTSTRAP or DEGRADED', () => {
      const now = Date.now();
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue({
        symbol: 'NIFTY 24100 CE',
        price: 152.5,
        lastUpdated: now,
        marketEventTime: now,
        provenance: 'BOOTSTRAP', // Not LIVE_PROVIDER
      });

      expect(() => {
        valuationService.resolveLivePositionQuote({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24100 CE',
          instrumentType: 'OPTION',
        });
      }).toThrow(MarketDataUnavailableError);
    });

    it('Invariant 3: Option valuation fails closed if marketEventTime is missing', () => {
      const now = Date.now();
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue({
        symbol: 'NIFTY 24100 CE',
        price: 152.5,
        lastUpdated: now,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: undefined, // Missing
      });

      expect(() => {
        valuationService.resolveLivePositionQuote({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24100 CE',
          instrumentType: 'OPTION',
        });
      }).toThrow(MarketDataUnavailableError);
    });

    it('Invariant 4: Option valuation fails closed if quote is older than 10 seconds (stale)', () => {
      const now = Date.now();
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue({
        symbol: 'NIFTY 24100 CE',
        price: 152.5,
        lastUpdated: now,
        marketEventTime: now - 15000, // 15 seconds stale (> 10s)
        provenance: 'LIVE_PROVIDER',
      });

      expect(() => {
        valuationService.resolveLivePositionQuote({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24100 CE',
          instrumentType: 'OPTION',
        });
      }).toThrow(MarketDataUnavailableError);
    });

    it('Invariant 5: Option valuation fails closed if quote has invalid future timestamp (> 5s)', () => {
      const now = Date.now();
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue({
        symbol: 'NIFTY 24100 CE',
        price: 152.5,
        lastUpdated: now,
        marketEventTime: now + 10000, // 10 seconds in future (> 5s)
        provenance: 'LIVE_PROVIDER',
      });

      expect(() => {
        valuationService.resolveLivePositionQuote({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24100 CE',
          instrumentType: 'OPTION',
        });
      }).toThrow(MarketDataUnavailableError);
    });

    it('Invariant 6: Option valuation NEVER falls back to underlying index spot price', () => {
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue(null);
      (mockStreamerService.getValidatedTicker as jest.Mock).mockReturnValue({
        symbol: 'NIFTY_SPOT',
        price: 24175.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: Date.now(),
      });

      expect(() => {
        valuationService.resolveLivePositionQuote({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24100 CE',
          instrumentType: 'OPTION',
        });
      }).toThrow(MarketDataUnavailableError);

      // getValidatedTicker should NOT be invoked to value an option contract with underlying index
      expect(mockStreamerService.getValidatedTicker).not.toHaveBeenCalled();
    });

    it('Invariant 7: Spot valuation requires LIVE_PROVIDER provenance and valid marketEventTime', () => {
      const now = Date.now();
      (mockStreamerService.getValidatedTicker as jest.Mock).mockReturnValue({
        symbol: 'RELIANCE',
        price: 3000.0,
        lastUpdated: now,
        marketEventTime: now - 200,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM',
      });

      const quote = valuationService.resolveLivePositionQuote({
        symbol: 'RELIANCE',
        instrumentType: 'SPOT',
      });

      expect(quote.price).toBe(3000.0);
      expect(quote.provenance).toBe('LIVE_PROVIDER');
      expect(quote.isFresh).toBe(true);
    });
  });

  describe('Informational UI Mark (getInformationalPositionMark)', () => {
    it('Invariant 8: Informational method returns degraded mark without throwing when authoritative quote is unavailable', () => {
      (mockStreamerService.getOptionTicker as jest.Mock).mockReturnValue(null);

      const mark = valuationService.getInformationalPositionMark({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24100 CE',
        instrumentType: 'OPTION',
        currentPrice: 148.0,
      });

      expect(mark.price).toBe(148.0);
      expect(mark.isFresh).toBe(false);
      expect(mark.provenance).toBe('DEGRADED');
    });
  });
});
