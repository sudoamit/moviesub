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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RISK_ENGINE_VERSION = void 0;
__exportStar(require("./types"), exports);
__exportStar(require("./position-sizer"), exports);
__exportStar(require("./drawdown-guard"), exports);
__exportStar(require("./portfolio-risk-manager"), exports);
__exportStar(require("./trade-lifecycle-manager"), exports);
__exportStar(require("./execution-safety-gate"), exports);
exports.RISK_ENGINE_VERSION = '1.0.0';
//# sourceMappingURL=index.js.map