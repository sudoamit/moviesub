import {
  InstrumentDescriptor,
  PointInTimeCurrencyConverter,
  CostScheduleId,
  getAuthoritativeDescriptor,
} from '@quant/shared';

export type ExecutionStage = 'ENTRY' | 'TP1_PARTIAL' | 'TP2_PARTIAL' | 'FINAL_EXIT' | 'EXIT' | 'LIFECYCLE';

export interface CostCalculationInput {
  descriptor: InstrumentDescriptor;
  turnoverQuote: number;
  executionTimestamp?: number;
  stage?: ExecutionStage;
  side?: 'BUY' | 'SELL';
  overrideFxRate?: number;
}

export interface TransactionChargesBreakdown {
  brokerage: number;
  brokerageQuote: number;
  brokerageAccount: number;
  stt: number;
  exchangeFee: number;
  exchangeTurnover: number;
  sebi: number;
  sebiTurnover: number;
  stampDuty: number;
  gst: number;
  totalChargesQuote: number;
  totalChargesAccount: number;
  totalCharges: number; // alias for totalChargesAccount for backward-compat
  totalFees: number; // alias
  feeCurrency: string;
  accountCurrency: string;
  grossTurnoverQuote: number;
  grossTurnoverAccount: number;
  fxRate: number;
  fxRateTimestamp: number;
  fxTimestamp: number;
  scheduleVersion: string;
  feeCalculationBasis: string;
  instrumentType: string;
  stage: ExecutionStage;
}

export class TransactionCostScheduleManager {
  private static instance: TransactionCostScheduleManager;

  public static getInstance(): TransactionCostScheduleManager {
    if (!this.instance) {
      this.instance = new TransactionCostScheduleManager();
    }
    return this.instance;
  }

  public calculateCostForSymbol(
    turnoverQuote: number,
    symbolOrType: string,
    fxRate?: number,
    executionTimestamp = Date.now(),
    stage: ExecutionStage = 'ENTRY',
    side: 'BUY' | 'SELL' = 'BUY',
  ): TransactionChargesBreakdown {
    const descriptor = getAuthoritativeDescriptor(symbolOrType);
    return this.calculateCost({
      descriptor,
      turnoverQuote,
      executionTimestamp,
      stage,
      side,
      overrideFxRate: fxRate,
    });
  }

