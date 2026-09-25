/**
 * Human-readable rendering of a selection, kept strictly separate from the
 * decision — exactly as the kernel keeps `explain` separate from `verify`.
 *
 * Nothing here influences an outcome, and nothing here is derived from model
 * free text. The summary is built from the receipt's own enumerated fields.
 *
 * The trader-facing surface stays small on purpose. A probability matrix is
 * not a thing an ordinary user should be asked to read before a trade, so it
 * is available only in the detail lines and only when explicitly requested.
 */

import {
  JevFallbackReason,
  SelectionMode,
  type JevDecisionReceipt,
} from './types.ts';
import type { JevRoutingResult } from './decide.ts';

export interface SelectionSummary {
  /** One line. The only thing an ordinary user has to read. */
  readonly headline: string;
  /** Null when the advisory layer was not involved in the outcome. */
  readonly decisionMode: string | null;
  readonly confidencePercent: number | null;
  /** Progressive disclosure: shown behind an "advanced" affordance. */
  readonly detail: readonly string[];
}

const MODE_LABEL: Record<SelectionMode, string> = {
  [SelectionMode.DETERMINISTIC]: 'Deterministic',
  [SelectionMode.JEV_ASSISTED]: 'Jev-assisted',
  [SelectionMode.JEV_ABSTAINED]: 'Deterministic (Jev abstained)',
  [SelectionMode.JEV_FALLBACK]: 'Deterministic (Jev unavailable)',
};

/** `Route A`, `Route B`, … and a plain index beyond the alphabet. */
export function routeLabel(index: number): string {
  if (index < 0) return 'Route ?';
  if (index < 26) return `Route ${String.fromCharCode(65 + index)}`;
  return `Route #${index + 1}`;
}

function confidenceLine(receipt: JevDecisionReceipt | null): number | null {
  if (receipt === null || receipt.confidence === null) return null;
  if (receipt.selectionMode !== SelectionMode.JEV_ASSISTED) return null;
  return Math.round(receipt.confidence * 100);
}

export interface SummaryOptions {
  /** Include the full probability distribution. Off by default. */
  readonly includeProbabilities?: boolean;
}

export function summarizeSelection(result: JevRoutingResult, options: SummaryOptions = {}): SelectionSummary {
  const receipt = result.jevReceipt;
  const detail: string[] = [];
  const validRoutes = receipt?.candidateIds.length ?? 0;

  if (result.status === 'INVALID_INPUT') {
    return { headline: 'Request could not be evaluated', decisionMode: null, confidencePercent: null, detail: ['The routing request did not parse. No execution was considered.'] };
  }

  if (result.status === 'NO_VALID_ROUTE') {
    const headline = 'No valid execution found';
    detail.push(`${validRoutes} route${validRoutes === 1 ? '' : 's'} passed mandate verification.`);
    if (result.handoffRejected) {
      detail.push('The selected route was re-checked against current market state and refused.');
      detail.push('Final Mandate verification: REJECT');
    } else {
      detail.push('No route satisfied the mandate.');
    }
    return { headline, decisionMode: receipt === null ? null : MODE_LABEL[receipt.selectionMode], confidencePercent: null, detail };
  }

  const selectedIndex = receipt === null ? -1 : receipt.candidateDigests.findIndex((digest) => digest === result.selected.candidateDigest);
  detail.push(`${validRoutes} valid route${validRoutes === 1 ? '' : 's'}`);

  if (receipt !== null && receipt.selectionMode === SelectionMode.JEV_ASSISTED) {
    detail.push(`Jev selected ${routeLabel(selectedIndex)}`);
  } else if (receipt !== null && receipt.selectionMode === SelectionMode.JEV_ABSTAINED) {
    detail.push(`Jev abstained; deterministic ranking selected ${routeLabel(selectedIndex)}`);
  } else if (receipt !== null && receipt.selectionMode === SelectionMode.JEV_FALLBACK) {
    detail.push(`Advisory selection unavailable (${receipt.fallbackReason ?? JevFallbackReason.JEV_DISABLED}); deterministic ranking selected ${routeLabel(selectedIndex)}`);
  } else {
    detail.push(`Deterministic ranking selected ${routeLabel(selectedIndex)}`);
  }

  detail.push('Final Mandate verification: PASS');

  if (options.includeProbabilities === true && receipt !== null && receipt.probabilities.length > 0) {
    for (const [name, value] of receipt.probabilities) detail.push(`  ${name}: ${(value * 100).toFixed(1)}%`);
  }

  return {
    headline: 'Best valid execution found',
    decisionMode: receipt === null ? null : MODE_LABEL[receipt.selectionMode],
    confidencePercent: confidenceLine(receipt),
    detail,
  };
}

/** Plain-text rendering, for a CLI or a log line. */
export function renderSelectionSummary(summary: SelectionSummary): string {
  const lines = [summary.headline];
  if (summary.decisionMode !== null) lines.push(`Decision mode: ${summary.decisionMode}`);
  if (summary.confidencePercent !== null) lines.push(`Confidence: ${summary.confidencePercent}%`);
  return lines.join('\n');
}
