"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemporalDatasetBuilder = exports.DatasetManager = void 0;
const crypto = __importStar(require("crypto"));
class DatasetManager {
    datasets = new Map();
    /**
     * Registers and hashes an immutable training dataset.
     * Rejects duplicate sample IDs and sorts strictly chronologically.
     */
    createDataset(symbol, timeframe, samples, featureVersion = '2.0', strategyVersion = '2.0.0', randomSeed = 42) {
        if (!samples || samples.length === 0) {
            throw new Error('Cannot create dataset with empty samples');
        }
        // Deduplicate sample IDs - throw error on duplicate to prevent silent data corruption
        const seenIds = new Set();
        const deduplicated = [];
        for (const sample of samples) {
            if (seenIds.has(sample.sampleId)) {
                throw new Error(`DUPLICATE_SAMPLE_ID:${sample.sampleId}`);
            }
            seenIds.add(sample.sampleId);
            deduplicated.push(sample);
        }
        // Sort strictly by timestamp (chronological time-series order)
        const sorted = [...deduplicated].sort((a, b) => a.timestamp - b.timestamp);
        const startDate = new Date(sorted[0].timestamp).toISOString();
        const endDate = new Date(sorted[sorted.length - 1].timestamp).toISOString();
        const sampleFeatures = Object.keys(sorted[0].features || {}).sort();
        // Canonical serialization of all sample content for cryptographic provenance
        const canonicalSamplesString = sorted
            .map((s) => {
            const sortedFeatStr = sampleFeatures
                .map((k) => `${k}:${s.features[k] ?? 0}`)
                .join(',');
            const lEnd = s.labelEndTimestamp ?? s.timestamp;
            return `${s.sampleId}|${s.timestamp}|${lEnd}|${sortedFeatStr}|${s.labelBinary}|${s.labelContinuousR}|${s.regime}|${s.volatilityBucket}`;
        })
            .join('\n');
        const contentString = `${symbol}_${timeframe}_${startDate}_${endDate}_${sorted.length}_${sampleFeatures.join(',')}_seed${randomSeed}_version${strategyVersion}_features${featureVersion}\nCANONICAL_DATA:\n${canonicalSamplesString}`;
        const dataHash = crypto
            .createHash('sha256')
            .update(contentString)
            .digest('hex')
            .substring(0, 16);
        const datasetVersion = `v_${dataHash}`;
        const datasetId = `ds_${symbol}_${timeframe}_${dataHash}`;
        const metadata = {
            datasetId,
            datasetVersion,
            dataHash,
            symbol,
            timeframe,
            startDate,
            endDate,
            featureVersion,
            labelVersion: 'P(+1R)_and_RealizedR',
            strategyVersion,
            sampleCount: sorted.length,
            featuresList: sampleFeatures,
        };
        const record = { metadata, samples: Object.freeze(sorted) };
        this.datasets.set(datasetId, record);
        return record;
    }
    /**
     * Partitions a time-series dataset into strict sequential Train, Validation, and OOS splits
     * with label end timestamp purging and time-based embargo to prevent temporal overlap leakage.
     */
    splitDataset(datasetId, trainRatio = 0.6, valRatio = 0.2, oosRatio = 0.2, embargoMs = 0) {
        if (embargoMs < 0) {
            throw new Error(`INVALID_EMBARGO_DURATION:${embargoMs}`);
        }
        const record = this.datasets.get(datasetId);
        if (!record) {
            throw new Error(`Dataset '${datasetId}' not found`);
        }
        const total = record.samples.length;
        const trainEndIdx = Math.floor(total * trainRatio);
        const valEndIdx = Math.floor(total * (trainRatio + valRatio));
        const trainRaw = record.samples.slice(0, trainEndIdx);
        const valRaw = record.samples.slice(trainEndIdx, valEndIdx);
        const oosRaw = record.samples.slice(valEndIdx);
        // Calculate maximum label end timestamp in training partition for embargo purging
        let trainMaxLabelEnd = 0;
        for (const s of trainRaw) {
            const endTs = s.labelEndTimestamp ?? s.timestamp;
            if (endTs > trainMaxLabelEnd)
                trainMaxLabelEnd = endTs;
        }
        // Purge validation samples starting before/during active train label horizon + embargoMs
        const valPurged = valRaw.filter((s) => s.timestamp > trainMaxLabelEnd + embargoMs);
        if (valRaw.length > 0 && valPurged.length === 0) {
            throw new Error('INSUFFICIENT_PURGED_VALIDATION_DATA');
        }
        // Calculate maximum label end timestamp in validation partition
        let valMaxLabelEnd = trainMaxLabelEnd;
        for (const s of valPurged) {
            const endTs = s.labelEndTimestamp ?? s.timestamp;
            if (endTs > valMaxLabelEnd)
                valMaxLabelEnd = endTs;
        }
        // Purge OOS samples starting before/during active validation label horizon + embargoMs
        const oosPurged = oosRaw.filter((s) => s.timestamp > valMaxLabelEnd + embargoMs);
        if (oosRaw.length > 0 && oosPurged.length === 0) {
            throw new Error('INSUFFICIENT_PURGED_OOS_DATA');
        }
        return {
            train: Object.freeze(trainRaw),
            validation: Object.freeze(valPurged),
            outOfSample: Object.freeze(oosPurged),
            metadata: record.metadata,
        };
    }
    getDataset(datasetId) {
        return this.datasets.get(datasetId);
    }
}
exports.DatasetManager = DatasetManager;
exports.TemporalDatasetBuilder = DatasetManager;
//# sourceMappingURL=dataset-manager.js.map