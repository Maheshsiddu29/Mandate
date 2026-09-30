"use client";

import { EvidencePanel, JudgeStage } from "@/components/demo/judge/stage";
import { formatUsdc } from "@/lib/mandate/formatting";
import { judgeDemoProvider } from "@/lib/mandate/browser-provider";
import { useReducedMotion } from "@/lib/motion";
import { PresentationPlayback, stepDelayMs, type PlaybackState } from "@/lib/mandate/playback";
import { SCENE_COUNT, SCENE_TITLES } from "@/lib/mandate/timeline";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./judge-demo.css";

export function JudgeExperience(): ReactNode {
  const reducedMotion = useReducedMotion();
  const playbackRef = useRef(new PresentationPlayback(judgeDemoProvider.transcript.events));
  const [position, setPosition] = useState(0);
  const [playState, setPlayState] = useState<PlaybackState>("IDLE");
  const linked = useRef(false);

  function sync(): void {
    const playback = playbackRef.current;
    setPosition(playback.position);
    setPlayState(playback.state);
  }

  useEffect(() => {
    if (linked.current) return;
    linked.current = true;
    const raw = new URLSearchParams(window.location.search).get("scene");
    const scene = raw === null ? Number.NaN : Number(raw);
    if (!Number.isInteger(scene) || scene < 1 || scene > SCENE_COUNT) return;
    playbackRef.current.seekScene(scene);
    sync();
  }, []);

  useEffect(() => {
    const playback = playbackRef.current;
    if (playState !== "PLAYING") return undefined;
    const shown = playback.shown;
    const current = shown[shown.length - 1];
    const previous = shown[shown.length - 2];
    const sceneChanged = current !== undefined && previous !== undefined && current.scene !== previous.scene;
    const timer = window.setTimeout(() => {
      playback.next();
      sync();
    }, stepDelayMs(reducedMotion, sceneChanged));
    return () => window.clearTimeout(timer);
  }, [playState, position, reducedMotion]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const playback = playbackRef.current;
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        if (playback.state === "PLAYING") playback.pause();
        else if (playback.state === "PAUSED") playback.resume();
        else {
          if (playback.state === "FINISHED") playback.restart();
          playback.start();
          if (playback.position === 0) playback.next();
        }
        sync();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        playback.next();
        sync();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        playback.previous();
        sync();
      } else if (event.key === "Home") {
        event.preventDefault();
        playback.restart();
        sync();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const presentation = useMemo(() => judgeDemoProvider.present(position), [position]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const next = String(presentation.scene);
    if (url.searchParams.get("scene") === next) return;
    url.searchParams.set("scene", next);
    window.history.replaceState(null, "", url);
  }, [presentation.scene]);

  function start(): void {
    const playback = playbackRef.current;
    if (playback.state === "FINISHED") playback.restart();
    playback.start();
    if (playback.position === 0) playback.next();
    sync();
  }

  const progress = presentation.eventCount === 0 ? 0 : Math.round((position / presentation.eventCount) * 100);

  return (
    <main id="main-content" className={`judge-demo${reducedMotion ? "" : " judge-demo--motion"}`}>
      <div className="page-container">
        <header className="judge-top">
          <div className="judge-brand">
            <strong>MANDATE</strong>
            <h1>Portfolio Mandate</h1>
            <p>Agents propose. Agents negotiate. Mandate authorizes. Markets settle.</p>
            <p className="status-pill">Judge mode · transcript · no wallet · no network</p>
            <p><Link href="/demo/live">Live AI Lab</Link></p>
          </div>
          <dl className="judge-metrics">
            <div>
              <dt>Status</dt>
              <dd>Active</dd>
            </div>
            <div>
              <dt>Principal authority</dt>
              <dd>{formatUsdc(presentation.summary.authority)}</dd>
            </div>
            <div>
              <dt>Agents</dt>
              <dd>{presentation.summary.agentCount}</dd>
            </div>
            <div>
              <dt>Current reserved</dt>
              <dd>{formatUsdc(presentation.resources.reserved)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{formatUsdc(presentation.resources.available)}</dd>
            </div>
          </dl>
        </header>

        <div className="judge-controls" role="group" aria-label="Demo playback">
          {playState === "IDLE" || playState === "FINISHED" ? (
            <button type="button" className="button button--primary focus-ring" onClick={start}>
              Start Demo
            </button>
          ) : null}
          {playState === "PLAYING" ? (
            <button
              type="button"
              className="button button--secondary focus-ring"
              onClick={() => {
                playbackRef.current.pause();
                sync();
              }}
            >
              Pause
            </button>
          ) : null}
          {playState === "PAUSED" ? (
            <button
              type="button"
              className="button button--secondary focus-ring"
              onClick={() => {
                playbackRef.current.resume();
                sync();
              }}
            >
              Resume
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary focus-ring"
            onClick={() => {
              playbackRef.current.previous();
              sync();
            }}
          >
            Previous
          </button>
          <button
            type="button"
            className="button button--secondary focus-ring"
            onClick={() => {
              playbackRef.current.next();
              sync();
            }}
          >
            Next
          </button>
          <button
            type="button"
            className="button button--secondary focus-ring"
            onClick={() => {
              playbackRef.current.restart();
              sync();
            }}
          >
            Restart
          </button>
        </div>

        <div className="judge-progress">
          <p className="judge-progress__label">
            Scene {presentation.scene} / {SCENE_COUNT}
            <span> {presentation.sceneTitle}</span>
          </p>
          <div>
            <ol className="judge-scenes">
              {SCENE_TITLES.map((item) => (
                <li key={item.scene}>
                  <button
                    type="button"
                    className="focus-ring"
                    aria-current={item.scene === presentation.scene ? "step" : undefined}
                    aria-label={`Scene ${item.scene}: ${item.title}`}
                    onClick={() => {
                      playbackRef.current.seekScene(item.scene);
                      sync();
                    }}
                  >
                    {item.scene}
                  </button>
                </li>
              ))}
            </ol>
            <div
              className="judge-meter"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={presentation.eventCount}
              aria-valuenow={position}
              aria-label="Demo progress"
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="judge-demo__layout">
          <JudgeStage presentation={presentation} />
          <EvidencePanel presentation={presentation} />
        </div>
      </div>
    </main>
  );
}
