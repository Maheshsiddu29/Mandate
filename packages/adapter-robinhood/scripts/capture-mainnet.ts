import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROBINHOOD_API_BASE_URL, ROBINHOOD_MAINNET_RPC_URL, UI_MULTIPLIER_UPDATED_TOPIC } from '../src/index.ts';

interface Captured {
  readonly text: string;
  readonly value: unknown;
  readonly source: string;
  readonly capturedAt: string;
  readonly sourceObservedAt: string | null;
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || args[outputIndex + 1] === undefined) {
  throw new Error('usage: npm run robinhood:capture -- --output <new-directory> [--symbols AAPL,NVDA,...]');
}
const output = resolve(args[outputIndex + 1] as string);
if (existsSync(output)) throw new Error(`refusing to overwrite existing path: ${output}`);
const symbolIndex = args.indexOf('--symbols');
const symbols = (symbolIndex >= 0 ? args[symbolIndex + 1] : 'AAPL,NVDA,TSLA,QQQ,CRWD,MSFT')?.split(',') ?? [];
if (symbols.length === 0 || symbols.some((symbol) => !/^[A-Z0-9.\-]{1,16}$/.test(symbol))) throw new Error('invalid --symbols list');
const rpcUrl = process.env['ROBINHOOD_RPC_URL'] ?? ROBINHOOD_MAINNET_RPC_URL;
const parsedRpcUrl = new URL(rpcUrl);
if (parsedRpcUrl.protocol !== 'https:') throw new Error('ROBINHOOD_RPC_URL must use HTTPS');

