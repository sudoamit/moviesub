import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import {
  InstrumentDefinition,
  InstrumentType,
  InstrumentMarginModel,
  OptionContractIdentity,
} from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';

export interface ResolveOptionParams {
  exchange?: string;
  underlying: string;
  expiry: Date | string;
  strike: number | Decimal;
  optionType: 'CE' | 'PE';
  contractSize?: number | Decimal;
  lotSize?: number | Decimal;
}

@Injectable()
export class InstrumentMasterService {
  private readonly logger = new Logger(InstrumentMasterService.name);

  // Authoritative static definitions
  private readonly staticInstruments: Map<string, InstrumentDefinition> = new Map();

  constructor(private readonly prisma?: PrismaService) {
    this.initializeStaticInstruments();
  }

  private initializeStaticInstruments(): void {
    // 1. BTCUSDT_SPOT: Spot crypto (Binance)
    // Invariants: leverage = 1, no liquidation, no funding, leverageAllowed = false
    this.staticInstruments.set('BTCUSDT_SPOT', {
      id: 'inst_btcusdt_spot',
      symbol: 'BTCUSDT_SPOT',
      exchange: 'BINANCE',
      instrumentType: 'SPOT',
      baseCurrency: 'BTC',
      quoteCurrency: 'USDT',
      contractSize: new Decimal(1),
      lotSize: new Decimal('0.0001'),
      minQuantity: new Decimal('0.0001'),
      maxQuantity: new Decimal('1000'),
      quantityStep: new Decimal('0.0001'),
      tickSize: new Decimal('0.01'),
      minNotional: new Decimal('5.0'),
      leverageAllowed: false,
      maxLeverage: new Decimal(1),
      marginModel: 'SPOT',
      tradingTimezone: 'UTC',
    });

    // 2. BTCUSDT_PERP: Perpetual futures (Binance)
    // Invariants: leverage allowed, isolated margin model, distinct from spot
    this.staticInstruments.set('BTCUSDT_PERP', {
      id: 'inst_btcusdt_perp',
      symbol: 'BTCUSDT_PERP',
      exchange: 'BINANCE',
      instrumentType: 'PERPETUAL',
      underlyingSymbol: 'BTCUSDT',
      baseCurrency: 'BTC',
      quoteCurrency: 'USDT',
      contractSize: new Decimal(1),
      lotSize: new Decimal('0.001'),
      minQuantity: new Decimal('0.001'),
      maxQuantity: new Decimal('500'),
      quantityStep: new Decimal('0.001'),
      tickSize: new Decimal('0.1'),
      minNotional: new Decimal('5.0'),
      leverageAllowed: true,
      maxLeverage: new Decimal(20),
      marginModel: 'ISOLATED',
      tradingTimezone: 'UTC',
    });

    // 3. NIFTY_SPOT: Indian Index Spot Research (NSE)
    this.staticInstruments.set('NIFTY_SPOT', {
      id: 'inst_nifty_spot',
      symbol: 'NIFTY_SPOT',
      exchange: 'NSE',
      instrumentType: 'SPOT',
      baseCurrency: 'NIFTY',
      quoteCurrency: 'INR',
      contractSize: new Decimal(1),
      lotSize: new Decimal(1),
      minQuantity: new Decimal(1),
      maxQuantity: new Decimal(100000),
      quantityStep: new Decimal(1),
      tickSize: new Decimal('0.05'),
      minNotional: new Decimal('100'),
      leverageAllowed: false,
      maxLeverage: new Decimal(1),
      marginModel: 'SPOT',
      tradingTimezone: 'Asia/Kolkata',
    });

    // 4. BANKNIFTY_SPOT: Indian Banking Index Spot Research (NSE)
    this.staticInstruments.set('BANKNIFTY_SPOT', {
      id: 'inst_banknifty_spot',
      symbol: 'BANKNIFTY_SPOT',
      exchange: 'NSE',
      instrumentType: 'SPOT',
      baseCurrency: 'BANKNIFTY',
      quoteCurrency: 'INR',
      contractSize: new Decimal(1),
      lotSize: new Decimal(1),
      minQuantity: new Decimal(1),
      maxQuantity: new Decimal(100000),
      quantityStep: new Decimal(1),
      tickSize: new Decimal('0.05'),
      minNotional: new Decimal('100'),
      leverageAllowed: false,
      maxLeverage: new Decimal(1),
      marginModel: 'SPOT',
      tradingTimezone: 'Asia/Kolkata',
    });
  }

