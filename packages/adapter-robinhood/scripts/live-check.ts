import { RobinhoodClient } from '../src/index.ts';

const client = new RobinhoodClient();
const chain = await client.assertMainnetChain();
if (!chain.ok) throw new Error(`${chain.error.code}: ${chain.error.message}`);
const assets = await client.assets();
if (!assets.ok) throw new Error(`${assets.error.code}: ${assets.error.message}`);
const actions = await client.corporateActions();
if (!actions.ok) throw new Error(`${actions.error.code}: ${actions.error.message}`);
const symbols = ['AAPL', 'NVDA', 'TSLA', 'QQQ', 'CRWD', 'MSFT'] as const;
const prices = [];
for (const symbol of symbols) {
  const result = await client.price(symbol);
  if (!result.ok) throw new Error(`${symbol}: ${result.error.code}: ${result.error.message}`);
  prices.push({ symbol, generatedAtUnixSeconds: String(result.value.generatedAtUnixSeconds), tradingHalt: result.value.tradingHalt.value });
}
process.stdout.write(`${JSON.stringify({ chainId: String(chain.value), assets: assets.value.length, corporateActions: actions.value.length, prices }, null, 2)}\n`);
