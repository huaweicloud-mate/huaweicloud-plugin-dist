import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupOnPath } from "./lib/dep-resolve.js";
import { asRecord } from "./lib/as-record.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const PACKAGE_ROOT = resolve(PLUGIN_ROOT, '..', '..');
export function getMarketplaceName() {
    const marketplacePath = join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json');
    try {
        const manifest = asRecord(JSON.parse(readFileSync(marketplacePath, 'utf8')));
        if (typeof manifest.name === 'string' && manifest.name)
            return manifest.name;
    }
    catch {
        // missing or corrupt marketplace.json means the default marketplace name
    }
    return 'huaweicloud-devkit';
}
export function getCodexPluginName() {
    const marketplacePath = join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json');
    try {
        const marketplace = asRecord(JSON.parse(readFileSync(marketplacePath, 'utf8')));
        const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
        const pluginName = asRecord(plugins[0]).name;
        if (typeof pluginName === 'string' && pluginName)
            return pluginName;
    }
    catch {
        // missing or corrupt marketplace.json falls through to the plugin manifest
    }
    const codexManifestPath = join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json');
    try {
        const manifest = asRecord(JSON.parse(readFileSync(codexManifestPath, 'utf8')));
        if (typeof manifest.name === 'string' && manifest.name)
            return manifest.name;
    }
    catch {
        // missing or corrupt plugin manifest means the default plugin name
    }
    return 'huaweicloud-devkit';
}
export function codexPluginProbe() {
    if (lookupOnPath('codex', process.env) === null)
        return { ok: true, installed: false };
    // Parse the structured output instead of substring-matching the table: the
    // plugin's SOURCE path (…/plugins/huaweicloud-core) also contains the name,
    // so a naive includes() reports "installed" even when the status column says
    // "not installed".
    const r = spawnSync('codex plugin list --json', [], {
        shell: true,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 5000,
    });
    if (r.status !== 0)
        return { ok: false };
    const out = r.stdout ? r.stdout.toString() : '';
    const name = getCodexPluginName();
    try {
        const data = asRecord(JSON.parse(out));
        if (!Array.isArray(data.installed))
            return { ok: false };
        return {
            ok: true,
            installed: data.installed.some((p) => {
                const record = asRecord(p);
                return record.name === name || (typeof record.pluginId === 'string' && record.pluginId.startsWith(`${name}@`));
            }),
        };
    }
    catch {
        return { ok: false };
    }
}