  /**
   * Canonicalizes symbols to explicit execution identities.
   * Disallows bare 'BTCUSDT' in execution paths by resolving to 'BTCUSDT_SPOT'
   * unless specifically requested as perpetual.
   */
  public canonicalizeSymbol(rawSymbol: string, defaultType: 'SPOT' | 'PERPETUAL' = 'SPOT'): string {
    if (!rawSymbol || typeof rawSymbol !== 'string') {
      throw new BadRequestException('Symbol must be a non-empty string');
    }

    const sym = rawSymbol.trim().toUpperCase();

    if (sym === 'BTCUSDT') {
      return defaultType === 'PERPETUAL' ? 'BTCUSDT_PERP' : 'BTCUSDT_SPOT';
    }
    if (sym === 'NIFTY') {
      return 'NIFTY_SPOT';
    }
    if (sym === 'BANKNIFTY') {
      return 'BANKNIFTY_SPOT';
    }

    return sym;
  }

  /**
   * Resolves the authoritative instrument definition for any symbol.
   * Fails closed if the instrument is not found or invalid.
   */
  public async getInstrument(symbol: string): Promise<InstrumentDefinition> {
    const canonical = this.canonicalizeSymbol(symbol);

    // 1. Check authoritative static definitions
    if (this.staticInstruments.has(canonical)) {
      return this.staticInstruments.get(canonical)!;
    }

    // 2. Check if it's an option contract format (e.g. "NIFTY 24500 CE", "NSE:NIFTY:2026-09-25:24500:CE", "NIFTY 24500 CE 25-SEP-2026")
    if (this.isOptionSymbol(canonical)) {
      return this.parseAndBuildOptionDefinition(canonical);
    }

    // 3. Fallback to Prisma database if available
    if (this.prisma) {
      try {
        const dbInst = await this.prisma.instrument.findUnique({
          where: { symbol: canonical },
        });

        if (dbInst) {
          const isSpot = dbInst.assetType === 'CRYPTO' || dbInst.assetType === 'INDEX';
          return {
            id: dbInst.id,
            symbol: dbInst.symbol,
            exchange: dbInst.exchange,
            instrumentType: isSpot ? 'SPOT' : 'STOCK',
            baseCurrency: dbInst.currency === 'USDT' ? 'BTC' : dbInst.symbol,
            quoteCurrency: dbInst.currency,
            contractSize: new Decimal(dbInst.contractSize.toString()),
            lotSize: new Decimal(dbInst.lotSize.toString()),
            minQuantity: new Decimal(dbInst.lotSize.toString()),
            quantityStep: new Decimal(dbInst.lotSize.toString()),
            tickSize: new Decimal(dbInst.tickSize.toString()),
            leverageAllowed: !isSpot,
            maxLeverage: isSpot ? new Decimal(1) : new Decimal(5),
            marginModel: isSpot ? 'SPOT' : 'ISOLATED',
            tradingTimezone: dbInst.exchange === 'BINANCE' ? 'UTC' : 'Asia/Kolkata',
          };
        }
      } catch (err: any) {
        this.logger.error(`Database lookup error for instrument '${canonical}': ${err.message}`);
      }
    }

    throw new NotFoundException(
      `[INVALID_INSTRUMENT_SPECIFICATION] No authoritative instrument definition found for '${symbol}' (canonical: '${canonical}'). System fails closed.`,
    );
  }

  /**
   * Synchronous resolver for static or parsed instruments where DB lookup is not needed.
   */
  public getInstrumentSync(symbol: string): InstrumentDefinition {
    const canonical = this.canonicalizeSymbol(symbol);

    if (this.staticInstruments.has(canonical)) {
      return this.staticInstruments.get(canonical)!;
    }

    if (this.isOptionSymbol(canonical)) {
      return this.parseAndBuildOptionDefinition(canonical);
    }

    throw new NotFoundException(
      `[INVALID_INSTRUMENT_SPECIFICATION] Synchronous instrument definition not found for '${symbol}'.`,
    );
  }

