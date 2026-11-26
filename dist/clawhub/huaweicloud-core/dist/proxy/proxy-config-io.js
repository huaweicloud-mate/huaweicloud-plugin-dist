// The proxy config-file IO: the on-disk proxy.json store under the devkit
// config tree (~/.config/huaweicloud, relocatable whole-tree via
// HUAWEICLOUD_HOME — the same base pack-state.ts resolves). Split from
// proxy-config.ts — the stable face the rest of the repo imports — in the
// family's complex-file cut; node builtins only, because the module feeds
// BOTH the unbundled setup-cli graph and the bundled mcp-server.
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
function baseHome() {
    return process.env.HUAWEICLOUD_HOME || homedir();
}
export function proxyConfigPath() {
    return join(baseHome(), '.config', 'huaweicloud', 'proxy.json');
}
// One-key reads off unknown parsed JSON, validated before use: only string
// values are surfaced, so callers never handle a raw `unknown` field.
function readString(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}
export function readProxyConfig() {
    const path = proxyConfigPath();
    if (!existsSync(path))
        return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw === null || typeof raw !== 'object')
            return null;
        const record = raw;
        return {
            https_proxy: readString(record, 'https_proxy'),
            http_proxy: readString(record, 'http_proxy'),
            no_proxy: readString(record, 'no_proxy'),
            HTTPS_PROXY: readString(record, 'HTTPS_PROXY'),
            HTTP_PROXY: readString(record, 'HTTP_PROXY'),
            NO_PROXY: readString(record, 'NO_PROXY'),
        };
    }
    catch {
        return null;
    }
}
export function writeProxyConfig(config = {}) {
    const path = proxyConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
        https_proxy: String(config.https_proxy || ''),
        http_proxy: String(config.http_proxy || ''),
        no_proxy: String(config.no_proxy || ''),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    return path;
}
export function clearProxyConfig() {
    const path = proxyConfigPath();
    if (!existsSync(path))
        return false;
    rmSync(path);
    return true;
}
