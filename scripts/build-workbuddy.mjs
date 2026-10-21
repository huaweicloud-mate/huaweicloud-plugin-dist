#!/usr/bin/env node
/**
 * Build the WorkBuddy expert package from a huaweicloud-devkit source checkout.
 *
 * Usage:
 *   node scripts/build-workbuddy.mjs --source <main-repo-path> --version <semver> [--out dist/workbuddy]
 *
 * Inputs:
 *   --source   Path to a huaweicloud-devkit checkout containing plugins/huaweicloud-core/skills
 *   --version  Version to stamp (semver without "v", e.g. 1.1.10-next.2)
 *   --out      Output directory (default: dist/workbuddy); cleaned before build
 *
 * Output:
 *   <out>/huaweicloud-plugin/   The unpacked expert package (commit-ready for review)
 *
 * The package layout mirrors the official WorkBuddy expert-package structure:
 *   huaweicloud-plugin/
 *     .codebuddy-plugin/plugin.json   (version + skills list injected from source)
 *     agents/huaweicloud-plugin.md    (persona + skill-loading rules, version stamped)
 *     avatars/expert.png
 *     skills/                         (full copy of plugins/huaweicloud-core/skills)
 *     README.md                       (version + skill count stamped)
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const args = parseArgs(process.argv);
const source = args.source;
const version = args.version;
const outDir = args.out || 'dist/workbuddy';

if (!source || !version) {
  console.error('Usage: node scripts/build-workbuddy.mjs --source <main-repo-path> --version <semver> [--out dist/workbuddy]');
  process.exit(1);
}

const repoRoot = process.cwd();
const templateDir = path.join(repoRoot, 'templates', 'workbuddy');
const skillsSource = path.join(source, 'plugins', 'huaweicloud-core', 'skills');
const packageRoot = path.join(repoRoot, outDir, 'huaweicloud-plugin');

let skillDirs;
try {
  skillDirs = (await readdir(skillsSource, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
} catch {
  console.error(`ERROR: skills directory not found under ${skillsSource}`);
  process.exit(1);
}

if (skillDirs.length === 0) {
  console.error('ERROR: no skills found in source');
  process.exit(1);
}

// Meta-skills (huaweicloud-*) first, then service skills (huawei-*), both sorted.
const metaSkills = skillDirs.filter((n) => n.startsWith('huaweicloud-')).sort();
const serviceSkills = skillDirs.filter((n) => n.startsWith('huawei-')).sort();
const ordered = [...metaSkills, ...serviceSkills];
const stray = skillDirs.filter((n) => !n.startsWith('huaweicloud-') && !n.startsWith('huawei-'));
if (stray.length > 0) {
  console.error(`ERROR: skill dirs outside the huawei-/huaweicloud- naming scheme: ${stray.join(', ')}`);
  process.exit(1);
}

// Clean output and lay down the package skeleton.
await rm(path.join(repoRoot, outDir), { recursive: true, force: true });
await mkdir(path.join(packageRoot, '.codebuddy-plugin'), { recursive: true });
await mkdir(path.join(packageRoot, 'agents'), { recursive: true });
await mkdir(path.join(packageRoot, 'avatars'), { recursive: true });

// plugin.json — version + skills list injected.
const tmpl = await readFile(path.join(templateDir, 'plugin.json.tmpl'), 'utf8');
const pluginJson = tmpl
  .replaceAll('__SKILLS_JSON__', JSON.stringify(ordered.map((n) => `./skills/${n}`), null, 2))
  .replaceAll('__VERSION__', version);
await writeFile(path.join(packageRoot, '.codebuddy-plugin', 'plugin.json'), pluginJson, 'utf8');

// Persona / avatar / README — version + skill count stamped.
await cp(path.join(templateDir, 'agents'), path.join(packageRoot, 'agents'), { recursive: true });
const agentMdPath = path.join(packageRoot, 'agents', 'huaweicloud-plugin.md');
const agentMd = await readFile(agentMdPath, 'utf8');
await writeFile(agentMdPath, agentMd.replaceAll('__VERSION__', version), 'utf8');
await cp(path.join(templateDir, 'avatars'), path.join(packageRoot, 'avatars'), { recursive: true });
const readme = await readFile(path.join(templateDir, 'README.md'), 'utf8');
await writeFile(
  path.join(packageRoot, 'README.md'),
  readme.replaceAll('__VERSION__', version).replaceAll('__SKILLS_COUNT__', String(ordered.length)),
  'utf8',
);

// Full skills copy from the source checkout.
await cp(skillsSource, path.join(packageRoot, 'skills'), { recursive: true });

// Stamp check: no placeholder may survive into the built package.
const builtAgentMd = await readFile(agentMdPath, 'utf8');
const builtReadme = await readFile(path.join(packageRoot, 'README.md'), 'utf8');
if (builtAgentMd.includes('__VERSION__') || builtReadme.includes('__SKILLS_COUNT__')) {
  console.error('ERROR: unresolved placeholders in built package');
  process.exit(1);
}

console.log(`Built ${outDir}/huaweicloud-plugin at version ${version}`);
console.log(`  skills: ${ordered.length} (${metaSkills.length} meta + ${serviceSkills.length} service)`);
