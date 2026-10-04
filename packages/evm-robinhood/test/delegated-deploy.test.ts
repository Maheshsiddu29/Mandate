/**
 * C2.3 V3 deployment tooling safety guards — pure helpers only.
 * Never invokes forge --broadcast. Never contacts a chain for SEND.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIRM_TESTNET_FLAG,
  FIXTURE,
  FORGE_SCRIPT,
  REPO,
  ROBINHOOD_TESTNET_CHAIN_ID,
  V2_MANIFEST_PATH,
  V3_CONFIG_PATH,
  V3_LIVE_MANIFEST_PATH,
  assertAllowedChainId,
  assertContractCodePresent,
  forgeArgsIncludeBroadcast,
  forgeArgsIncludeForkBlockNumber,
  forgeScriptArgs,
  forgeVerifyScriptArgs,
  isNonArchiveForkError,
  loadDelegatedConfig,
  parseChainIdHex,
  parseGateAddressFromForgeOutput,
  parseVerifyGateArg,
  resolveDeployMode,
  resolveRpcUrl,
  validateDelegatedConfig,
} from '../scripts/delegated-deploy-lib.ts';

const SCRIPT_SOL = join(REPO, 'contracts', 'script', 'DeployDelegatedV3.s.sol');
const GATE_SOL = join(REPO, 'contracts', 'src', 'MandateDelegatedExecutionGate.sol');
const TYPES_SOL = join(REPO, 'contracts', 'src', 'MandateTypes.sol');
const V2_GATE_SOL = join(REPO, 'contracts', 'src', 'MandateExecutionGate.sol');

describe('C2.3 V3 delegated deploy tooling', () => {
  it('defaults to dry-run and never broadcasts without --send + confirm', () => {
    assert.equal(resolveDeployMode([]).kind, 'DRY_RUN');
    assert.equal(resolveDeployMode(['--dry-run']).kind, 'DRY_RUN');
    assert.equal(resolveDeployMode([CONFIRM_TESTNET_FLAG]).kind, 'DRY_RUN');
    assert.equal(resolveDeployMode(['--dry-run', CONFIRM_TESTNET_FLAG]).kind, 'DRY_RUN');
  });

  it('refuses --send without --confirm-testnet-46630', () => {
    const m = resolveDeployMode(['--send']);
    assert.equal(m.kind, 'REFUSED');
    if (m.kind === 'REFUSED') {
      assert.match(m.reason, /confirm-testnet-46630/);
      assert.equal(m.exitCode, 2);
    }
  });

  it('accepts SEND only with --send and --confirm-testnet-46630', () => {
    assert.equal(resolveDeployMode(['--send', CONFIRM_TESTNET_FLAG]).kind, 'SEND');
    assert.equal(resolveDeployMode([CONFIRM_TESTNET_FLAG, '--send']).kind, 'SEND');
  });

  it('refuses ambiguous --dry-run with --send', () => {
    const m = resolveDeployMode(['--dry-run', '--send', CONFIRM_TESTNET_FLAG]);
    assert.equal(m.kind, 'REFUSED');
  });

  it('dry-run forge args never include --broadcast; send does', () => {
    const dry = forgeScriptArgs('DRY_RUN', 'https://rpc.testnet.chain.robinhood.com');
    const send = forgeScriptArgs('SEND', 'https://rpc.testnet.chain.robinhood.com');
    assert.equal(forgeArgsIncludeBroadcast(dry), false);
    assert.equal(forgeArgsIncludeBroadcast(send), true);
    assert.ok(send.includes('--interactive'));
    assert.ok(!dry.includes('--interactive'));
    assert.ok(dry.includes(FORGE_SCRIPT));
    assert.ok(!send.some((a) => /^0x[0-9a-fA-F]{64}$/.test(a)), 'no raw private key in forge args');
  });

  it('accepts chain 46630 and refuses mainnets and unknowns', () => {
    assert.equal(assertAllowedChainId(46_630).ok, true);
    for (const id of [1, 42_161, 42_170, 4_663]) {
      const r = assertAllowedChainId(id);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /mainnet/i);
    }
    const unknown = assertAllowedChainId(31_337);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.reason, /not Robinhood Chain testnet/);
  });

  it('parses eth_chainId hex with the same guards', () => {
    assert.equal(parseChainIdHex('0xb626').ok, true); // 46630
    assert.equal(parseChainIdHex('0x1').ok, false);
    assert.equal(parseChainIdHex('0x7a69').ok, false);
    assert.equal(parseChainIdHex('not-hex').ok, false);
  });

  it('loads and validates the committed V3 deploy config; rejects malformed', () => {
    const ok = loadDelegatedConfig();
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.config.chainId, ROBINHOOD_TESTNET_CHAIN_ID);
      assert.equal(ok.config.gateKind, 'MandateDelegatedExecutionGate');
      assert.equal(ok.config.markets.length, 1);
      assert.equal(ok.config.markets[0]?.representation.toLowerCase(), FIXTURE.representation);
    }
    assert.equal(validateDelegatedConfig(null).ok, false);
    assert.equal(validateDelegatedConfig({ chainId: 46630 }).ok, false);
    assert.equal(
      validateDelegatedConfig({
        label: 'x',
        chainId: 1,
        gateKind: 'MandateDelegatedExecutionGate',
        markets: [{ ...FIXTURE }],
      }).ok,
      false,
    );
    assert.equal(
      validateDelegatedConfig({
        label: 'x',
        chainId: 46630,
        gateKind: 'MandateDelegatedExecutionGate',
        markets: [{ ...FIXTURE, representation: '0x0000000000000000000000000000000000000001' }],
      }).ok,
      false,
    );
    assert.equal(
      validateDelegatedConfig({
        label: 'x',
        chainId: 46630,
        gateKind: 'MandateDelegatedExecutionGate',
        markets: [{ ...FIXTURE }, { ...FIXTURE }],
      }).ok,
      false,
    );
  });

  it('resolves RPC safely and never requires printing credentials', () => {
    assert.equal(resolveRpcUrl({}).ok, true);
    const pub = resolveRpcUrl({ ROBINHOOD_TESTNET_RPC_URL: 'https://rpc.testnet.chain.robinhood.com' });
    assert.equal(pub.ok, true);
    if (pub.ok) assert.equal(pub.isQuickNode, false);
    const bad = resolveRpcUrl({ ROBINHOOD_TESTNET_RPC_URL: 'https://evil.example/rpc' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.doesNotMatch(bad.reason, /evil\.example/);
  });

  it('does not overwrite the frozen V2 manifest path and keeps V3 live path separate', () => {
    assert.ok(existsSync(V2_MANIFEST_PATH));
    assert.ok(existsSync(V3_CONFIG_PATH));
    assert.notEqual(V2_MANIFEST_PATH, V3_LIVE_MANIFEST_PATH);
    assert.notEqual(V2_MANIFEST_PATH, V3_CONFIG_PATH);
    const v2 = JSON.parse(readFileSync(V2_MANIFEST_PATH, 'utf8')) as { chainId: number };
    assert.equal(v2.chainId, 46630);
  });

  it('Solidity deploy script exists with explicit 46630 guard and no PRIVATE_KEY', () => {
    assert.ok(existsSync(SCRIPT_SOL));
    const src = readFileSync(SCRIPT_SOL, 'utf8');
    assert.match(src, /46630|46_630/);
    assert.match(src, /requireRobinhoodTestnet|WrongChain|MainnetRefused/);
    assert.match(src, /MandateDelegatedExecutionGate/);
    assert.doesNotMatch(src, /envUint\s*\(\s*["']PRIVATE_KEY["']\s*\)/);
    assert.doesNotMatch(src, /vm\.envUint/);
  });

  it('production V3/V2 Gate and MandateTypes sources are untouched by this tooling path', () => {
    // Presence check only — git diff in CI/owner review proves zero semantic edits.
    assert.ok(existsSync(GATE_SOL));
    assert.ok(existsSync(TYPES_SOL));
    assert.ok(existsSync(V2_GATE_SOL));
    const deployTs = readFileSync(fileURLToPath(new URL('../scripts/deploy-delegated.ts', import.meta.url)), 'utf8');
    assert.doesNotMatch(deployTs, /envUint|process\.env\.PRIVATE|PRIVATE_KEY\s*=/);
    assert.match(deployTs, /NO BROADCAST/);
    assert.match(deployTs, /confirm-testnet-46630/);
  });

  it('parses forge stdout gate address', () => {
    const out = 'MandateDelegatedExecutionGate 0xAbCdEf0123456789aBcdEF0123456789aBCDef01\n';
    assert.equal(parseGateAddressFromForgeOutput(out), '0xabcdef0123456789abcdef0123456789abcdef01');
    assert.equal(parseGateAddressFromForgeOutput('no address'), null);
  });

  it('V3 verify forge args never pin --fork-block-number and never broadcast', () => {
    const args = forgeVerifyScriptArgs('0x5cf0621ab974d100fd5df225dab046bf35fa7519', 'https://rpc.testnet.chain.robinhood.com');
    assert.equal(forgeArgsIncludeForkBlockNumber(args), false);
    assert.equal(forgeArgsIncludeBroadcast(args), false);
    assert.ok(!args.some((a) => a === '--fork-block-number' || /^\d+$/.test(a) && args[args.indexOf(a) - 1] === '--fork-block-number'));
    assert.ok(args.includes('--sig'));
    assert.ok(args.includes('verify(address)'));
    assert.doesNotMatch(args.join(' '), /latest\s*-\s*\d/);
  });

  it('public-RPC verify wrapper is read-only latest-state and does not invoke forge', () => {
    const verifyTs = readFileSync(fileURLToPath(new URL('../scripts/verify-delegated.ts', import.meta.url)), 'utf8');
    const code = verifyTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /fork-block-number/);
    assert.doesNotMatch(code, /--broadcast/);
    assert.doesNotMatch(code, /execFileSync/);
    assert.doesNotMatch(code, /\bforge\b/);
    assert.doesNotMatch(code, /block\.value\.number/);
    assert.match(code, /'latest'/);
    assert.match(code, /broadcasts: none|broadcasts: 0/);
    assert.match(code, /assertContractCodePresent|eth_getCode/);
  });

  it('verify gate arg parsing and empty-code refusal', () => {
    assert.equal(parseVerifyGateArg([]).ok, false);
    assert.equal(parseVerifyGateArg(['--gate', 'nope']).ok, false);
    const g = parseVerifyGateArg(['--gate', '0x5CF0621AB974D100FD5DF225DAB046BF35FA7519']);
    assert.equal(g.ok, true);
    if (g.ok) assert.equal(g.gate, '0x5cf0621ab974d100fd5df225dab046bf35fa7519');
    assert.equal(assertContractCodePresent('0x').ok, false);
    assert.equal(assertContractCodePresent('0x6080').ok, true);
    assert.equal(assertAllowedChainId(1).ok, false);
    assert.equal(assertAllowedChainId(46_630).ok, true);
  });

  it('recognizes non-archive Foundry fork errors without suggesting historical pins', () => {
    assert.equal(isNonArchiveForkError('It looks like you\'re trying to fork from an older block with a non-archive node'), true);
    assert.equal(isNonArchiveForkError('failed to get block number: 128517346'), true);
    assert.equal(isNonArchiveForkError('ordinary revert'), false);
  });

  it('V2 deployment/verify tooling paths are unchanged by V3 verify helpers', () => {
    const v2Verify = readFileSync(join(REPO, 'packages/evm-robinhood/scripts/verify.ts'), 'utf8');
    const v2Deploy = readFileSync(join(REPO, 'packages/evm-robinhood/scripts/deploy.ts'), 'utf8');
    assert.match(v2Verify, /robinhood:testnet:verify|verify-contract/);
    assert.match(v2Deploy, /MandateExecutionGate/);
    assert.doesNotMatch(v2Verify, /forgeVerifyScriptArgs|verify-delegated/);
    assert.doesNotMatch(v2Deploy, /forgeVerifyScriptArgs/);
  });
});
