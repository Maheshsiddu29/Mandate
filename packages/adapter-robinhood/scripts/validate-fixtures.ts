import { validateFixtureManifest } from '../test/support/fixture-manifest.ts';
import { MAINNET_FIXTURE_ROOT } from '../test/support/mainnet-fixture.ts';

const report = validateFixtureManifest(MAINNET_FIXTURE_ROOT);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
