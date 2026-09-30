"use client";

import { useState, type ReactNode } from "react";

const CANDIDATES = [
  {
    id: "a",
    name: "Candidate A",
    price: "Cheaper quote",
    points: ["Same display ticker", "Unknown issuer", "Wrong representation"],
    verdict: "Blocked",
    tone: "blocked",
  },
  {
    id: "b",
    name: "Candidate B",
    price: "Higher quote",
    points: [
      "Verified canonical underlying",
      "Verified representation",
      "Approved issuer",
      "Approved chain",
    ],
    verdict: "Eligible",
    tone: "eligible",
  },
] as const;

export function CanonicalAssets(): ReactNode {
  const [rankByPrice, setRankByPrice] = useState(false);
  const cheaper = CANDIDATES[0];
  const canonical = CANDIDATES[1];
  const ordered = rankByPrice ? [cheaper, canonical] : [canonical, cheaper];

  return (
    <section className="mandate-section page-container" id="assets" aria-labelledby="assets-title">
      <div className="mandate-section__heading mandate-section__heading--wide">
        <p className="mandate-kicker">Canonical assets</p>
        <h2 id="assets-title">A ticker is not an asset identity.</h2>
        <p>
          Mandate does not choose the cheaper quote. An unapproved
          representation stays blocked even when the display ticker matches.
        </p>
      </div>

      <div className="asset-toolbar">
        <button
          type="button"
          className="button button--secondary focus-ring"
          aria-pressed={rankByPrice}
          onClick={() => setRankByPrice((current) => !current)}
        >
          {rankByPrice ? "Rank by identity" : "Rank by price"}
        </button>
        <p>
          {rankByPrice
            ? "Price puts Candidate A first. Mandate still blocks it."
            : "Identity order. Candidate B is the only eligible asset."}
        </p>
      </div>

      <div className="asset-compare">
        {ordered.map((candidate) => (
          <article
            key={candidate.id}
            className={`asset-card asset-card--${candidate.tone}`}
          >
            <p className="mandate-kicker">{candidate.name}</p>
            <h3>{candidate.price}</h3>
            <ul>
              {candidate.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <p className="asset-card__verdict">{candidate.verdict}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
