"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { resourceLabel, ROLE_TITLES, usd, type ChatMessage, type ResourceLine, type RoleName } from "./live-model";
import { AgentGlyph, Pill } from "./workspace-ui";

function ConflictHeader({ lines }: { readonly lines: readonly ResourceLine[] }): ReactNode {
  // One entry per typed resource, never a total.
  const shown = lines.filter((line) => line.status !== "OK");
  if (shown.length === 0) return null;
  return (
    <div className="mw-conflicts">
      {shown.length > 1 ? <p className="mw-fine">Each typed resource is a separate limit. Incomparable reductions are not added together.</p> : null}
      {shown.map((line) => (
        <section key={line.resource} className="mw-conflict" data-status={line.status}>
          <p className="mw-conflict__title">{resourceLabel(line.resource)} conflict</p>
          {line.status === "SATISFIED" && line.demandAfter !== null ? (
            <p className="mw-conflict__resolved"><span>{usd(line.demand)} → {usd(line.demandAfter)}</span><Pill tone="good">✓ Resolved</Pill></p>
          ) : (
            <dl>
              <div><dt>Requested</dt><dd>{usd(line.demand)}</dd></div>
              <div><dt>Allowed</dt><dd>{usd(line.authority)}</dd></div>
              <div><dt>{line.status === "UNRESOLVED" ? "Still over" : "Need to reduce"}</dt><dd>{usd(line.reduction)}</dd></div>
            </dl>
          )}
        </section>
      ))}
    </div>
  );
}

function Message({ message, reduced }: { readonly message: ChatMessage; readonly reduced: boolean }): ReactNode {
  const enter = reduced ? false : { opacity: 0, y: 6 };
  if (message.kind === "system") {
    return (
      <motion.li className="mw-msg mw-msg--system" data-tone={message.tone} initial={enter} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}>
        <p className="mw-msg__who">Mandate</p>
        {message.working ? <LatticeLoader label={message.title} status="working" pattern="sweep" showTimer={false} /> : <p className="mw-msg__title">{message.title}</p>}
        {message.detail === "" ? null : <p className="mw-msg__detail">{message.detail}</p>}
      </motion.li>
    );
  }
  const role = message.agent;
  return (
    <motion.li className="mw-msg mw-msg--agent" data-role={role ?? undefined} data-tone={message.tone} data-ignored={message.ignored ?? undefined} initial={enter} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}>
      <span className="mw-msg__avatar" aria-hidden="true">{role === null ? null : <AgentGlyph role={role} size={16} />}</span>
      <div className="mw-msg__bubble">
        <p className="mw-msg__who">{role === null ? "Agent" : `${ROLE_TITLES[role]} Agent`}{message.generation === null ? null : <span> · round {message.generation}</span>}</p>
        <p className="mw-msg__title">{message.title}</p>
        {message.detail === "" ? null : <p className="mw-msg__detail">{message.detail}</p>}
        {message.ignored === null ? null : <p className="mw-msg__ignored"><Pill tone="warn">{message.note}</Pill></p>}
      </div>
    </motion.li>
  );
}

export function RoomChat(props: {
  readonly messages: readonly ChatMessage[];
  readonly awaiting: readonly RoleName[];
  readonly lines: readonly ResourceLine[];
  readonly live: boolean;
  readonly reduced: boolean;
  readonly compact?: boolean;
}): ReactNode {
  const feed = useRef<HTMLOListElement>(null);
  const count = props.messages.length + props.awaiting.length;

  useEffect(() => {
    const list = feed.current;
    if (list !== null) list.scrollTo({ top: list.scrollHeight, behavior: props.reduced ? "auto" : "smooth" });
  }, [count, props.reduced]);

  return (
    <div className={props.compact === true ? "mw-room mw-room--compact" : "mw-room"}>
      <header className="mw-room__head">
        <div>
          <p className="mw-room__title">Coordination {props.live ? <Pill tone="accent">LIVE</Pill> : null}</p>
          <p className="mw-room__sub">Agents are resolving a shared authority conflict.</p>
        </div>
        <span className="mw-authority" tabIndex={0} aria-describedby="room-authority-tip">
          <span>Authority</span><strong>NONE</strong>
          <span role="tooltip" id="room-authority-tip" className="mw-tooltip">The Room may adjust requests but cannot create new permission.</span>
        </span>
      </header>
      <ConflictHeader lines={props.lines} />
      <ol ref={feed} className="mw-feed" aria-live="polite" aria-label="Room conversation">
        <AnimatePresence initial={false}>
          {props.messages.map((message) => <Message key={message.id} message={message} reduced={props.reduced} />)}
          {props.awaiting.map((role) => (
            <motion.li key={`awaiting-${role}`} className="mw-msg mw-msg--agent mw-msg--awaiting" data-role={role} initial={props.reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: props.reduced ? 0 : 0.16 }}>
              <span className="mw-msg__avatar" aria-hidden="true"><AgentGlyph role={role} size={16} /></span>
              <div className="mw-msg__bubble">
                <p className="mw-msg__who">{ROLE_TITLES[role]} Agent</p>
                <LatticeLoader label="Responding…" status="working" pattern="ripple" showTimer={false} />
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}
