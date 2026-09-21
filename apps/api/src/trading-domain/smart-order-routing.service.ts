import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  ISmartOrderRoutingDomainService,
  SlicingPlanParams,
  SlicingPlanResult,
  RouteOrderParams,
  RouteOrderResult,
  VenueQuote,
  ChildSlice,
  VenueAllocation,
} from '@quant/shared';

@Injectable()
export class SmartOrderRoutingService implements ISmartOrderRoutingDomainService {
  private readonly logger = new Logger(SmartOrderRoutingService.name);

  /**
   * Default U-shaped intraday volume distribution profile (e.g. 10 time intervals).
   * Reflects high opening volume, midday lull, and closing market surge.
   */
  private readonly DEFAULT_U_SHAPE_VWAP_PROFILE = [
    0.18, 0.12, 0.08, 0.06, 0.05, 0.05, 0.07, 0.09, 0.13, 0.17,
  ];

  /**
   * Generates an algorithmic child slice execution plan for a parent order.
   * Supports TWAP, VWAP, ICEBERG, and DIRECT algorithms with strict quantity conservation.
   */
  generateSlicingPlan(params: SlicingPlanParams): SlicingPlanResult {
    const {
      parentOrderId,
      symbol,
      direction,
      totalQuantity,
      slicingAlgorithm,
      durationSeconds = 300,
      numberOfSlices,
      displayQuantity,
      volumeProfile,
      minSliceQuantity,
      randomizeJitterPercent = 0,
    } = params;

    if (!parentOrderId || !symbol || !direction) {
      throw new BadRequestException('parentOrderId, symbol, and direction are required for slicing');
    }

    if (!totalQuantity || totalQuantity <= 0 || !Number.isFinite(totalQuantity)) {
      throw new BadRequestException(
        `Invalid parent order totalQuantity: ${totalQuantity}. Must be a finite positive number.`,
      );
    }

    if (durationSeconds <= 0 || !Number.isFinite(durationSeconds)) {
      throw new BadRequestException(
        `Invalid durationSeconds: ${durationSeconds}. Must be a positive number.`,
      );
    }

    const precision = 4;
    const slices: ChildSlice[] = [];

    switch (slicingAlgorithm) {
      case 'DIRECT': {
        slices.push({
          sliceIndex: 0,
          parentOrderId,
          sliceQuantity: Number(totalQuantity.toFixed(precision)),
          scheduledDelayMs: 0,
          status: 'PENDING',
        });
        break;
      }

      case 'ICEBERG': {
        if (!displayQuantity || displayQuantity <= 0 || !Number.isFinite(displayQuantity)) {
          throw new BadRequestException(
            `ICEBERG algorithm requires a valid positive displayQuantity. Got: ${displayQuantity}`,
          );
        }

        if (displayQuantity >= totalQuantity) {
          // Display quantity encompasses the entire order -> single slice
          slices.push({
            sliceIndex: 0,
            parentOrderId,
            sliceQuantity: Number(totalQuantity.toFixed(precision)),
            scheduledDelayMs: 0,
            status: 'PENDING',
          });
        } else {
          let remaining = totalQuantity;
          let sliceIdx = 0;
          const intervalMs = Math.max(1000, Math.floor((durationSeconds * 1000) / Math.ceil(totalQuantity / displayQuantity)));

          while (remaining > 0) {
            const currentSliceQty = Math.min(remaining, displayQuantity);
            const roundedQty = Number(currentSliceQty.toFixed(precision));
            slices.push({
              sliceIndex: sliceIdx,
              parentOrderId,
              sliceQuantity: roundedQty,
              scheduledDelayMs: sliceIdx * intervalMs,
              status: 'PENDING',
            });
            remaining = Number((remaining - roundedQty).toFixed(precision));
            sliceIdx++;
          }
        }
        break;
      }

      case 'VWAP': {
        const profile = this.calculateVwapVolumeProfile(
          volumeProfile && volumeProfile.length > 0
            ? volumeProfile
            : this.DEFAULT_U_SHAPE_VWAP_PROFILE,
        );

        const numBuckets = profile.length;
        const intervalMs = Math.floor((durationSeconds * 1000) / numBuckets);
        let allocatedQty = 0;

        for (let i = 0; i < numBuckets; i++) {
          let sliceQty: number;
          if (i === numBuckets - 1) {
            // Final slice strictly takes remaining quantity to guarantee mathematical conservation
            sliceQty = Number((totalQuantity - allocatedQty).toFixed(precision));
          } else {
            sliceQty = Number((totalQuantity * profile[i]).toFixed(precision));
            if (minSliceQuantity && sliceQty < minSliceQuantity) {
              sliceQty = minSliceQuantity;
            }
            allocatedQty = Number((allocatedQty + sliceQty).toFixed(precision));
          }

          let delayMs = i * intervalMs;
          if (randomizeJitterPercent > 0 && i > 0) {
            const maxJitter = (intervalMs * randomizeJitterPercent) / 100;
            const jitter = (Math.random() * 2 - 1) * maxJitter;
            delayMs = Math.max(0, Math.round(delayMs + jitter));
          }

          slices.push({
            sliceIndex: i,
            parentOrderId,
            sliceQuantity: sliceQty,
            scheduledDelayMs: delayMs,
            status: 'PENDING',
          });
        }
        break;
      }

      case 'TWAP':
      default: {
        const numSlices = numberOfSlices && numberOfSlices > 0 ? Math.floor(numberOfSlices) : 5;
        if (numSlices < 1) {
          throw new BadRequestException(`numberOfSlices must be at least 1. Got: ${numberOfSlices}`);
        }

        const intervalMs = Math.floor((durationSeconds * 1000) / numSlices);
        const baseSliceQty = Number((totalQuantity / numSlices).toFixed(precision));
        let allocatedQty = 0;

        for (let i = 0; i < numSlices; i++) {
          let sliceQty: number;
          if (i === numSlices - 1) {
            // Final slice strictly guarantees exact quantity conservation: sum(q_i) === totalQuantity
            sliceQty = Number((totalQuantity - allocatedQty).toFixed(precision));
          } else {
            sliceQty = baseSliceQty;
            allocatedQty = Number((allocatedQty + sliceQty).toFixed(precision));
          }

          let delayMs = i * intervalMs;
          if (randomizeJitterPercent > 0 && i > 0) {
            const maxJitter = (intervalMs * randomizeJitterPercent) / 100;
            const jitter = (Math.random() * 2 - 1) * maxJitter;
            delayMs = Math.max(0, Math.round(delayMs + jitter));
          }

          slices.push({
            sliceIndex: i,
            parentOrderId,
            sliceQuantity: sliceQty,
            scheduledDelayMs: delayMs,
            status: 'PENDING',
          });
        }
        break;
      }
    }

    // Mathematical quantity conservation assertion
    const sumQuantities = Number(
      slices.reduce((acc, s) => acc + s.sliceQuantity, 0).toFixed(precision),
    );
    const difference = Math.abs(sumQuantities - totalQuantity);
    if (difference > 1e-4) {
      this.logger.error(
        `[QUANTITY CONSERVATION BREACH] Sum of slices ${sumQuantities} != parent quantity ${totalQuantity}`,
      );
      return {
        parentOrderId,
        algorithm: slicingAlgorithm,
        totalQuantity,
        slices,
        estimatedDurationSeconds: durationSeconds,
        isValid: false,
        error: `Quantity conservation breach: sum(${sumQuantities}) != total(${totalQuantity})`,
      };
    }

    return {
      parentOrderId,
      algorithm: slicingAlgorithm,
      totalQuantity,
      slices,
      estimatedDurationSeconds: durationSeconds,
      isValid: true,
    };
  }

