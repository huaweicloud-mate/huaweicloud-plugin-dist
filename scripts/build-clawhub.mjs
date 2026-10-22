#!/usr/bin/env node
/**
 * Build the ClawHub package from the published npm tarball.
 *
 * Usage:
 *   node scripts/build-clawhub.mjs --version <semver> [--out dist/clawhub]
 *
 * Mirrors upstream scripts/clawhub-publish.sh steps 1-2 (package acquisition),
 * but writes the package tree to the dist repo instead of publishing directly:
 *   - npm pack huaweicloud-devkit@<version>  (registry is the single source of truth,
 *     so package content always matches the npm version exactly)
 *   - extract plugins/huaweicloud-core
 *   - validate openclaw.plugin.json exists and its version matches
 *   - copy to <out>/huaweicloud-core (commit-ready for review)
 *
 * The ClawHub package structure is the plugins/huaweicloud-core directory as-is
 * (openclaw.plugin.json + skills/ + src/ + ...), bundled by the clawhub CLI with
 * --family bundle-plugin --bundle-format codex.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

// Resolve npm: prefer the npm-cli.js next to the running node binary (works
// when the node install dir is not on the child-process PATH, e.g. nvm4w on
// Windows), falling back to plain npm (works on CI).
function npmCommand() {
  const execDir = path.dirname(process.execPath);
  const npmCli = path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    return `"${process.execPath}" "${npmCli}"`;
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// Resolve tar: Windows ships bsdtar in System32, which may be missing from a
// restricted child-process PATH; fall back to the absolute path.
function tarCommand() {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && existsSync(systemTar)) {
    return `"${systemTar}"`;
  }
  return 'tar';
}

const args = parseArgs(process.argv);
const version = args.version;
const outDir = args.out || 'dist/clawhub';

if (!version) {
  console.error('Usage: node scripts/build-clawhub.mjs --version <semver> [--out dist/clawhub]');
  process.exit(1);
}

const repoRoot = process.cwd();
const packageRoot = path.join(repoRoot, outDir, 'huaweicloud-core');

const work = await mkdtemp(path.join(tmpdir(), 'clawhub-'));
try {
  console.log(`[1/3] npm pack huaweicloud-devkit@${version}...`);
  execSync(`${npmCommand()} pack "huaweicloud-devkit@${version}" --pack-destination "${work}"`, { stdio: 'inherit' });
  const entries = await readdir(work);
  const tgz = entries.find((f) => f.endsWith('.tgz'));
  if (!tgz) {
    console.error('ERROR: npm pack produced no tarball');
    process.exit(1);
  }
  execSync(`${tarCommand()} -xzf "${path.join(work, tgz)}" -C "${work}"`);
  const pluginDir = path.join(work, 'package', 'plugins', 'huaweicloud-core');
  let exists;
  try {
    exists = (await readFile(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8')) !== undefined;
  } catch {
    exists = false;
  }
  if (!exists) {
    console.error('ERROR: plugins/huaweicloud-core or openclaw.plugin.json not found in the tarball; package layout may have changed');
    process.exit(1);
  }

  console.log('[2/3] Validate manifest version...');
  const manifest = JSON.parse(await readFile(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  if (manifest.version !== version) {
    console.error(`ERROR: openclaw.plugin.json version ${manifest.version} does not match npm version ${version}`);
    process.exit(1);
  }

  console.log('[3/3] Copy package tree...');
  await rm(path.join(repoRoot, outDir), { recursive: true, force: true });
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await cp(pluginDir, packageRoot, { recursive: true });

  console.log(`Built ${outDir}/huaweicloud-core at version ${version}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
