import {
  ConsistencyStatus,
  compareAssetAndOnchain,
  compareOracleWithRest,
  compareRestTokenPrices,
  type ConsistencyDiagnostic,
} from '../src/index.ts';
import {
  FIXTURE_SYMBOLS,
  loadMainnetAssets,
  loadMainnetPrice,
  loadOnchainToken,
  loadOraclePrice,
} from '../test/support/mainnet-fixture.ts';

const assets = loadMainnetAssets();
const diagnostics: ConsistencyDiagnostic[] = [];
for (const symbol of FIXTURE_SYMBOLS) {
  const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
  if (asset === undefined) throw new Error(`missing asset ${symbol}`);
  diagnostics.push(...compareAssetAndOnchain(asset, loadOnchainToken(symbol)));
  diagnostics.push(...compareRestTokenPrices(asset, loadMainnetPrice(symbol)));
  const oracle = symbol === 'CRWD' ? null : loadOraclePrice(symbol);
  diagnostics.push(compareOracleWithRest(asset, loadMainnetPrice(symbol), oracle, 15n));
}
const counts = Object.fromEntries(Object.values(ConsistencyStatus).map((status) => [status, diagnostics.filter((item) => item.status === status).length]));
process.stdout.write(`${JSON.stringify({ checks: diagnostics.length, counts }, null, 2)}\n`);
if (counts[ConsistencyStatus.MISMATCH] !== 0) process.exitCode = 1;
