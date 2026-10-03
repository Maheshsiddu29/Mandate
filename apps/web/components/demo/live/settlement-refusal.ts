/**
 * How a refused settle call is shown. Presentation only: the codes are the
 * server's, and a missing field stays blank rather than being filled in.
 */

export interface SettlementRefusalInput {
  readonly code: string;
  readonly message: string;
  readonly stage: string | null;
  readonly transactions: number | null;
  readonly txHash: string | null;
}

export interface SettlementRefusal {
  readonly summary: string;
  readonly code: string;
  readonly message: string;
  readonly stage: string | null;
  readonly transactions: number | null;
  readonly txHash: string | null;
}

const SUMMARY: Readonly<Record<string, string>> = {
  SEND_NOT_AUTHORIZED: "Execution was not accepted. Nothing was sent.",
  SETTLEMENT_IN_PROGRESS: "Execution is already in progress.",
  BUSY: "A run is still in progress. Nothing was sent.",
  NO_PENDING_SIGNATURE: "Choose Execute again. Nothing was sent.",
  SPINE_EXPIRED: "Authorization expired. Review and authorize a fresh mandate.",
  NO_STOCK_RESERVATION: "There is no Stock reservation to execute. Nothing was sent.",
  STOCK_RESERVATION_AMBIGUOUS: "More than one Stock reservation is open. Nothing was sent.",
  LIVE_MODEL_REQUIRED_FOR_TESTNET_SEND: "A live model session is required before a testnet send. Nothing was sent.",
  SPINE_METHOD_REQUIRED: "Connect the wallet that authorized this mandate. Nothing was sent.",
  GATE_EXECUTION_AUTHORITY_REQUIRED: "Wallet authorization required. Nothing was sent.",
};

/** Codes for which another Execute click cannot succeed until something else changes. */
const NO_RETRY = new Set([
  "SPINE_EXPIRED",
  "SETTLEMENT_IN_PROGRESS",
  "BUSY",
  "NO_STOCK_RESERVATION",
  "STOCK_RESERVATION_AMBIGUOUS",
  "SPINE_METHOD_REQUIRED",
]);

export function settlementRefusal(input: SettlementRefusalInput): SettlementRefusal {
  const code = input.code;
  const known = SUMMARY[code];
  const summary = known ?? (input.message === "" ? "Execution was refused. Nothing was sent." : input.message);
  return {
    summary,
    code,
    message: input.message,
    stage: input.stage,
    transactions: input.transactions,
    txHash: input.txHash,
  };
}

/** A fresh Execute click is a new request. These codes must not offer one. */
export function executionRetry(code: string | null): boolean {
  if (code === null || code === "") return true;
  if (code.includes("CONSUMED")) return false;
  return !NO_RETRY.has(code);
}

/**
 * A refusal before any broadcast is not an onchain failure.
 * "Settlement failed" is only for a transaction that was submitted.
 */
/** The proof pill. A refusal with no transaction is not a failed receipt. */
export function proofStatus(input: { readonly settled: boolean; readonly stage: string; readonly txHash: string | null }): string {
  if (input.settled) return "CONFIRMED";
  const submitted = input.txHash !== null && input.txHash !== "";
  if (!submitted && (input.stage === "FAILED" || input.stage === "PREFLIGHT_FAILED" || input.stage === "SIMULATION_FAILED")) return "NOT SENT";
  switch (input.stage) {
    case "READY_FOR_SEND":
    case "SPINE_READY":
      return "READY · NOT SENT";
    case "RECONCILING":
      return "CHECKING";
    case "NEEDS_REVIEW":
      return "NEEDS REVIEW";
    case "RELEASED":
      return submitted ? "FAILED" : "NOT EXECUTED";
    case "FAILED":
      return "FAILED";
    default:
      return input.stage.replaceAll("_", " ");
  }
}

export function receiptHeading(input: { readonly settled: boolean; readonly txHash: string | null; readonly stage: string; readonly refused: boolean }): { readonly title: string; readonly pill: string } {
  if (input.settled) return { title: "Settled", pill: "✓ Settled" };
  const submitted = input.txHash !== null && input.txHash !== "";
  if (submitted && (input.stage === "FAILED" || input.stage === "RELEASED")) return { title: "Settlement failed", pill: "✕ Not settled" };
  if (input.refused || input.stage === "FAILED" || input.stage === "PREFLIGHT_FAILED" || input.stage === "SIMULATION_FAILED") {
    return { title: "Not sent", pill: "✕ Not sent" };
  }
  if (input.stage === "NEEDS_REVIEW") return { title: "Settlement needs review", pill: "! Needs review" };
  if (input.stage === "SUBMITTED" || input.stage === "RECONCILING") return { title: "Confirming", pill: "Confirming" };
  return { title: "Portfolio authorized", pill: "✓ Authorized" };
}
