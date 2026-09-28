/**
 * A signer process that dies by SIGKILL at a chosen instant of issuance, for
 * the durable crash tests. It sets up the world on the given SQLite file,
 * authorizes a BUY, writes the authorization record next to the database (as
 * a caller would hold it), then issues it and is killed:
 *
 *   crash-child.ts after-sign  <db> <record.json>   ADMIT_ATTEMPT committed, key used, nothing recorded
 *   crash-child.ts after-send  <db> <record.json>   submission sent, reply never recorded
 *   crash-child.ts before-admit <db> <record.json>  hash computed, nothing admitted
 */

import { writeFileSync } from 'node:fs';
import { authorizeOrder, issuanceWorld, recordToJson } from './signer-world.ts';

const [mode, path, recordFile] = process.argv.slice(2) as [string, string, string];

async function main(): Promise<void> {
  const x = await issuanceWorld({ path });
  const { rec, issue } = await authorizeOrder(x);
  writeFileSync(recordFile, recordToJson(rec));
  const die = () => process.kill(process.pid, 'SIGKILL');
  if (mode === 'after-sign') x.custody.onSign = die;
  else if (mode === 'after-send') x.venue.onSend = die;
  else if (mode === 'before-admit') x.custody.onHash = die;
  else throw new Error(`unknown mode ${mode}`);
  await x.signer.issueAuthorizedPerpOrder(rec, issue);
  process.exit(3); // the kill point was never reached
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(2);
});
