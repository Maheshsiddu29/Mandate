/**
 * Mock Mandate contracts for the public site.
 * These fixtures describe one portfolio review. They are not live market data,
 * and a later backend can replace this module without changing the page shape.
 */

export const PORTFOLIO_BUDGET_USD = 2000;

export const AGENT_STATUSES = [
  "SEARCHING",
  "PROPOSING",
  "BLOCKED",
  "RENEGOTIATING",
  "AUTHORIZED",
  "SETTLED",
  "RELEASES ALLOCATION",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type MarketId = "stock" | "swap" | "nft" | "yield" | "perps";

export type AgentFixture = {
  id: MarketId;
  agent: string;
  market: string;
  finding: string;
  detail: string;
  finalStatus: AgentStatus;
  frames: readonly AgentStatus[];
  allocationUsd: number;
  authorizedUsd: number;
};

export const agentFixtures: readonly AgentFixture[] = [
  {
    id: "stock",
    agent: "Stock Agent",
    market: "Stock",
    finding: "Fake same-ticker representation found",
    detail: "representation not authorized",
    finalStatus: "BLOCKED",
    frames: ["SEARCHING", "PROPOSING", "BLOCKED"],
    allocationUsd: 500,
    authorizedUsd: 0,
  },
  {
    id: "swap",
    agent: "Swap Agent",
    market: "Swap",
    finding: "Unknown router produces better quote",
    detail: "venue not authorized",
    finalStatus: "BLOCKED",
    frames: ["SEARCHING", "PROPOSING", "BLOCKED"],
    allocationUsd: 450,
    authorizedUsd: 0,
  },
  {
    id: "nft",
    agent: "NFT Agent",
    market: "NFT",
    finding: "No compliant opportunity",
    detail: "allocation returns to the mandate",
    finalStatus: "RELEASES ALLOCATION",
    frames: ["SEARCHING", "PROPOSING", "RELEASES ALLOCATION"],
    allocationUsd: 250,
    authorizedUsd: 0,
  },
  {
    id: "yield",
    agent: "Yield Agent",
    market: "Yield",
    finding: "12.6% product from unknown issuer",
    detail: "issuer not authorized",
    finalStatus: "BLOCKED",
    frames: ["SEARCHING", "PROPOSING", "BLOCKED"],
    allocationUsd: 400,
    authorizedUsd: 0,
  },
  {
    id: "perps",
    agent: "Perps Agent",
    market: "Perps",
    finding: "Requested exposure exceeds portfolio policy",
    detail: "size brought back inside the exposure cap",
    finalStatus: "RENEGOTIATING",
    frames: ["SEARCHING", "PROPOSING", "RENEGOTIATING"],
    allocationUsd: 400,
    authorizedUsd: 250,
  },
];

export type IntegrationStatus =
  | "LIVE TESTNET"
  | "DOMAIN INTEGRATION"
  | "INTEGRATION"
  | "FIXTURE";

export type MarketIntegration = {
  name: string;
  status: IntegrationStatus;
  summary: string;
  live: boolean;
};

export const marketIntegrations: readonly MarketIntegration[] = [
  {
    name: "Robinhood Chain",
    status: "LIVE TESTNET",
    summary: "Connected on testnet for the demo path. Not a production market.",
    live: true,
  },
  {
    name: "Lighter",
    status: "DOMAIN INTEGRATION",
    summary: "Domain integration for perps exposure. Not a claimed live fill.",
    live: false,
  },
  {
    name: "Arbitrum",
    status: "INTEGRATION",
    summary: "Settlement network in the execution path. Not a live venue proof.",
    live: false,
  },
  {
    name: "NFT Market",
    status: "FIXTURE",
    summary: "Scripted market used to show a released allocation.",
    live: false,
  },
  {
    name: "Yield",
    status: "FIXTURE",
    summary: "Scripted issuer check. This is not a live yield market.",
    live: false,
  },
];

export const DEMO_STAGES = [
  { id: "mandate", label: "Portfolio Mandate" },
  { id: "agents", label: "Agents" },
  { id: "room", label: "Mandate Room" },
  { id: "negotiation", label: "Negotiation" },
  { id: "proposal", label: "Portfolio proposal" },
  { id: "verification", label: "Policy verification" },
  { id: "execution", label: "Authorized executions" },
  { id: "receipt", label: "Receipt" },
] as const;

export type DemoStageId = (typeof DEMO_STAGES)[number]["id"];

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function statusLine(agent: AgentFixture, status: AgentStatus): string {
  if (status === "BLOCKED") {
    return `BLOCKED — ${agent.detail}`;
  }
  if (status === "RENEGOTIATING") {
    return "RENEGOTIATING";
  }
  if (status === "RELEASES ALLOCATION") {
    return "RELEASES ALLOCATION";
  }
  return status;
}

export const portfolioCandidate = {
  title: "Portfolio Candidate",
  summary:
    "One child authorization is ready for review. Markets have not settled.",
  authorizedLabel: "Perps sleeve reduced from $400 to $250",
  blockedLabel: "Stock, Swap, and Yield stay blocked",
  releasedLabel: "NFT allocation returns to the mandate",
} as const;

export const demoReceipt = {
  id: "mnd_demo_receipt_01",
  mandateId: "mnd_demo_portfolio_01",
  childAuthorizationId: "mnd_demo_child_perps_01",
  disclaimer:
    "Scripted demo. Robinhood Chain is the only live testnet connection. NFT Market and Yield are fixtures. This receipt is not a live market execution.",
} as const;
