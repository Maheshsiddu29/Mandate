"use client";

import { useReducedMotion } from "@/lib/motion";
import { useEffect, useRef, type ReactNode } from "react";

type RGB = readonly [number, number, number];

const DEEP: RGB = [0x29, 0x29, 0x66];
const MID: RGB = [0x5c, 0x5c, 0x99];
const SOFT: RGB = [0xa3, 0xa3, 0xcc];
const LIGHT: RGB = [0xcc, 0xcc, 0xff];
const SOURCE_COUNT = 5;

function mix(start: RGB, end: RGB, amount: number): RGB {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
    start[2] + (end[2] - start[2]) * amount,
  ];
}

function colorFor(intensity: number): RGB {
  if (intensity < 0.35) {
    return mix(DEEP, MID, intensity / 0.35);
  }
  if (intensity < 0.7) {
    return mix(MID, SOFT, (intensity - 0.35) / 0.35);
  }
  return mix(SOFT, LIGHT, Math.min(1, (intensity - 0.7) / 0.3));
}

/**
 * Vertical market slats whose intensity drifts toward the center.
 * The five sources stand in for Stock, Swap, NFT, Yield, and Perps.
 * They are deliberately unlabeled: the field is the authorization
 * region behind the headline, not a chart.
 */
export function AuthorizationField({
  className = "",
}: {
  className?: string;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "authorization-field__canvas";
    container.appendChild(canvas);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      container.dataset.rendering = "static";
      return () => {
        canvas.remove();
      };
    }

    const pointer = { x: 0, active: false };
    let frame = 0;
    let inView = true;
    let pageVisible = !document.hidden;
    const startedAt = performance.now();

    const draw = (time: number): void => {
      const bounds = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const pixelWidth = Math.floor(width * dpr);
      const pixelHeight = Math.floor(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const elapsed = prefersReducedMotion ? 1.4 : (time - startedAt) / 1000;
      const gap = width < 720 ? 10 : 14;
      const count = Math.ceil(width / gap);
      const centerY = height * 0.46;
      const sources: number[] = [];
      for (let index = 0; index < SOURCE_COUNT; index += 1) {
        const home = 0.08 + index * 0.21;
        const drift = Math.sin(elapsed * 0.17 + index * 1.2) * 0.02;
        const converge = (Math.sin(elapsed * 0.07 + index * 0.85) * 0.5 + 0.5) * 0.2;
        sources.push(home + (0.5 - home) * converge + drift);
      }

      for (let column = 0; column < count; column += 1) {
        const x = column * gap;
        const nx = x / width;
        let intensity = Math.exp(-((nx - 0.5) ** 2) / 0.05) * 0.38;
        for (let index = 0; index < SOURCE_COUNT; index += 1) {
          const source = sources[index] ?? 0.5;
          const distance = nx - source;
          const pulse = 0.62 + 0.38 * Math.sin(elapsed * 0.32 + index * 1.7);
          intensity += Math.exp(-(distance * distance) / 0.0042) * 0.32 * pulse;
        }
        if (pointer.active && !prefersReducedMotion) {
          const distance = x - pointer.x;
          intensity += Math.exp(-(distance * distance) / (96 * 96)) * 0.4;
        }
        intensity = Math.max(0, Math.min(1, intensity));
        const [red, green, blue] = colorFor(intensity);
        const barHeight = height * (0.14 + intensity * 0.52);
        context.fillStyle = `rgba(${red | 0}, ${green | 0}, ${blue | 0}, ${(0.16 + intensity * 0.58).toFixed(3)})`;
        context.fillRect(x, centerY - barHeight / 2, 2, barHeight);
      }
    };

    const stop = (): void => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const loop = (time: number): void => {
      draw(time);
      frame = inView && pageVisible ? requestAnimationFrame(loop) : 0;
    };

    const start = (): void => {
      if (!prefersReducedMotion && inView && pageVisible && !frame) {
        frame = requestAnimationFrame(loop);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      draw(performance.now());
    });
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      if (inView) {
        start();
      } else {
        stop();
      }
    });
    intersectionObserver.observe(container);

    const handleVisibility = (): void => {
      pageVisible = !document.hidden;
      if (pageVisible) {
        start();
      } else {
        stop();
      }
    };

    const handlePointer = (event: PointerEvent): void => {
      const bounds = container.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      pointer.x = x;
      pointer.active =
        x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
    };

    const handlePointerEnd = (): void => {
      pointer.active = false;
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pointermove", handlePointer, { passive: true });
    window.addEventListener("blur", handlePointerEnd);
    draw(performance.now());
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("blur", handlePointerEnd);
      canvas.remove();
    };
  }, [prefersReducedMotion]);

  return (
    <div
      ref={containerRef}
      className={`authorization-field ${prefersReducedMotion ? "authorization-field--static" : ""} ${className}`.trim()}
      data-rendering={prefersReducedMotion ? "static" : "animated"}
      aria-hidden="true"
    />
  );
}
