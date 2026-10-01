"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { PromptBar } from "@/components/react-bits/prompt-bar";
import Link from "next/link";
import type { ReactNode } from "react";

export const SUGGESTIONS = [
  "Deploy $2,000",
  "Keep $300 unallocated",
  "Limit derivatives to $400",
  "Approved venues only",
  "Prefer stocks + yield",
] as const;

export function appendSuggestion(prompt: string, chip: string): string {
  const clean = prompt.trim();
  if (clean === "") return `${chip}.`;
  return `${clean}${/[.!?]$/.test(clean) ? "" : "."} ${chip}.`;
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
      <h1 className="mw-compose__title">What should your agents do?</h1>
      <p className="mw-compose__lede">Describe the job. Mandate turns it into explicit authority before any agent acts.</p>
      <PromptBar
        tone="light"
        value={props.prompt}
        onChange={props.onPrompt}
        onSend={props.onSend}
        disabled={offline}
        label="Tell Mandate what your agents may do"
        labelHidden
        placeholder="Deploy $2,000 across approved strategies while keeping derivatives under $400…"
        hint="Enter to send · Shift+Enter for a new line"
        sendLabel="Build mandate"
        busyLabel="Building mandate"
      />
      <div className="mw-chips" role="group" aria-label="Prompt suggestions">
        {SUGGESTIONS.map((chip) => (
          <button key={chip} type="button" className="mw-chip" disabled={offline} onClick={() => props.onPrompt(appendSuggestion(props.prompt, chip))}>
            {chip}
          </button>
        ))}
      </div>
      {offline ? (
        <div className="mw-notice mw-notice--warn" role="alert">
          <strong>The local Live Demo server isn&apos;t running.</strong>
          <span>Start it from the repository root with <code>npm run agents:serve</code>, then reload. Or watch the <Link href="/demo">Protocol Replay</Link>.</span>
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
        <LatticeLoader label="Building your mandate" status="working" pattern="ripple" showTimer={false} className="mw-lattice--lg" />
        <p>Turning your intent into explicit authority.</p>
      </div>
    </div>
  );
}
