/**
 * The local Live AI Lab API for `/demo/live` (docs/demo/live-ai-lab.md §10).
 *
 *   npm run agents:serve                 # OpenAI when OPENAI_API_KEY is set; the stub is always available
 *   npm run agents:serve -- --dev-chaos  # also allow development latency chaos per session
 *
 * Local mode binds to 127.0.0.1:LIVE_AGENTS_PORT (8787). Explicit
 * MANDATE_PUBLIC_DEMO=1 mode binds to 0.0.0.0:PORT with exact-origin CORS.
 * The key stays in this process; the browser receives events and summaries
 * only. Nothing is deployed and no transaction is sent.
 */

import { parseArgs } from 'node:util';
import { OpenAIProvider, describeConfig, readConfig, realClock } from '../src/index.ts';
import { LiveLab } from '../src/server/app.ts';
import { createLabServer, listen } from '../src/server/http.ts';
import { configuredScorer } from './jev.ts';

const { values } = parseArgs({ options: { 'dev-chaos': { type: 'boolean', default: false } }, strict: true });
const config = readConfig();
const live = config.openaiApiKey === null ? null : new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.openaiModel });
const scorer = configuredScorer();
const lab = new LiveLab({ live, clock: realClock, agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs, allowChaos: values['dev-chaos'], ...(config.publicDemo ? {} : { stateDir: config.stateDir }), ...(scorer === undefined ? {} : { scorer }) });
const server = createLabServer(lab, { port: config.port, allowedOrigins: config.allowedOrigins, publicDemo: config.publicDemo });
await listen(server, config.port, config.host);
process.stdout.write(`Live AI Lab API on http://${config.host}:${config.port} · ${describeConfig(config)} · origins ${config.allowedOrigins.join(', ')} · ${config.publicDemo ? 'memory-only sessions' : `durable sessions in ${config.stateDir}`}${values['dev-chaos'] ? ' · DEV latency chaos allowed' : ''}\n`);
if (live === null) process.stdout.write('OPENAI_API_KEY is absent: only the deterministic stub provider is available.\n');
process.stdout.write(scorer === undefined ? 'Jev scoring is not configured: Planning Rooms allocate on model ratings alone, and no score is invented.\n' : `Jev scoring: ${scorer.name} (advisory only).\n`);