async function capture(url: string, init: RequestInit = {}, sourceObservedAt: (value: unknown) => string | null = () => null): Promise<Captured> {
  const response = await fetch(url, init);
  const capturedAt = new Date().toISOString();
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error(`${url} returned malformed JSON`); }
  return { text, value, source: url, capturedAt, sourceObservedAt: sourceObservedAt(value) };
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${label} is not an object`);
  return raw as Record<string, unknown>;
}

async function rpc(body: unknown, label: string): Promise<Captured> {
  const result = await capture(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ...result, source: `${rpcUrl} ${label}` };
}

const artifacts = new Map<string, Captured>();
const assets = await capture(`${ROBINHOOD_API_BASE_URL}/assets`);
artifacts.set('assets.json', assets);
const actions = await capture(`${ROBINHOOD_API_BASE_URL}/corporate-actions`);
artifacts.set('corporate-actions.json', actions);
for (const symbol of symbols) {
  const quote = await capture(`${ROBINHOOD_API_BASE_URL}/prices/${symbol}`, {}, (raw) => {
    const quotes = record(raw, 'quote response')['quotes'];
    if (!Array.isArray(quotes) || quotes.length !== 1) return null;
    const generatedAt = record(quotes[0], 'quote')['generatedAt'];
    return typeof generatedAt === 'string' ? generatedAt : null;
  });
  artifacts.set(`price-${symbol}.json`, quote);
}

const chain = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, 'eth_chainId');
if (record(chain.value, 'chain response')['result'] !== '0x1237') throw new Error('RPC chain ID is not Robinhood mainnet 4663');
artifacts.set('rpc-chain-id.json', chain);
const block = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }, 'eth_getBlockByNumber');
const blockResult = record(record(block.value, 'block response')['result'], 'block');
const blockNumber = blockResult['number'];
const blockTimestamp = blockResult['timestamp'];
if (typeof blockNumber !== 'string' || typeof blockTimestamp !== 'string') throw new Error('RPC block response is partial');
const blockTimeIso = new Date(Number(BigInt(blockTimestamp)) * 1_000).toISOString();
artifacts.set('rpc-latest-block.json', { ...block, sourceObservedAt: blockTimeIso });

const assetRows = record(assets.value, 'assets response')['assets'];
if (!Array.isArray(assetRows)) throw new Error('assets response is partial');
const addresses = symbols.map((symbol) => {
  const asset = assetRows.find((item) => record(item, 'asset')['tokenSymbol'] === symbol);
  if (asset === undefined) throw new Error(`asset ${symbol} not found`);
  const deployments = record(asset, symbol)['deployments'];
  if (!Array.isArray(deployments)) throw new Error(`${symbol} deployments missing`);
  const deployment = deployments.find((item) => record(item, 'deployment')['chainId'] === 4663);
  const address = deployment === undefined ? undefined : record(deployment, 'deployment')['contractAddress'];
  if (typeof address !== 'string') throw new Error(`${symbol} mainnet deployment missing`);
  return address;
});

const selectors = ['CODE', '0x95d89b41', '0x06fdde03', '0x313ce567', '0xa60bf13d', '0xf514ce36'] as const;
let requestId = 1;
const contractRequests = addresses.flatMap((address) => selectors.map((selector) => selector === 'CODE'
  ? { jsonrpc: '2.0', id: requestId++, method: 'eth_getCode', params: [address, blockNumber] }
  : { jsonrpc: '2.0', id: requestId++, method: 'eth_call', params: [{ to: address, data: selector }, blockNumber] }));
artifacts.set('rpc-requests.json', { text: JSON.stringify(contractRequests), value: contractRequests, source: 'capture request metadata', capturedAt: block.capturedAt, sourceObservedAt: null });
artifacts.set('rpc-contracts.json', { ...await rpc(contractRequests, 'fixed-block Stock Token batch'), sourceObservedAt: blockTimeIso });

requestId = 1;
const stateSelectors = ['0xdc767007', '0x97a4064f', '0x7706ba52'] as const;
const stateRequests = addresses.flatMap((address) => stateSelectors.map((selector) => ({
  jsonrpc: '2.0', id: requestId++, method: 'eth_call', params: [{ to: address, data: selector }, blockNumber],
})));
artifacts.set('rpc-state-requests.json', { text: JSON.stringify(stateRequests), value: stateRequests, source: 'capture request metadata', capturedAt: block.capturedAt, sourceObservedAt: null });
artifacts.set('rpc-state.json', { ...await rpc(stateRequests, 'fixed-block ERC-8056 state batch'), sourceObservedAt: blockTimeIso });

const logRequest = { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: blockNumber, address: addresses, topics: [UI_MULTIPLIER_UPDATED_TOPIC] }] };
artifacts.set('rpc-logs-request.json', { text: JSON.stringify(logRequest), value: logRequest, source: 'capture request metadata', capturedAt: block.capturedAt, sourceObservedAt: null });
artifacts.set('rpc-multiplier-events.json', { ...await rpc(logRequest, 'eth_getLogs UIMultiplierUpdated'), sourceObservedAt: blockTimeIso });

const feeds = await capture('https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json');
artifacts.set('chainlink-feeds.json', feeds);
if (!Array.isArray(feeds.value)) throw new Error('Chainlink feed catalog is not an array');
const feedAddresses = symbols.flatMap((symbol) => {
  const feed = (feeds.value as unknown[]).find((item) => {
    const docs = record(record(item, 'feed')['docs'], 'feed docs');
    return docs['baseAsset'] === symbol;
  });
  const proxy = feed === undefined ? undefined : record(feed, 'feed')['proxyAddress'];
  return typeof proxy === 'string' ? [{ symbol, proxy }] : [];
});
requestId = 1;
const oracleRequests = feedAddresses.flatMap(({ proxy }) => [
  { jsonrpc: '2.0', id: requestId++, method: 'eth_getCode', params: [proxy, blockNumber] },
  { jsonrpc: '2.0', id: requestId++, method: 'eth_call', params: [{ to: proxy, data: '0x313ce567' }, blockNumber] },
  { jsonrpc: '2.0', id: requestId++, method: 'eth_call', params: [{ to: proxy, data: '0xfeaf968c' }, blockNumber] },
]);
artifacts.set('rpc-oracle-map.json', { text: JSON.stringify({ symbols: feedAddresses.map((item) => item.symbol), blockNumber }), value: null, source: 'capture request metadata', capturedAt: block.capturedAt, sourceObservedAt: null });
artifacts.set('rpc-oracle-requests.json', { text: JSON.stringify(oracleRequests), value: oracleRequests, source: 'capture request metadata', capturedAt: block.capturedAt, sourceObservedAt: null });
artifacts.set('rpc-oracles.json', { ...await rpc(oracleRequests, 'fixed-block Chainlink proxy batch'), sourceObservedAt: blockTimeIso });

mkdirSync(resolve(output, 'raw'), { recursive: true });
const manifestArtifacts = [];
for (const [path, artifact] of artifacts) {
  writeFileSync(resolve(output, 'raw', path), artifact.text, { encoding: 'utf8', flag: 'wx' });
  manifestArtifacts.push({
    path: `raw/${path}`, source: artifact.source, capturedAt: artifact.capturedAt,
    sourceObservedAt: artifact.sourceObservedAt,
    sha256: createHash('sha256').update(artifact.text).digest('hex'),
  });
}
const manifest = {
  version: 1,
  captureId: `robinhood-mainnet-${block.capturedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}`,
  chain: { name: 'Robinhood Chain mainnet', chainId: 4663, blockNumber, blockTimestamp: blockTimeIso },
  schemaVersion: 'not published',
  artifacts: manifestArtifacts,
};
writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(`captured ${manifestArtifacts.length} artifacts to ${output}\n`);