  public calculateCost(input: CostCalculationInput): TransactionChargesBreakdown {
    const { descriptor, turnoverQuote, executionTimestamp = Date.now(), stage = 'ENTRY', side = 'BUY' } = input;
    const converter = PointInTimeCurrencyConverter.getInstance();

    let fxRate = input.overrideFxRate;
    let fxTimestamp = executionTimestamp;

    if (!fxRate) {
      if (descriptor.quoteCurrency === descriptor.accountCurrency) {
        fxRate = 1.0;
      } else {
        const fxRes = converter.getRate(
          descriptor.quoteCurrency,
          descriptor.accountCurrency,
          executionTimestamp,
        );
        fxRate = fxRes.fxRate;
        fxTimestamp = fxRes.fxTimestamp;
      }
    }

    const grossTurnoverQuote = Number(turnoverQuote.toFixed(4));
    const grossTurnoverAccount = Number((grossTurnoverQuote * fxRate).toFixed(2));

    switch (descriptor.costScheduleId) {
      case 'NSE_OPTION_DELIVERY': {
        // Brokerage ₹20 flat
        const brokerage = 20.0;
        // STT: 0.125% on sell / exercise
        const isSell = side === 'SELL' || stage !== 'ENTRY';
        const stt = isSell ? Number((grossTurnoverAccount * 0.00125).toFixed(2)) : 0.0;
        // Exchange fee: 0.05% of turnover
        const exchangeFee = Number((grossTurnoverAccount * 0.0005).toFixed(2));
        // SEBI turnover charge: ₹10 per crore (0.000001)
        const sebi = Number((grossTurnoverAccount * 0.000001).toFixed(2));
        // Stamp Duty: 0.003% on buy
        const isBuy = side === 'BUY' && stage === 'ENTRY';
        const stampDuty = isBuy ? Number((grossTurnoverAccount * 0.00003).toFixed(2)) : 0.0;
        // GST: 18% on (Brokerage + Exchange + SEBI)
        const gstBase = brokerage + exchangeFee + sebi;
        const gst = Number((gstBase * 0.18).toFixed(2));
        const totalChargesAccount = Number(
          (brokerage + stt + exchangeFee + sebi + stampDuty + gst).toFixed(2),
        );

        return {
          brokerage,
          brokerageQuote: brokerage,
          brokerageAccount: brokerage,
          stt,
          exchangeFee,
          exchangeTurnover: exchangeFee,
          sebi,
          sebiTurnover: sebi,
          stampDuty,
          gst,
          totalChargesQuote: totalChargesAccount, // INR native
          totalChargesAccount,
          totalCharges: totalChargesAccount,
          totalFees: totalChargesAccount,
          feeCurrency: 'INR',
          accountCurrency: 'INR',
          grossTurnoverQuote,
          grossTurnoverAccount,
          fxRate,
          fxRateTimestamp: fxTimestamp,
          fxTimestamp,
          scheduleVersion: 'NSE_FO_OPTIONS_2024',
          feeCalculationBasis: 'NSE_FO_OPTIONS_SCHEDULE',
          instrumentType: 'OPTION',
          stage,
        };
      }

      case 'BINANCE_CRYPTO_SPOT': {
        // Binance 0.1% maker/taker in USDT
        const totalChargesQuote = Number((grossTurnoverQuote * 0.001).toFixed(4));
        const totalChargesAccount = Number((totalChargesQuote * fxRate).toFixed(2));

        return {
          brokerage: totalChargesAccount,
          brokerageQuote: totalChargesQuote,
          brokerageAccount: totalChargesAccount,
          stt: 0,
          exchangeFee: 0,
          exchangeTurnover: 0,
          sebi: 0,
          sebiTurnover: 0,
          stampDuty: 0,
          gst: 0,
          totalChargesQuote,
          totalChargesAccount,
          totalCharges: totalChargesAccount,
          totalFees: totalChargesAccount,
          feeCurrency: 'USDT',
          accountCurrency: 'INR',
          grossTurnoverQuote,
          grossTurnoverAccount,
          fxRate,
          fxRateTimestamp: fxTimestamp,
          fxTimestamp,
          scheduleVersion: 'BINANCE_SPOT_2024',
          feeCalculationBasis: 'BINANCE_SPOT_0_1_PERCENT',
          instrumentType: 'CRYPTO',
          stage,
        };
      }

      case 'COMEX_COMMODITY_SPOT': {
        // COMEX 0.02% spread/fee in USD
        const totalChargesQuote = Number((grossTurnoverQuote * 0.0002).toFixed(4));
        const totalChargesAccount = Number((totalChargesQuote * fxRate).toFixed(2));

        return {
          brokerage: totalChargesAccount,
          brokerageQuote: totalChargesQuote,
          brokerageAccount: totalChargesAccount,
          stt: 0,
          exchangeFee: 0,
          exchangeTurnover: 0,
          sebi: 0,
          sebiTurnover: 0,
          stampDuty: 0,
          gst: 0,
          totalChargesQuote,
          totalChargesAccount,
          totalCharges: totalChargesAccount,
          totalFees: totalChargesAccount,
          feeCurrency: 'USD',
          accountCurrency: 'INR',
          grossTurnoverQuote,
          grossTurnoverAccount,
          fxRate,
          fxRateTimestamp: fxTimestamp,
          fxTimestamp,
          scheduleVersion: 'COMEX_METALS_2024',
          feeCalculationBasis: 'COMEX_COMMISSION_0_02_PERCENT',
          instrumentType: 'COMMODITY',
          stage,
        };
      }

      case 'NSE_CASH_EQUITY':
      default: {
        // NSE Cash Delivery Rates: Brokerage ₹20 flat, STT 0.1% buy & sell, Exchange 0.00325%, Stamp 0.015% buy, SEBI ₹10/cr, GST 18%
        const brokerage = 20.0;
        const stt = Number((grossTurnoverAccount * 0.001).toFixed(2));
        const exchangeFee = Number((grossTurnoverAccount * 0.0000325).toFixed(2));
        const sebi = Number((grossTurnoverAccount * 0.000001).toFixed(2));
        const isBuy = side === 'BUY' && stage === 'ENTRY';
        const stampDuty = isBuy ? Number((grossTurnoverAccount * 0.00015).toFixed(2)) : 0.0;
        const gst = Number(((brokerage + exchangeFee + sebi) * 0.18).toFixed(2));
        const totalChargesAccount = Number(
          (brokerage + stt + exchangeFee + sebi + stampDuty + gst).toFixed(2),
        );

        return {
          brokerage,
          brokerageQuote: brokerage,
          brokerageAccount: brokerage,
          stt,
          exchangeFee,
          exchangeTurnover: exchangeFee,
          sebi,
          sebiTurnover: sebi,
          stampDuty,
          gst,
          totalChargesQuote: totalChargesAccount,
          totalChargesAccount,
          totalCharges: totalChargesAccount,
          totalFees: totalChargesAccount,
          feeCurrency: 'INR',
          accountCurrency: 'INR',
          grossTurnoverQuote,
          grossTurnoverAccount,
          fxRate,
          fxRateTimestamp: fxTimestamp,
          fxTimestamp,
          scheduleVersion: 'NSE_CASH_EQUITY_2024',
          feeCalculationBasis: 'NSE_CASH_EQUITY_SCHEDULE',
          instrumentType: 'EQUITY',
          stage,
        };
      }

    }
  }
}
