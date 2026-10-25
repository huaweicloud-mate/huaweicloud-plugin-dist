#!/usr/bin/env node
/**
 * Runtime compatibility monitor for huaweicloud-devkit plugin packages.
 *
 * Usage:
 *   node scripts/check-runtime-compat.mjs --version <semver> [--source <checkout>] [--out dist/runtime-compat]
 *
 * Requirement side (extracted automatically from the devkit package):
 *   - engines.node from the npm package root (hard runtime dependency)
 *   - second-runtime traces inside the package: *.py (python), *.sh (bash) files,
 *     which the skills/hooks instruct agents to execute on the optional
 *     execution track
 *
 * Supply side (runtimes.json, maintained manually): runtimes bundled by each
 * agent the devkit is installed into.
 *
 * Output:
 *   <out>/compat.json   machine-readable compatibility matrix
 *   <out>/compat.md     human-readable matrix (committed for review)
 *
 * Exit code is always 0 unless an internal error occurs; incompatible agents
 * are reported in the matrix and in "incompatible" — the build workflow opens
 * a GitHub issue when that list is non-empty.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = next;
      i++;
    }
  }
  return args;
}

function npmCommand() {
  const execDir = path.dirname(process.execPath);
  const npmCli = path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    return `"${process.execPath}" "${npmCli}"`;
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function tarCommand() {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && existsSync(systemTar)) {
    return `"${systemTar}"`;
  }
  return 'tar';
}

// Minimal semver range check: supports ">=X", ">=X.Y", ">=X.Y.Z", "^X.Y.Z",
// "~X.Y.Z", exact versions, and ">=A <B" conjunctions. Enough for engines
// fields; unknown operators fail closed (treated as unsatisfied).
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesRange(range, version) {
  const v = parseVersion(version);
  if (!v) return false;
  const parts = range.split(/\s+&&\s*|\s+(?=[><^~])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) parts.push(range.trim());
  return parts.every((part) => {
    let m = /^(>=|>|<=|<|\^|~)?\s*(\d+(?:\.\d+)?(?:\.\d+)?)/.exec(part);
    if (!m) return false;
    const op = m[1] || '=';
    const nums = m[2].split('.').map(Number);
    const min = [nums[0] || 0, nums[1] || 0, nums[2] || 0];
    const cmp = compareVersions(v, min);
    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '=': return v[0] === min[0] && v[1] === min[1] && (nums.length < 3 || v[2] === min[2]);
      case '^': {
        if (cmp < 0) return false;
        if (min[0] > 0) return v[0] === min[0];
        if (min[1] > 0) return v[0] === 0 && v[1] === min[1];
        return v[0] === 0 && v[1] === 0 && v[2] === min[2];
      }
      case '~': {
        if (cmp < 0) return false;
        return v[0] === min[0] && v[1] === min[1];
      }
      default: return false;
    }
  });
}

const args = parseArgs(process.argv);
const version = args.version;
const outDir = args.out || 'dist/runtime-compat';

if (!version) {
  console.error('Usage: node scripts/check-runtime-compat.mjs --version <semver> [--source <checkout>] [--out dist/runtime-compat]');
  process.exit(1);
}

const repoRoot = process.cwd();

// --- Requirement side: extract from the devkit package ---
let pkgRoot;
let cleanup = null;
if (args.source) {
  pkgRoot = path.resolve(args.source);
} else {
  const work = await mkdtemp(path.join(tmpdir(), 'runtime-compat-'));
  cleanup = work;
  execSync(`${npmCommand()} pack "huaweicloud-devkit@${version}" --pack-destination "${work}"`, { stdio: 'ignore' });
  const entries = await readdir(work);
  const tgz = entries.find((f) => f.endsWith('.tgz'));
  if (!tgz) {
    console.error('ERROR: npm pack produced no tarball');
    process.exit(1);
  }
  execSync(`${tarCommand()} -xzf "${path.join(work, tgz)}" -C "${work}"`);
  pkgRoot = path.join(work, 'package');
}

let enginesNode = null;
let runtimeTraces = { py: 0, sh: 0 };
try {
  const pkg = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
  enginesNode = pkg.engines?.node || null;
} catch {
  console.error(`ERROR: package.json not found under ${pkgRoot}`);
  process.exit(1);
}

async function countFiles(dir, ext, depth = 0) {
  if (depth > 6) return 0;
  let count = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      count += await countFiles(path.join(dir, e.name), ext, depth + 1);
    } else if (e.name.endsWith(ext)) {
      count++;
    }
  }
  return count;
}

runtimeTraces.py = await countFiles(pkgRoot, '.py');
runtimeTraces.sh = await countFiles(pkgRoot, '.sh');

// --- Supply side: agent runtime registry ---
const registryPath = path.join(repoRoot, 'runtimes.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));

// --- Reconcile ---
const matrix = [];
const incompatible = [];
const warnings = [];

for (const [agent, supply] of Object.entries(registry.agents)) {
  const bundled = supply.node;
  const ok = bundled && enginesNode ? satisfiesRange(enginesNode, bundled) : false;
  const entry = {
    agent,
    bundledNode: bundled,
    nodeCompat: enginesNode ? (ok ? 'ok' : 'insufficient') : 'unknown',
    pythonBundled: supply.python || null,
    lastVerified: supply.lastVerified || null,
  };
  if (!ok) incompatible.push(`${agent}: bundled node ${bundled} does not satisfy engines.node "${enginesNode}"`);
  if (runtimeTraces.py > 0 && !supply.python) {
    entry.pythonNote = 'package ships python scripts on the optional execution track; agent python availability untracked';
    warnings.push(`${agent}: package ships ${runtimeTraces.py} python scripts but no bundled python is registered`);
  }
  matrix.push(entry);
}

if (cleanup) await rm(cleanup, { recursive: true, force: true });

// --- Output ---
const outPath = path.join(repoRoot, outDir);
await mkdir(outPath, { recursive: true });
const compat = {
  checkedAt: new Date().toISOString(),
  devkitVersion: version,
  requirements: {
    node: enginesNode,
    pythonScripts: runtimeTraces.py,
    shellScripts: runtimeTraces.sh,
  },
  registryLastUpdated: registry.lastUpdated,
  matrix,
  incompatible,
  warnings,
};
await writeFile(path.join(outPath, 'compat.json'), JSON.stringify(compat, null, 2), 'utf8');

const rows = matrix
  .map((m) => `| ${m.agent} | ${m.bundledNode || '-'} | ${enginesNode || '-'} | ${m.nodeCompat} | ${m.pythonBundled || '未登记'} | ${m.lastVerified || '-'} |`)
  .join('\n');
const issueRows = matrix
  .map((m) => `| ${m.agent} | ${m.bundledNode || '-'} | ${m.nodeCompat === 'ok' ? '✅' : '❌ ' + (m.bundledNode || '未登记') + ' 不满足 ' + enginesNode} |`)
  .join('\n');
const md = [
  `# Runtime compatibility matrix`,
  '',
  `Checked at ${compat.checkedAt} for huaweicloud-devkit **v${version}**.`,
  '',
  '## Requirements (extracted from the package)',
  '',
  `- engines.node: \`${enginesNode || 'not declared'}\``,
  `- python scripts: ${runtimeTraces.py} (optional execution track)`,
  `- shell scripts: ${runtimeTraces.sh} (optional execution track)`,
  '',
  '## Compatibility matrix',
  '',
  '| Agent | Bundled node | engines.node | Node compat | Bundled python | Last verified |',
  '|-------|-------------|--------------|-------------|----------------|---------------|',
  rows,
  '',
  incompatible.length > 0 ? `## ❌ Incompatible\n\n${incompatible.map((i) => `- ${i}`).join('\n')}` : '## ✅ All registered agents are compatible',
  '',
  warnings.length > 0 ? `## ⚠️ Warnings\n\n${warnings.map((i) => `- ${i}`).join('\n')}` : '',
  '',
  '> Supply side (bundled runtimes) is maintained manually in `runtimes.json` — agent-bundled runtimes cannot be observed from GitHub. Update it on agent upgrades and refresh `lastVerified`.',
  '',
].join('\n');
await writeFile(path.join(outPath, 'compat.md'), md, 'utf8');

// Write the issue body for the workflow to consume.
await writeFile(
  path.join(outPath, 'issue-body.md'),
  [
    `huaweicloud-devkit **v${version}** runtime compatibility check found incompatibilities.`,
    '',
    '| Agent | Bundled node | Verdict |',
    '|-------|-------------|---------|',
    issueRows,
    '',
    `Requirements: engines.node \`${enginesNode}\`, ${runtimeTraces.py} python scripts (optional execution track).`,
    '',
    'Supply side is maintained in `runtimes.json`. If the agent has upgraded its bundled runtime, update the registry; otherwise the devkit engines requirement has outgrown the agent.',
  ].join('\n'),
  'utf8',
);

console.log(`Runtime compat checked for v${version}: ${matrix.length} agents, ${incompatible.length} incompatible, ${warnings.length} warnings`);
if (incompatible.length > 0) {
  console.error(incompatible.map((i) => `INCOMPATIBLE: ${i}`).join('\n'));
}
