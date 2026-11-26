import { existsSync, readFileSync } from 'node:fs';
import { asRecord } from "./lib/as-record.js";
import { PACK_IDS } from "./lib/pack-types.js";
const PACK_ID_SET = new Set(PACK_IDS);
let packsFlagCache;
// Parse a comma-separated pack id list, the shared core of --packs flag
// validation and the packs command family's argv parse. Returns the trimmed
// non-empty ids, or the bogus ones for the caller to report (the callers
// differ in failure mode: the flag exits the process, the command sets
// exitCode and returns).
export function parsePackIdList(raw) {
    const ids = raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    return { ids, bogus: ids.filter((id) => !PACK_ID_SET.has(id)) };
}
// Parse and validate --packs once per process; bogus input exits non-zero on
// stderr with the unknown id(s) and the valid id list, mirroring --target.
// Call before any file is copied so a typo cannot half-install.
export function resolvePacksFlag() {
    if (packsFlagCache)
        return packsFlagCache;
    const idx = process.argv.indexOf('--packs');
    let result = { kind: 'unset' };
    if (idx >= 0) {
        const raw = process.argv[idx + 1];
        if (raw === undefined || raw === '' || raw.startsWith('--')) {
            console.error('Missing value for --packs (expected a comma-separated pack id list or "all")');
            console.error(`Valid pack ids: ${PACK_IDS.join(', ')} (or "all")`);
            process.exit(1);
        }
        if (raw.trim().toLowerCase() === 'all') {
            result = { kind: 'all' };
        }
        else {
            const { ids, bogus } = parsePackIdList(raw);
            if (bogus.length > 0) {
                console.error(`Unknown pack id(s): ${bogus.join(', ')}`);
                console.error(`Valid pack ids: ${PACK_IDS.join(', ')} (or "all")`);
                process.exit(1);
            }
            result = { kind: 'ids', value: ids.join(',') };
        }
    }
    packsFlagCache = result;
    return result;
}
// The DEVKIT_PACKS value a config should carry after this run, given its
// current value. keptUserValue marks the case where a user-set value won.
export function packsWriteValue(current) {
    const flag = resolvePacksFlag();
    if (flag.kind === 'unset')
        return { next: current, keptUserValue: false, requested: '' };
    if (flag.kind === 'all')
        return { next: null, keptUserValue: false, requested: 'all' };
    if (current !== null && current !== flag.value) {
        return { next: current, keptUserValue: true, requested: flag.value };
    }
    return { next: flag.value, keptUserValue: false, requested: flag.value };
}
export function warnPacksUserValueKept(label, current, requested) {
    console.log(`  \x1b[33m[WARN]\x1b[0m ${label}: config already sets DEVKIT_PACKS="${current}"; keeping it (--packs would set "${requested}"). Run with --packs all to clear it.`);
}
// The env field + current DEVKIT_PACKS value one MCP entry carries — the
// shared read both policy functions derive from, so the entry-shape
// narrowing lives once.
function readPacksEnv(entry, envKey) {
    const rawEnv = asRecord(entry)[envKey];
    const existingEnv = rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
        ? rawEnv
        : null;
    const current = existingEnv !== null && typeof existingEnv.DEVKIT_PACKS === 'string' ? existingEnv.DEVKIT_PACKS : null;
    return { existingEnv, current };
}
// Apply the packs policy to one merged MCP entry. `envKey` is the env field
// the target's harness reads ('env' for .mcp.json-style entries,
// 'environment' for OpenCode and CodeArts Work). Returns true when the entry
// changed, so callers can fold it into their "unchanged" short-circuit.
// The single warning site: a kept user value warns here, exactly once —
// packsEntryPending is pure and never warns.
export function applyPacksToEntry(entry, envKey, label) {
    const flag = resolvePacksFlag();
    if (flag.kind === 'unset')
        return false;
    const { existingEnv, current } = readPacksEnv(entry, envKey);
    const { next, keptUserValue, requested } = packsWriteValue(current);
    if (keptUserValue) {
        warnPacksUserValueKept(label, current ?? '', requested);
        return false;
    }
    if (next === current)
        return false;
    if (next === null) {
        if (existingEnv === null || !Object.hasOwn(existingEnv, 'DEVKIT_PACKS'))
            return false;
        delete existingEnv.DEVKIT_PACKS;
        if (Object.keys(existingEnv).length === 0)
            delete entry[envKey];
        return true;
    }
    entry[envKey] = { ...(existingEnv ?? {}), DEVKIT_PACKS: next };
    return true;
}
export function packsEntryPending(entry, envKey) {
    if (resolvePacksFlag().kind === 'unset') {
        return { pending: false, keptUserValue: false, current: null, requested: '' };
    }
    const { current } = readPacksEnv(entry, envKey);
    const { next, keptUserValue, requested } = packsWriteValue(current);
    return { pending: !keptUserValue && next !== current, keptUserValue, current, requested };
}
// For writers that regenerate their config wholesale (YAML blocks, the
// OfficeAce sqlite row): resolve the DEVKIT_PACKS value to carry forward.
export function packsCarryValue(label, current) {
    const { next, keptUserValue, requested } = packsWriteValue(current);
    if (keptUserValue)
        warnPacksUserValueKept(label, current ?? '', requested);
    return next;
}
// Read the DEVKIT_PACKS value one MCP config entry carries, trying both env
// field spellings agents accept. Null when the file/entry/key is absent.
export function readDevkitPacksFromJson(configPath, mapKey) {
    if (!existsSync(configPath))
        return null;
    try {
        const entry = asRecord(asRecord(asRecord(JSON.parse(readFileSync(configPath, 'utf8')))[mapKey])['huaweicloud-devkit']);
        for (const envKey of ['environment', 'env']) {
            const value = asRecord(entry[envKey]).DEVKIT_PACKS;
            if (typeof value === 'string')
                return value;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function readDevkitPacksFromYaml(configPath) {
    if (!existsSync(configPath))
        return null;
    try {
        const match = readFileSync(configPath, 'utf8').match(/^\s*DEVKIT_PACKS:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
        return match ? match[1].trim() : null;
    }
    catch {
        return null;
    }
}
