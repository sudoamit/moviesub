import { BadRequestException } from '@nestjs/common';
import { SmartOrderRoutingService } from '../smart-order-routing.service';
import { VenueQuote } from '@quant/shared';

describe('Phase 27 — Smart Order Routing (SOR) & Execution Slicing Algorithms', () => {
  let sorService: SmartOrderRoutingService;

  beforeEach(() => {
    sorService = new SmartOrderRoutingService();
  });

  const createMockVenues = (): VenueQuote[] => [
    {
      venueId: 'VENUE_ALPHA',
      venueName: 'Alpha Exchange',
      symbol: 'BTCUSDT',
      bidPrice: 50000.0,
      bidQuantity: 10.0,
      askPrice: 50002.0,
      askQuantity: 12.0,
      makerFeeBps: 1.0,
      takerFeeBps: 4.0,
      latencyMs: 15,
      isHealthy: true,
      lastUpdated: Date.now(),
    },
    {
      venueId: 'VENUE_BETA',
      venueName: 'Beta Broker ECN',
      symbol: 'BTCUSDT',
      bidPrice: 50001.0,
      bidQuantity: 5.0,
      askPrice: 50001.5,
      askQuantity: 6.0,
      makerFeeBps: 2.0,
      takerFeeBps: 8.0,
      latencyMs: 45,
      isHealthy: true,
      lastUpdated: Date.now(),
    },
    {
      venueId: 'VENUE_GAMMA',
      venueName: 'Gamma Liquidity Pool',
      symbol: 'BTCUSDT',
      bidPrice: 49999.0,
      bidQuantity: 20.0,
      askPrice: 50003.0,
      askQuantity: 25.0,
      makerFeeBps: 0.5,
      takerFeeBps: 1.0,
      latencyMs: 8,
      isHealthy: true,
      lastUpdated: Date.now(),
    },
  ];

  describe('1. TWAP Slicing Engine', () => {
    it('should split parent order into equal uniform slices with exact quantity conservation', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_twap_001',
        symbol: 'BTCUSDT',
        direction: 'BUY',
        totalQuantity: 10.0,
        slicingAlgorithm: 'TWAP',
        numberOfSlices: 5,
        durationSeconds: 100,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(5);
      expect(plan.slices[0].scheduledDelayMs).toBe(0);
      expect(plan.slices[1].scheduledDelayMs).toBe(20000);
      expect(plan.slices[2].scheduledDelayMs).toBe(40000);
      expect(plan.slices[3].scheduledDelayMs).toBe(60000);
      expect(plan.slices[4].scheduledDelayMs).toBe(80000);

      // Verify exact quantity conservation
      const totalAllocated = plan.slices.reduce((sum, s) => sum + s.sliceQuantity, 0);
      expect(totalAllocated).toBeCloseTo(10.0, 4);
      expect(plan.slices.every((s) => s.sliceQuantity === 2.0)).toBe(true);
    });

    it('should maintain exact mathematical conservation when quantity cannot be divided cleanly', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_twap_remainder',
        symbol: 'ETHUSDT',
        direction: 'SELL',
        totalQuantity: 10.0,
        slicingAlgorithm: 'TWAP',
        numberOfSlices: 3, // 10 / 3 = 3.3333...
        durationSeconds: 90,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(3);
      const sum = plan.slices.reduce((acc, s) => acc + s.sliceQuantity, 0);
      expect(sum).toBeCloseTo(10.0, 4);
    });

    it('should apply randomized time jitter without breaching quantity conservation', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_twap_jitter',
        symbol: 'NIFTY',
        direction: 'BUY',
        totalQuantity: 50.0,
        slicingAlgorithm: 'TWAP',
        numberOfSlices: 5,
        durationSeconds: 200,
        randomizeJitterPercent: 15,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(5);
      expect(plan.slices[0].scheduledDelayMs).toBe(0); // first slice has zero delay

      const total = plan.slices.reduce((acc, s) => acc + s.sliceQuantity, 0);
      expect(total).toBeCloseTo(50.0, 4);
    });
  });

  describe('2. VWAP Slicing Engine', () => {
    it('should distribute slice quantities according to volume curve with exact sum conservation', () => {
      // 4 custom buckets: [30%, 20%, 10%, 40%]
      const customProfile = [300, 200, 100, 400];
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_vwap_001',
        symbol: 'RELIANCE',
        direction: 'BUY',
        totalQuantity: 1000.0,
        slicingAlgorithm: 'VWAP',
        volumeProfile: customProfile,
        durationSeconds: 400,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(4);
      expect(plan.slices[0].sliceQuantity).toBeCloseTo(300.0, 1);
      expect(plan.slices[1].sliceQuantity).toBeCloseTo(200.0, 1);
      expect(plan.slices[2].sliceQuantity).toBeCloseTo(100.0, 1);
      expect(plan.slices[3].sliceQuantity).toBeCloseTo(400.0, 1);

      const total = plan.slices.reduce((acc, s) => acc + s.sliceQuantity, 0);
      expect(total).toBeCloseTo(1000.0, 4);
    });

    it('should utilize default U-shaped intraday profile when none provided', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_vwap_default',
        symbol: 'BANKNIFTY',
        direction: 'SELL',
        totalQuantity: 500.0,
        slicingAlgorithm: 'VWAP',
        durationSeconds: 600,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(10); // default profile has 10 buckets
      const total = plan.slices.reduce((acc, s) => acc + s.sliceQuantity, 0);
      expect(total).toBeCloseTo(500.0, 4);
    });
  });

  describe('3. Iceberg Execution Slicing Engine', () => {
    it('should break parent order into visible displayQuantity chunks and hidden remainder', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_iceberg_001',
        symbol: 'BTCUSDT',
        direction: 'BUY',
        totalQuantity: 25.0,
        slicingAlgorithm: 'ICEBERG',
        displayQuantity: 10.0,
        durationSeconds: 300,
      });

      expect(plan.isValid).toBe(true);
      expect(plan.slices.length).toBe(3); // 10, 10, 5
      expect(plan.slices[0].sliceQuantity).toBe(10.0);
      expect(plan.slices[1].sliceQuantity).toBe(10.0);
      expect(plan.slices[2].sliceQuantity).toBe(5.0);

      const sum = plan.slices.reduce((acc, s) => acc + s.sliceQuantity, 0);
      expect(sum).toBe(25.0);
    });

    it('should return a single slice if displayQuantity >= totalQuantity', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_iceberg_single',
        symbol: 'BTCUSDT',
        direction: 'BUY',
        totalQuantity: 5.0,
        slicingAlgorithm: 'ICEBERG',
        displayQuantity: 10.0,
      });

      expect(plan.slices.length).toBe(1);
      expect(plan.slices[0].sliceQuantity).toBe(5.0);
    });

    it('should throw BadRequestException on invalid displayQuantity for ICEBERG', () => {
      expect(() => {
        sorService.generateSlicingPlan({
          parentOrderId: 'parent_iceberg_bad',
          symbol: 'BTCUSDT',
          direction: 'BUY',
          totalQuantity: 5.0,
          slicingAlgorithm: 'ICEBERG',
          displayQuantity: 0,
        });
      }).toThrow(BadRequestException);
    });
  });

  describe('4. Direct Pass-Through Execution', () => {
    it('should return a single non-delayed slice for DIRECT orders', () => {
      const plan = sorService.generateSlicingPlan({
        parentOrderId: 'parent_direct_001',
        symbol: 'BTCUSDT',
        direction: 'BUY',
        totalQuantity: 2.5,
        slicingAlgorithm: 'DIRECT',
      });

      expect(plan.slices.length).toBe(1);
      expect(plan.slices[0].sliceQuantity).toBe(2.5);
      expect(plan.slices[0].scheduledDelayMs).toBe(0);
    });
  });

  describe('5. Smart Order Routing (SOR) — Strategies', () => {
    it('should route BUY to lowest askPrice and SELL to highest bidPrice under BEST_PRICE', () => {
      const venues = createMockVenues();
      // Venues askPrices: Alpha: 50002.0, Beta: 50001.5, Gamma: 50003.0
      const buyRoute = sorService.routeOrder({
        parentOrderId: 'parent_sor_01',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2.0,
        routingStrategy: 'BEST_PRICE',
        availableVenues: venues,
      });

      expect(buyRoute.selectedVenueId).toBe('VENUE_BETA'); // 50001.5 is lowest ask
      expect(buyRoute.estimatedPrice).toBe(50001.5);

      // Venues bidPrices: Alpha: 50000.0, Beta: 50001.0, Gamma: 49999.0
      const sellRoute = sorService.routeOrder({
        parentOrderId: 'parent_sor_02',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'SELL',
        quantity: 2.0,
        routingStrategy: 'BEST_PRICE',
        availableVenues: venues,
      });

      expect(sellRoute.selectedVenueId).toBe('VENUE_BETA'); // 50001.0 is highest bid
      expect(sellRoute.estimatedPrice).toBe(50001.0);
    });

    it('should route based on all-in net cost factoring in taker fees under LOWEST_COST', () => {
      const venues = createMockVenues();
      // VENUE_BETA: ask 50001.5, fee 8 bps -> 50001.5 * (1 + 0.0008) = 50041.50
      // VENUE_GAMMA: ask 50003.0, fee 1 bps -> 50003.0 * (1 + 0.0001) = 50008.00 (Much cheaper all-in!)
      const buyRoute = sorService.routeOrder({
        parentOrderId: 'parent_sor_cost',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 1.0,
        routingStrategy: 'LOWEST_COST',
        availableVenues: venues,
      });

      expect(buyRoute.selectedVenueId).toBe('VENUE_GAMMA');
    });

    it('should select the fastest healthy venue under LOWEST_LATENCY', () => {
      const venues = createMockVenues();
      // Latencies: Alpha 15ms, Beta 45ms, Gamma 8ms
      const route = sorService.routeOrder({
        parentOrderId: 'parent_sor_latency',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 1.0,
        routingStrategy: 'LOWEST_LATENCY',
        availableVenues: venues,
      });

      expect(route.selectedVenueId).toBe('VENUE_GAMMA'); // 8ms
    });

    it('should split order across venues proportionally under PRO_RATA_DEPTH', () => {
      const venues = createMockVenues();
      // BUY ask quantities: Alpha 12.0, Beta 6.0, Gamma 25.0 -> Total 43.0
      const route = sorService.routeOrder({
        parentOrderId: 'parent_sor_prorata',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 10.0,
        routingStrategy: 'PRO_RATA_DEPTH',
        availableVenues: venues,
      });

      expect(route.allocations).toBeDefined();
      expect(route.allocations!.length).toBe(3);

      const sumAllocated = route.allocations!.reduce((acc, a) => acc + a.allocatedQuantity, 0);
      expect(sumAllocated).toBeCloseTo(10.0, 4);
    });

    it('should sequentially fill up to venue depth and overflow under WATERFALL', () => {
      const venues = createMockVenues();
      // BUY askPrices: Beta 50001.5 (depth 6.0), Alpha 50002.0 (depth 12.0), Gamma 50003.0 (depth 25.0)
      // An order of 10.0 should take all 6.0 from Beta, and remaining 4.0 from Alpha
      const route = sorService.routeOrder({
        parentOrderId: 'parent_sor_waterfall',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 10.0,
        routingStrategy: 'WATERFALL',
        availableVenues: venues,
      });

      expect(route.allocations).toBeDefined();
      expect(route.allocations!.length).toBe(2);
      expect(route.allocations![0].venueId).toBe('VENUE_BETA');
      expect(route.allocations![0].allocatedQuantity).toBe(6.0);
      expect(route.allocations![1].venueId).toBe('VENUE_ALPHA');
      expect(route.allocations![1].allocatedQuantity).toBe(4.0);

      const totalAllocated = route.allocations!.reduce((acc, a) => acc + a.allocatedQuantity, 0);
      expect(totalAllocated).toBe(10.0);
    });
  });

  describe('6. Venue Health & Latency Gating', () => {
    it('should ignore unhealthy venues or venues with latency exceeding maxAllowedLatencyMs', () => {
      const venues = createMockVenues();
      // Mark fastest / best price venue as unhealthy
      venues[1].isHealthy = false; // Beta is unhealthy
      venues[2].latencyMs = 2500; // Gamma has severe lag (> 1500ms default)

      const route = sorService.routeOrder({
        parentOrderId: 'parent_sor_healthy',
        sliceIndex: 0,
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 1.0,
        routingStrategy: 'BEST_PRICE',
        availableVenues: venues,
        maxAllowedLatencyMs: 1500,
      });

      // Only VENUE_ALPHA is both healthy and low latency
      expect(route.selectedVenueId).toBe('VENUE_ALPHA');
    });

    it('should fail closed throwing BadRequestException when no healthy venues are available', () => {
      const venues = createMockVenues();
      venues.forEach((v) => (v.isHealthy = false));

      expect(() => {
        sorService.routeOrder({
          parentOrderId: 'parent_sor_all_dead',
          sliceIndex: 0,
          symbol: 'BTCUSDT',
          direction: 'BUY',
          quantity: 1.0,
          routingStrategy: 'BEST_PRICE',
          availableVenues: venues,
        });
      }).toThrow(BadRequestException);
    });

    it('should assert routing health and throw when all venues are degraded', () => {
      const venues = createMockVenues();
      expect(() => sorService.assertRoutingHealthy(venues, 1000)).not.toThrow();

      venues.forEach((v) => (v.isHealthy = false));
      expect(() => sorService.assertRoutingHealthy(venues, 1000)).toThrow(BadRequestException);
    });
  });

  describe('7. Fail-Closed Edge Cases & Robustness', () => {
    it('should throw BadRequestException on non-positive parent quantities or invalid slices', () => {
      expect(() => {
        sorService.generateSlicingPlan({
          parentOrderId: 'parent_bad_qty',
          symbol: 'BTCUSDT',
          direction: 'BUY',
          totalQuantity: -5.0,
          slicingAlgorithm: 'TWAP',
        });
      }).toThrow(BadRequestException);

      expect(() => {
        sorService.generateSlicingPlan({
          parentOrderId: 'parent_bad_dur',
          symbol: 'BTCUSDT',
          direction: 'BUY',
          totalQuantity: 10.0,
          slicingAlgorithm: 'TWAP',
          durationSeconds: 0,
        });
      }).toThrow(BadRequestException);
    });
  });
});