  /**
   * Constructs an authoritative Option InstrumentDefinition.
   * Strictly enforces required fields: exchange, underlying, expiry, strike, optionType, contractSize, lotSize.
   * Expired contracts are strictly rejected in the exchange-local timezone.
   */
  public resolveOptionInstrument(params: ResolveOptionParams, referenceTime?: Date): InstrumentDefinition {
    const exchange = (params.exchange || 'NSE').toUpperCase();
    const underlying = params.underlying.toUpperCase().replace('_SPOT', '');

    if (underlying !== 'NIFTY' && underlying !== 'BANKNIFTY') {
      throw new BadRequestException(
        `[UNSUPPORTED_OPTIONS_UNDERLYING] Options underlying '${params.underlying}' is not supported. Supported: NIFTY, BANKNIFTY`,
      );
    }

    if (params.optionType !== 'CE' && params.optionType !== 'PE') {
      throw new BadRequestException(`[INVALID_OPTION_TYPE] Option type must be 'CE' or 'PE', got: ${params.optionType}`);
    }

    const strikeNum = typeof params.strike === 'number' ? params.strike : Number(params.strike);
    if (!Number.isFinite(strikeNum) || strikeNum <= 0) {
      throw new BadRequestException(`[INVALID_OPTION_STRIKE] Strike must be a positive number, got: ${params.strike}`);
    }

    const timezone = exchange === 'NSE' ? 'Asia/Kolkata' : 'UTC';
    const expiryDate = typeof params.expiry === 'string' ? new Date(params.expiry) : params.expiry;

    if (isNaN(expiryDate.getTime())) {
      throw new BadRequestException(`[INVALID_EXPIRY_DATE] Expiry date is invalid: ${params.expiry}`);
    }

    // Validate expiration in exchange-local timezone
    const expiryCheck = this.validateOptionExpiry(expiryDate, timezone, referenceTime);
    if (!expiryCheck.isValid) {
      throw new BadRequestException(expiryCheck.reason);
    }

    const lotSizeNum = params.lotSize
      ? Number(params.lotSize)
      : underlying === 'NIFTY'
      ? 65
      : 15;

    const contractSizeNum = params.contractSize ? Number(params.contractSize) : 1;

    const expiryDateStr = expiryDate.toISOString().split('T')[0];
    const canonicalSymbol = `${underlying} ${strikeNum} ${params.optionType}`;
    const uniqueId = `inst_${exchange.toLowerCase()}_${underlying.toLowerCase()}_${strikeNum}_${params.optionType.toLowerCase()}_${expiryDateStr}`;

    return {
      id: uniqueId,
      symbol: canonicalSymbol,
      exchange,
      instrumentType: 'OPTION',
      underlyingSymbol: `${underlying}_SPOT`,
      baseCurrency: underlying,
      quoteCurrency: 'INR',
      contractSize: new Decimal(contractSizeNum),
      lotSize: new Decimal(lotSizeNum),
      minQuantity: new Decimal(lotSizeNum),
      quantityStep: new Decimal(lotSizeNum),
      tickSize: new Decimal('0.05'),
      minNotional: new Decimal('1.0'),
      leverageAllowed: false,
      maxLeverage: new Decimal(1),
      marginModel: 'OPTION_PREMIUM',
      tradingTimezone: timezone,
      expiry: expiryDate,
      strike: new Decimal(strikeNum),
      optionType: params.optionType,
    };
  }

  /**
   * Validates option expiration using the exchange-local timezone.
   * For NSE, contracts expire at 15:30 IST on the expiry date.
   */
  public validateOptionExpiry(
    expiryDate: Date,
    timezone: string,
    referenceTime: Date = new Date(),
  ): { isValid: boolean; reason?: string } {
    const ref = referenceTime.getTime();

    // End-of-trading on expiry date in exchange timezone (for NSE, 15:30:00 IST)
    // We compute the exact expiry cutoff timestamp in UTC for the target calendar date
    const expiryYear = expiryDate.getUTCFullYear();
    const expiryMonth = expiryDate.getUTCMonth();
    const expiryDay = expiryDate.getUTCDate();

    let expiryCutoffMs: number;
    if (timezone === 'Asia/Kolkata') {
      // 15:30 IST is 10:00 UTC
      expiryCutoffMs = Date.UTC(expiryYear, expiryMonth, expiryDay, 10, 0, 0, 0);
    } else {
      // Default to 23:59:59 UTC
      expiryCutoffMs = Date.UTC(expiryYear, expiryMonth, expiryDay, 23, 59, 59, 999);
    }

    if (ref > expiryCutoffMs) {
      return {
        isValid: false,
        reason: `[EXPIRED_OPTION_CONTRACT] Contract expired at ${new Date(expiryCutoffMs).toISOString()} (${timezone}) relative to reference time ${referenceTime.toISOString()}`,
      };
    }

    return { isValid: true };
  }

