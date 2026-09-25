import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
];
const findings: string[] = [];
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) || /\.(?:pem|key)$/.test(file) || /(^|\/)(?:keystore|secrets)\//.test(file)) {
    findings.push(`${file}: forbidden credential-bearing path`);
    continue;
  }
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${file}: ${label}`);
}
if (findings.length > 0) {
  process.stderr.write(`potential committed credentials:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`credential scan passed (${files.length} tracked files)\n`);
}
