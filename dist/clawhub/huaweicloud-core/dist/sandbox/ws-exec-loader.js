// The ws-exec runtime loader, extracted from session-manager: resolves the
// untyped ws-exec barrel across the three runtime layouts (source,
// compiled mirror, bundled server entry), models its structural surface, and
// exposes loadWsExec/firstExisting for the sandbox siblings. This module is a
// src/sandbox SUBDIR module — the __dirname one-climb discipline below is what
// the structure guard pins; it resolves identically in all three layouts
// because every src/sandbox sibling sits at the same depth.
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
// Asset and barrel paths must resolve in three layouts: source (src/sandbox,
// Node type-stripping), compiled mirror (dist/sandbox/*.js), and the bundled
// server entry (dist/mcp-server.js inlines this module, so __dirname is dist/
// itself and subdirectory assets sit one level below it).
export function firstExisting(...candidates) {
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    // Both call sites pass literal, non-empty candidate lists; the last entry is the fallback.
    return candidates[candidates.length - 1];
}
// ws-exec's sources are TypeScript, but runtime entry points read the compiled
// dist barrel. Prefer the compiled barrel (dist/sandbox -> dist/ws-exec, or the
// bundled entry -> dist/ws-exec) and fall back to the source barrel for
// in-repo runs (src/sandbox -> src/ws-exec, stripped by Node outside
// node_modules).
export function resolveWsExecIndexUrl() {
    const barrel = firstExisting(join(__dirname, '..', 'ws-exec', 'index.js'), join(__dirname, 'ws-exec', 'index.js'), join(__dirname, '..', 'ws-exec', 'index.ts'));
    return pathToFileURL(barrel).href;
}
export async function loadWsExec() {
    return (await import(__rewriteRelativeImportExtension(resolveWsExecIndexUrl())));
}