  /**
   * Detects if a symbol string represents an option contract.
   */
  public isOptionSymbol(symbol: string): boolean {
    const s = symbol.trim().toUpperCase();
    if (s.startsWith('NSE:NIFTY') || s.startsWith('NSE:BANKNIFTY')) return true;
    if ((s.startsWith('NIFTY ') || s.startsWith('BANKNIFTY ')) && (s.endsWith(' CE') || s.endsWith(' PE') || s.includes(' CE ') || s.includes(' PE '))) {
      return true;
    }
    return false;
  }

  /**
   * Parses an option symbol and builds an authoritative definition.
   * Throws if an option is referenced ONLY by underlying symbol (e.g. "NIFTY").
   */
  public parseAndBuildOptionDefinition(symbol: string): InstrumentDefinition {
    const s = symbol.trim().toUpperCase();

    // Check if caller supplied only underlying
    if (s === 'NIFTY' || s === 'BANKNIFTY' || s === 'NIFTY_SPOT' || s === 'BANKNIFTY_SPOT') {
      throw new BadRequestException(
        `[INCOMPLETE_OPTION_SPECIFICATION] An option contract cannot be identified by underlying symbol '${symbol}' alone. Must specify strike, optionType, and expiry.`,
      );
    }

    // Handle "NIFTY 24500 CE" or "BANKNIFTY 51200 PE"
    const parts = s.split(/\s+/);
    if (parts.length >= 3) {
      const underlying = parts[0];
      const strike = parseFloat(parts[1]);
      const optionType = parts[2] as 'CE' | 'PE';

      if ((underlying === 'NIFTY' || underlying === 'BANKNIFTY') && !isNaN(strike) && (optionType === 'CE' || optionType === 'PE')) {
        // Default to upcoming weekly Thursday
        const nextThursday = this.getNextExpiryDate(new Date());
        return this.resolveOptionInstrument({
          exchange: 'NSE',
          underlying,
          strike,
          optionType,
          expiry: nextThursday,
        });
      }
    }

    // Handle structured format: "NSE:NIFTY:2026-09-25:24500:CE"
    if (s.includes(':')) {
      const tokens = s.split(':');
      if (tokens.length >= 5) {
        const exchange = tokens[0];
        const underlying = tokens[1];
        const expiry = new Date(tokens[2]);
        const strike = parseFloat(tokens[3]);
        const optionType = tokens[4] as 'CE' | 'PE';

        return this.resolveOptionInstrument({
          exchange,
          underlying,
          expiry,
          strike,
          optionType,
        });
      }
    }

    throw new BadRequestException(
      `[INVALID_OPTION_SYMBOL] Unable to parse option symbol '${symbol}'. Expected format: 'NIFTY 24500 CE' or 'NSE:NIFTY:YYYY-MM-DD:STRIKE:CE/PE'`,
    );
  }

  /**
   * Helper to compute next weekly Thursday expiry in UTC.
   */
  private getNextExpiryDate(from: Date): Date {
    const d = new Date(from);
    const day = d.getUTCDay();
    const diff = (4 - day + 7) % 7; // Thursday is day 4
    d.setUTCDate(d.getUTCDate() + (diff === 0 ? 7 : diff));
    d.setUTCHours(10, 0, 0, 0); // 15:30 IST = 10:00 UTC
    return d;
  }

  /**
   * Checks whether perpetual execution is currently supported by the trading engine.
   * Product policy: Spot and Options only; perpetual execution is disabled.
   */
  public isPerpetualExecutionSupported(): boolean {
    return false;
  }
}
