"use client";

/**
 * Adapted from React Bits Prompt Bar (TS + CSS), commit
 * e1bbb696fc53f7f91e694c529e4d68c899773b6e.
 * https://www.reactbits.dev/micro/prompt-bar
 *
 * Mandate retains the official autosizing composer and send/working glyph
 * morph. Sources, attachments, models, effort and dictation are intentionally
 * removed because they have no authority-related purpose in this product.
 */
import { animate, useMotionValue, useMotionValueEvent } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import "./prompt-bar.css";

export interface PromptBarProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly placeholder?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly maxRows?: number;
  readonly label?: string;
}

const ARROW = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pathAt(from: readonly number[], to: readonly number[], value: number): string {
  let path = "";
  for (let index = 0; index < from.length; index += 2) {
    path += `${index === 0 ? "M" : "L"}${mix(from[index] ?? 0, to[index] ?? 0, value).toFixed(2)} ${mix(from[index + 1] ?? 0, to[index + 1] ?? 0, value).toFixed(2)}`;
  }
  return `${path}Z`;
}

function SendGlyph({ busy }: { readonly busy: boolean }): ReactNode {
  const pathRef = useRef<SVGPathElement>(null);
  const value = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const controls = animate(value, busy ? 1 : 0, { duration: 0.2, ease: [0.77, 0, 0.175, 1] });
    return () => controls.stop();
  }, [busy, value]);

  useMotionValueEvent(value, "change", (next) => pathRef.current?.setAttribute("d", pathAt(ARROW, SQUARE, next)));

  return (
    <svg className="mandate-prompt__glyph" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path ref={pathRef} d={pathAt(ARROW, SQUARE, value.get())} />
    </svg>
  );
}

export function PromptBar({
  value,
  onChange,
  onSend,
  placeholder = "What should your agents be allowed to do?",
  busy = false,
  disabled = false,
  maxRows = 5,
  label = "Principal intent",
}: PromptBarProps): ReactNode {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pressed, setPressed] = useState(false);
  const canSend = value.trim().length > 0 && !disabled && !busy;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "0px";
    const maximum = 24 * maxRows;
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    input.style.overflowY = input.scrollHeight > maximum ? "auto" : "hidden";
  }, [maxRows, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="mandate-prompt" data-busy={busy ? "" : undefined} style={{ "--pb-radius": "14px" } as CSSProperties}>
      <div className="mandate-prompt__field" onClick={() => inputRef.current?.focus()}>
        <label className="mandate-prompt__label" htmlFor="principal-intent">{label}</label>
        <textarea
          ref={inputRef}
          id="principal-intent"
          className="mandate-prompt__input"
          rows={1}
          value={value}
          maxLength={2000}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mandate-prompt__footer">
          <span>{busy ? "Building explicit authority…" : "Enter to build · Shift+Enter for a new line"}</span>
          <button
            type="button"
            className="mandate-prompt__send"
            disabled={!canSend}
            aria-label={busy ? "Building mandate" : "Build mandate"}
            data-armed={canSend ? "" : undefined}
            data-pressed={pressed ? "" : undefined}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            onClick={(event) => {
              event.stopPropagation();
              onSend();
            }}
          >
            <SendGlyph busy={busy} />
          </button>
        </div>
      </div>
    </div>
  );
}
