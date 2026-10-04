"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { PromptBar } from "@/components/react-bits/prompt-bar";
import Link from "next/link";
import type { ReactNode } from "react";

export const SUGGESTIONS = [
  "Let Stock and Yield manage $2,000 conservatively.",
  "Stock can use $1,000. Keep half of the capital untouched.",
  "Let the Stock agent manage $800.",
] as const;

export function appendSuggestion(prompt: string, chip: string): string {
  const clean = prompt.trim();
  if (clean === "") return chip.endsWith(".") ? chip : `${chip}.`;
  return `${clean}${/[.!?]$/.test(clean) ? "" : "."} ${chip.endsWith(".") ? chip : `${chip}.`}`;
}

export function PromptStage(props: {
  readonly prompt: string;
  readonly onPrompt: (value: string) => void;
  readonly onSend: () => void;
  readonly connected: boolean | null;
  readonly error: string;
}): ReactNode {
  const offline = props.connected === false;
  return (
    <div className="mw-compose">
      <p className="mw-compose__mark" aria-hidden="true">Mandate</p>
      <h1 className="mw-compose__title">What do you want your agents to do?</h1>
      <p className="mw-compose__lede">One bounded authority. Agents operate inside it. Mandate independently verifies every action.</p>
      <PromptBar
        tone="light"
        value={props.prompt}
        onChange={props.onPrompt}
        onSend={props.onSend}
        disabled={offline}
        label="What do you want your agents to do?"
        labelHidden
        placeholder="Let Stock and Yield manage $2,000 conservatively…"
        hint="Enter to send · Shift+Enter for a new line"
        sendLabel="Continue"
        busyLabel="Interpreting"
      />
      <div className="mw-chips" role="group" aria-label="Example mandates">
        {SUGGESTIONS.map((chip) => (
          <button key={chip} type="button" className="mw-chip" disabled={offline} onClick={() => props.onPrompt(chip)}>
            {chip}
          </button>
        ))}
      </div>
      {offline ? (
        <div className="mw-notice mw-notice--warn" role="alert">
          <strong>The local Live Demo server isn&apos;t running.</strong>
          <span>Start it from the repository root with <code>npm run agents:lab</code> or <code>npm run agents:serve</code>, then reload. Or watch the <Link href="/demo">Protocol Replay</Link>.</span>
        </div>
      ) : props.error !== "" ? (
        <p className="mw-notice mw-notice--bad" role="alert">{props.error}</p>
      ) : null}
    </div>
  );
}

/** Shown only while the draft request is actually open; no minimum duration. */
export function DraftingStage({ prompt }: { readonly prompt: string }): ReactNode {
  return (
    <div className="mw-drafting" aria-live="polite">
      <p className="mw-you"><span className="mw-you__label">You</span>{prompt}</p>
      <div className="mw-drafting__status">
        <LatticeLoader label="Interpreting mandate…" status="working" pattern="ripple" showTimer={false} className="mw-lattice--lg" />
        <ol className="mw-drafting__steps" aria-label="Interpretation progress">
          <li data-state="active">Interpreting mandate…</li>
          <li data-state="todo">Checking limits…</li>
          <li data-state="todo">Ready to review</li>
        </ol>
      </div>
    </div>
  );
}