  /**
   * Evaluates available multi-venue quotes and selects optimal venue routing based on strategy.
   */
  routeOrder(params: RouteOrderParams): RouteOrderResult {
    const {
      parentOrderId,
      sliceIndex,
      symbol,
      direction,
      quantity,
      routingStrategy,
      availableVenues,
      maxAllowedLatencyMs = 1500,
    } = params;

    if (!quantity || quantity <= 0 || !Number.isFinite(quantity)) {
      throw new BadRequestException(`Invalid route quantity: ${quantity}. Must be positive.`);
    }

    // Filter healthy and responsive venues
    const healthyVenues = availableVenues.filter(
      (v) => v.isHealthy && v.latencyMs <= maxAllowedLatencyMs,
    );

    if (healthyVenues.length === 0) {
      throw new BadRequestException(
        `No healthy or low-latency venues available for symbol '${symbol}' (Strategy: ${routingStrategy}, Active venues: ${availableVenues.length}, Max Latency: ${maxAllowedLatencyMs}ms).`,
      );
    }

    const isBuy = direction === 'BUY';

    switch (routingStrategy) {
      case 'BEST_PRICE': {
        // BUY: lowest askPrice; SELL: highest bidPrice. Break ties with lowest latency.
        const sorted = [...healthyVenues].sort((a, b) => {
          const priceDiff = isBuy ? a.askPrice - b.askPrice : b.bidPrice - a.bidPrice;
          if (Math.abs(priceDiff) > 1e-6) return priceDiff;
          return a.latencyMs - b.latencyMs;
        });

        const best = sorted[0];
        const estimatedPrice = isBuy ? best.askPrice : best.bidPrice;
        const estimatedCostBps = best.takerFeeBps;

        return {
          parentOrderId,
          sliceIndex,
          selectedVenueId: best.venueId,
          routingStrategy,
          estimatedPrice,
          estimatedCostBps,
          routedQuantity: quantity,
          reason: `Selected venue '${best.venueId}' with best ${isBuy ? 'ask' : 'bid'} price: ${estimatedPrice} (Latency: ${best.latencyMs}ms)`,
        };
      }

      case 'LOWEST_COST': {
        // Computes all-in effective price including taker fees:
        // BUY: askPrice * (1 + takerFeeBps / 10000)
        // SELL: bidPrice * (1 - takerFeeBps / 10000)
        const scored = healthyVenues.map((v) => {
          const rawPrice = isBuy ? v.askPrice : v.bidPrice;
          const feeFactor = v.takerFeeBps / 10000;
          const effectivePrice = isBuy ? rawPrice * (1 + feeFactor) : rawPrice * (1 - feeFactor);
          return {
            venue: v,
            rawPrice,
            effectivePrice,
            feeBps: v.takerFeeBps,
          };
        });

        // For BUY, lower effective price is better; for SELL, higher effective net proceeds is better
        scored.sort((a, b) => {
          const diff = isBuy
            ? a.effectivePrice - b.effectivePrice
            : b.effectivePrice - a.effectivePrice;
          if (Math.abs(diff) > 1e-6) return diff;
          return a.venue.latencyMs - b.venue.latencyMs;
        });

        const best = scored[0];
        return {
          parentOrderId,
          sliceIndex,
          selectedVenueId: best.venue.venueId,
          routingStrategy,
          estimatedPrice: best.rawPrice,
          estimatedCostBps: best.feeBps,
          routedQuantity: quantity,
          reason: `Selected venue '${best.venue.venueId}' with lowest all-in net cost. Raw: ${best.rawPrice}, Fee: ${best.feeBps} bps, Effective: ${best.effectivePrice.toFixed(4)}`,
        };
      }

      case 'LOWEST_LATENCY': {
        const sorted = [...healthyVenues].sort((a, b) => a.latencyMs - b.latencyMs);
        const fastest = sorted[0];
        const estimatedPrice = isBuy ? fastest.askPrice : fastest.bidPrice;
        return {
          parentOrderId,
          sliceIndex,
          selectedVenueId: fastest.venueId,
          routingStrategy,
          estimatedPrice,
          estimatedCostBps: fastest.takerFeeBps,
          routedQuantity: quantity,
          reason: `Selected lowest-latency venue '${fastest.venueId}' (${fastest.latencyMs}ms). Price: ${estimatedPrice}`,
        };
      }

      case 'PRO_RATA_DEPTH': {
        // Allocate quantity across venues proportionally based on available touch depth
        const venuesWithDepth = healthyVenues.map((v) => ({
          venue: v,
          depth: isBuy ? v.askQuantity : v.bidQuantity,
          price: isBuy ? v.askPrice : v.bidPrice,
        }));

        const totalDepth = venuesWithDepth.reduce((acc, v) => acc + v.depth, 0);

        if (totalDepth <= 0) {
          // If all reported depths are zero, fallback to best price single routing
          const best = healthyVenues[0];
          return {
            parentOrderId,
            sliceIndex,
            selectedVenueId: best.venueId,
            routingStrategy,
            estimatedPrice: isBuy ? best.askPrice : best.bidPrice,
            estimatedCostBps: best.takerFeeBps,
            routedQuantity: quantity,
            reason: `Total depth 0 across venues; fell back to primary venue '${best.venueId}'`,
          };
        }

        const allocations: VenueAllocation[] = [];
        let allocatedTotal = 0;

        for (let i = 0; i < venuesWithDepth.length; i++) {
          const v = venuesWithDepth[i];
          let allocQty: number;

          if (i === venuesWithDepth.length - 1) {
            // Final venue absorbs remainder to ensure exact conservation
            allocQty = Number((quantity - allocatedTotal).toFixed(4));
          } else {
            const ratio = v.depth / totalDepth;
            allocQty = Number((quantity * ratio).toFixed(4));
            allocatedTotal = Number((allocatedTotal + allocQty).toFixed(4));
          }

          if (allocQty > 0) {
            allocations.push({
              venueId: v.venue.venueId,
              allocatedQuantity: allocQty,
              price: v.price,
              estimatedFeeBps: v.venue.takerFeeBps,
            });
          }
        }

        // Weighted average price
        const totalAllocated = allocations.reduce((a, b) => a + b.allocatedQuantity, 0);
        const weightedPrice =
          totalAllocated > 0
            ? Number(
                (
                  allocations.reduce((acc, a) => acc + a.price * a.allocatedQuantity, 0) /
                  totalAllocated
                ).toFixed(4),
              )
            : venuesWithDepth[0].price;

        const weightedFeeBps =
          totalAllocated > 0
            ? Number(
                (
                  allocations.reduce((acc, a) => acc + a.estimatedFeeBps * a.allocatedQuantity, 0) /
                  totalAllocated
                ).toFixed(2),
              )
            : healthyVenues[0].takerFeeBps;

        return {
          parentOrderId,
          sliceIndex,
          selectedVenueId: allocations[0]?.venueId || healthyVenues[0].venueId,
          routingStrategy,
          estimatedPrice: weightedPrice,
          estimatedCostBps: weightedFeeBps,
          routedQuantity: quantity,
          allocations,
          reason: `Pro-rata depth distribution across ${allocations.length} venues (Total market depth: ${totalDepth})`,
        };
      }

      case 'WATERFALL': {
        // Prioritize venues by best price first, filling up to each venue's available depth
        const sorted = [...healthyVenues].sort((a, b) => {
          return isBuy ? a.askPrice - b.askPrice : b.bidPrice - a.bidPrice;
        });

        const allocations: VenueAllocation[] = [];
        let unallocated = quantity;

        for (const v of sorted) {
          if (unallocated <= 0) break;
          const available = isBuy ? v.askQuantity : v.bidQuantity;
          const fillQty = Math.min(unallocated, available > 0 ? available : unallocated);
          const roundedFill = Number(fillQty.toFixed(4));

          allocations.push({
            venueId: v.venueId,
            allocatedQuantity: roundedFill,
            price: isBuy ? v.askPrice : v.bidPrice,
            estimatedFeeBps: v.takerFeeBps,
          });

          unallocated = Number((unallocated - roundedFill).toFixed(4));
        }

        // If unallocated remains, allocate to the best price venue
        if (unallocated > 0 && allocations.length > 0) {
          allocations[0].allocatedQuantity = Number(
            (allocations[0].allocatedQuantity + unallocated).toFixed(4),
          );
        }

        const totalAllocated = allocations.reduce((a, b) => a + b.allocatedQuantity, 0);
        const weightedPrice =
          totalAllocated > 0
            ? Number(
                (
                  allocations.reduce((acc, a) => acc + a.price * a.allocatedQuantity, 0) /
                  totalAllocated
                ).toFixed(4),
              )
            : sorted[0].askPrice;

        return {
          parentOrderId,
          sliceIndex,
          selectedVenueId: allocations[0]?.venueId || sorted[0].venueId,
          routingStrategy,
          estimatedPrice: weightedPrice,
          estimatedCostBps: allocations[0]?.estimatedFeeBps || sorted[0].takerFeeBps,
          routedQuantity: quantity,
          allocations,
          reason: `Waterfall routing sequentially filled across ${allocations.length} venue(s)`,
        };
      }

      default:
        throw new BadRequestException(`Unsupported routing strategy: ${routingStrategy}`);
    }
  }

