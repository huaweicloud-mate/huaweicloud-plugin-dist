import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { codexPluginProbe } from "../codex-probe.js";
import { probeOfficeaceSystemDirs } from "../officeace-paths.js";
import { asRecord } from "../lib/as-record.js";
export const SUPPORTED_AGENT_TARGETS = [
    'opencode',
    'codex',
    'codex-desktop',
    'codearts',
    'codearts-work',
    'workbuddy',
    'dsh',
    'officeace',
    'hermes',
    'openclaw',
    'atomcode',
];
// Agent-owned config paths resolve from the real home. HUAWEICLOUD_HOME
// relocates only devkit-owned state (credentials.ts); the installer writes
// agent configs under homedir(), so detection must read the same place.
// opencode is the exception on the config ROOT: it reads XDG_CONFIG_HOME
// with ~/.config as the default. This resolver follows the XDG spec's
// absolute-only rule; note the known divergence — the pinned opencode
// (1.19.0) honors RELATIVE values against its cwd, so a non-compliant
// relative XDG_CONFIG_HOME still splits installer (~/.config) from agent
// (<cwd>/<relative>). Matching cwd-dependent resolution would be worse;
// every opencode path derivation — the write side (configRoot in
// src/targets.ts), the detection side below, and the agent-presence probe —
// must share this resolver regardless.
export function xdgConfigHome() {
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
}
// The canonical jsonc-then-json preference: the detection side here and the
// installer's write side (re-exported through src/targets.ts) must resolve
// the same file or a written config goes unread.
export function opencodeConfigFile() {
    const jsonc = join(xdgConfigHome(), 'opencode', 'opencode.jsonc');
    if (existsSync(jsonc))
        return jsonc;
    return join(xdgConfigHome(), 'opencode', 'opencode.json');
}
function readJsonSafe(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
function opencodeRegistered() {
    const path = opencodeConfigFile();
    const cfg = asRecord(readJsonSafe(path));
    return Boolean(asRecord(cfg.mcp)['huaweicloud-devkit']);
}
function codexDesktopRegistered() {
    // Current-era installs ship the server payload to
    // ~/plugins/huaweicloud-devkit (codexDesktopPluginsDir in setup-cli);
    // config.toml sections are pre-marketplace residue the uninstaller
    // actively removes, kept only as a legacy fallback.
    if (existsSync(join(homedir(), 'plugins', 'huaweicloud-devkit', 'dist', 'mcp-server.js')))
        return true;
    const legacyPath = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(legacyPath))
        return false;
    try {
        return readFileSync(legacyPath, 'utf8').includes('[mcp_servers.huaweicloud-devkit]');
    }
    catch {
        return false;
    }
}
function codexCliRegistered() {
    const probe = codexPluginProbe();
    return probe.ok && probe.installed;
}
function codeartsRegistered() {
    const paths = [
        join(homedir(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
        join(process.cwd(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
    ];
    return paths.some((path) => {
        const cfg = asRecord(readJsonSafe(path));
        return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
    });
}
function codeartsWorkRegistered() {
    const path = join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json');
    const cfg = asRecord(readJsonSafe(path));
    return Boolean(asRecord(cfg.mcp)['huaweicloud-devkit']);
}
function workbuddyRegistered() {
    const cfg = asRecord(readJsonSafe(join(homedir(), '.workbuddy', 'mcp.json')));
    return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
}
function dshRoot() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function dshRegistered() {
    const patchPath = join(dshRoot(), 'profiles', 'web', 'cordis.patch.yml');
    if (!existsSync(patchPath))
        return false;
    try {
        const patch = readFileSync(patchPath, 'utf8');
        return ((patch.includes('id: huaweicloud-devkit') || patch.includes('id: mcp-huaweicloud')) &&
            patch.includes('@deepseek-ai/dsh-mcp-client') &&
            patch.includes('serverName: huaweicloud'));
    }
    catch {
        return false;
    }
}
// The shared Windows-side probe (registry + Program Files) lives in
// officeace-paths.ts; agent-registration's predicate requires
// capabilities.json, the installer's accepts any OfficeAce evidence.
function officeaceCapabilitiesDir() {
    const configRoot = process.env.OFFICE_CLAW_CONFIG_ROOT;
    if (configRoot && existsSync(join(configRoot, 'capabilities.json')))
        return configRoot;
    return probeOfficeaceSystemDirs((dir) => existsSync(join(dir, 'capabilities.json')));
}
function officeaceCapabilitiesDirSafe() {
    return officeaceCapabilitiesDir() || join(homedir(), '.office-claw');
}
function officeaceSqlitePath() {
    const capDir = officeaceCapabilitiesDirSafe();
    return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}
function toSqliteModule(value) {
    if (!value || typeof value !== 'object')
        return null;
    const ctor = value.DatabaseSync;
    return typeof ctor === 'function' ? value : null;
}
function officeaceRegistered() {
    let hasMcp = false;
    const dbPath = officeaceSqlitePath();
    if (existsSync(dbPath)) {
        const nodeMajor = Number(process.versions.node.split('.')[0]);
        if (nodeMajor >= 22) {
            try {
                const sqlite = toSqliteModule(createRequire(import.meta.url)('node:sqlite'));
                if (sqlite) {
                    const db = new sqlite.DatabaseSync(dbPath, { readonly: true });
                    const row = db.prepare("SELECT enabled FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
                    db.close();
                    hasMcp = Boolean(asRecord(row).enabled);
                }
            }
            catch {
                // unreadable or locked connector db leaves hasMcp false; the capabilities.json check below still decides
            }
        }
    }
    const capFile = join(officeaceCapabilitiesDirSafe(), 'capabilities.json');
    const cfg = asRecord(readJsonSafe(capFile));
    const capabilities = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
    const hasSkills = capabilities.some((c) => {
        const cap = asRecord(c);
        return cap.id === 'huaweicloud-core' && cap.type === 'skill';
    });
    return hasMcp || hasSkills;
}
function atomcodeHome() {
    return process.env.ATOMCODE_HOME || join(homedir(), '.atomcode');
}
function atomcodeRegistered() {
    const cfg = asRecord(readJsonSafe(join(atomcodeHome(), 'mcp.json')));
    return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
}
function openclawMcpConfigured(cfg) {
    if (!cfg)
        return false;
    const record = asRecord(cfg);
    if (asRecord(record.mcpServers)['huaweicloud-devkit'])
        return true;
    if (asRecord(asRecord(record.mcp).servers)['huaweicloud-devkit'])
        return true;
    return false;
}
function openclawRegistered() {
    const pluginCfg = readJsonSafe(join(homedir(), '.agents', 'huaweicloud-plugins', '.mcp.json'));
    if (openclawMcpConfigured(pluginCfg))
        return true;
    const nativeCfg = readJsonSafe(join(homedir(), '.openclaw', 'openclaw.json'));
    return openclawMcpConfigured(nativeCfg);
}
function hermesHome() {
    // Mirrors the installer's hermesHomeDir: HERMES_HOME override, then
    // ~/.hermes on every platform (docs/hermes-windows.md documents
    // %USERPROFILE%\.hermes as the layout, not LOCALAPPDATA).
    if (process.env.HERMES_HOME)
        return process.env.HERMES_HOME;
    return join(homedir(), '.hermes');
}
function hermesRegistered() {
    const configPath = join(hermesHome(), 'config.yaml');
    if (!existsSync(configPath))
        return false;
    try {
        const content = readFileSync(configPath, 'utf8');
        return content.includes('mcp_servers:') && content.includes('huaweicloud-devkit');
    }
    catch {
        return false;
    }
}
export function getAgentRegistrationStatuses(target = 'all') {
    const requested = target === 'all' ? SUPPORTED_AGENT_TARGETS : [target];
    const result = { target, agents: {} };
    for (const agent of requested) {
        let configured = false;
        if (agent === 'opencode')
            configured = opencodeRegistered();
        if (agent === 'codex-desktop')
            configured = codexDesktopRegistered();
        if (agent === 'codex')
            configured = codexCliRegistered();
        if (agent === 'codearts')
            configured = codeartsRegistered();
        if (agent === 'codearts-work')
            configured = codeartsWorkRegistered();
        if (agent === 'workbuddy')
            configured = workbuddyRegistered();
        if (agent === 'dsh')
            configured = dshRegistered();
        if (agent === 'officeace')
            configured = officeaceRegistered();
        if (agent === 'hermes')
            configured = hermesRegistered();
        if (agent === 'openclaw')
            configured = openclawRegistered();
        if (agent === 'atomcode')
            configured = atomcodeRegistered();
        result.agents[agent] = { configured };
    }
    return result;
}
