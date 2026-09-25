import { validateFixtures } from '../test/support/fixtures.ts';

const report = validateFixtures();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.live === 0) {
  process.stdout.write('note: no LIVE fixture is recorded. Run `TYPESAFE_API_KEY=... npm run jev:characterize -- --write-fixtures` once account access exists.\n');
}
