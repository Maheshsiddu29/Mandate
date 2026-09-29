import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const patterns: readonly [string, RegExp][] = [
  ['private-key PEM', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['OpenAI API key', /sk-[A-Za-z0-9_-]{32,}/],
  ['assigned credential', /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
  // TypeSafe/Jev (Phase 5). The vendor does not publish a key format, so this
  // covers the two shapes a leak actually takes: a named assignment with a
  // literal, and a bearer token pasted into a tracked file.
  ['TypeSafe key assignment', /TYPESAFE_API_KEY\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/],
  ['TypeSafe-shaped token', /\bts[kp]?[_-][A-Za-z0-9]{24,}\b/],
  ['literal bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}(?![>\w])/],
  // Phase 7E.1: a Lighter API private key is 40 bytes (80 hex); transaction hashes have the same length,
  // so only a named assignment is flagged, never a bare hash.
  ['Lighter private key assignment', /(?:private[_-]?key|api[_-]?private[_-]?keys?|PRIVATE_KEY)\s*[:=]\s*\{?\s*(?:\d+\s*:\s*)?["'`]?(?:0x)?[0-9a-fA-F]{80}\b/],
];
// Phase 7E.3: the disposable Robinhood testnet keys live in a gitignored file. EVM private keys and
// transaction hashes are both 32 bytes, so rather than a shape the scan looks for the actual values.
const disposable: string[] = [];
if (existsSync('.robinhood-testnet/keys.json')) {
  const keys = JSON.parse(readFileSync('.robinhood-testnet/keys.json', 'utf8')) as { [role: string]: { privateKey?: string } };
  for (const k of Object.values(keys)) if (typeof k === 'object' && typeof k.privateKey === 'string') disposable.push(k.privateKey.toLowerCase().replace(/^0x/, ''));
}
const findings: string[] = [];
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) || /\.(?:pem|key|lighter-key)$/.test(file) || /(^|\/)(?:keystore|secrets|\.lighter-testnet|\.robinhood-testnet)\//.test(file)) {
    findings.push(`${file}: forbidden credential-bearing path`);
    continue;
  }
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${file}: ${label}`);
  const lower = text.toLowerCase();
  for (const k of disposable) if (lower.includes(k)) findings.push(`${file}: a disposable Robinhood testnet private key`);
}
if (findings.length > 0) {
  process.stderr.write(`potential committed credentials:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`credential scan passed (${files.length} tracked files${disposable.length > 0 ? `, ${disposable.length} disposable testnet keys checked by value` : ''})\n`);
}