  /**
   * Asserts that at least one routing venue is healthy and responsive.
   * Fails closed if all venues are unhealthy or exceed latency threshold.
   */
  assertRoutingHealthy(venues: VenueQuote[], maxAllowedLatencyMs = 1500): void {
    if (!venues || venues.length === 0) {
      throw new BadRequestException('Smart Order Routing assertion failed: Zero venues configured.');
    }

    const healthyCount = venues.filter(
      (v) => v.isHealthy && v.latencyMs <= maxAllowedLatencyMs,
    ).length;

    if (healthyCount === 0) {
      throw new BadRequestException(
        `Smart Order Routing assertion failed: All ${venues.length} venues are unhealthy or exceed max latency (${maxAllowedLatencyMs}ms). Failing closed.`,
      );
    }
  }

  /**
   * Normalizes an array of volume buckets into a proportional percentage volume profile summing to 1.0.
   */
  calculateVwapVolumeProfile(historicalBuckets: number[]): number[] {
    if (!historicalBuckets || historicalBuckets.length === 0) {
      throw new BadRequestException('historicalBuckets cannot be empty');
    }

    const sum = historicalBuckets.reduce((acc, v) => acc + v, 0);
    if (sum <= 0) {
      throw new BadRequestException('Sum of historical volume buckets must be positive');
    }

    return historicalBuckets.map((v) => Number((v / sum).toFixed(6)));
  }
}
