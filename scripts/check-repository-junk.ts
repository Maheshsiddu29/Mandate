import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  /(^|\/)node_modules\//,
  /(^|\/)(?:dist|build|out|coverage|artifacts|broadcast|cache)\//,
  /(^|\/)\.env(?:\.|$)/,
  /\.(?:pem|key|log|tsbuildinfo|swp|swo)$/,
  /(^|\/)(?:keystore|secrets|tmp|scratch)\//,
  /(^|\/)\.DS_Store$/,
];
const findings = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (findings.length > 0) {
  process.stderr.write(`forbidden repository junk:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`repository junk check passed (${files.length} tracked files)\n`);
}

