// The payload-triple doctor sections, one per PAYLOAD_TARGETS row: the
// server/undici/safety/skills-tree set-equality probes and the deferred
// native-freshness closure (the receipt-gated checks live in
// src/doctor-native.ts). setup-cli's table binds every row to a section
// factory — the generic payloadDoctorSection, or an agent-owned override
// (the dsh row's package-root candidate in agents/dsh-patch.ts) — so a new
// row cannot appear without its doctor coverage.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nativeFreshnessChecks } from "./doctor-native.js";
import { mcpServerInstalled, serverSkillDirNames } from "./install-payload.js";
import { verifyIntegrity } from "./safety-integrity.js";
// Set equality against the shipped manifest, not a count floor and not a
// one-direction subset: verifySkillTree (boot) rejects missing, hollow (name
// present, SKILL.md absent), and unclaimed entries, so doctor must fail any
// payload the server would refuse to start — doctor's listing is the same
// shared predicate the boot guard uses.
export function skillsTreeMatches(dir, expectedSkills) {
    const present = new Set(serverSkillDirNames(dir));
    return present.size === expectedSkills.length && expectedSkills.every((name) => present.has(name));
}
// The generic per-row section: the triple over the row's plugin dir plus the
// receipt-gated native-freshness checks over the row's native dirs.
// The generic per-row section: the triple over the row's plugin dir plus
// the receipt-gated native-freshness checks over the row's native dirs,
// plus the deployed-classifier integrity comparison (layer 3). Rows
// without a deployed safety payload stay silent; a payload without a
// receipt (a pre-integrity install) WARNs — backward compatibility, never
// a false red; drift FAILs with the reinstall remediation.
export function payloadDoctorSection(row, shared) {
    const dir = row.dir();
    return {
        triple: {
            server: mcpServerInstalled(dir),
            undici: existsSync(join(dir, 'node_modules', 'undici')),
            safety: existsSync(join(dir, 'safety', 'policy.json')),
            skillsTree: skillsTreeMatches(dir, shared.expectedSkills),
        },
        nativeFreshness: (ctx) => nativeFreshnessChecks(ctx, row, shared.corePack),
        integrity: (ctx) => payloadIntegrityCheck(ctx, row.label, dir),
    };
}
export function payloadIntegrityCheck(ctx, label, dir) {
    const status = verifyIntegrity(dir);
    if (status.status === 'no-payload')
        return;
    if (status.status === 'match') {
        ctx.pass(`Safety policy integrity (${label})`);
        return;
    }
    if (status.status === 'no-receipt') {
        ctx.warn(`Safety policy integrity (${label}) — integrity receipt missing (payload predates integrity tracking); re-run: npx huaweicloud-devkit install`);
        return;
    }
    const all = [...status.drifted, ...status.missing, ...status.unrecorded];
    const parts = [
        status.drifted.length > 0 ? `${status.drifted.length} changed` : '',
        status.missing.length > 0 ? `${status.missing.length} missing` : '',
        status.unrecorded.length > 0 ? `${status.unrecorded.length} unrecorded` : '',
    ].filter(Boolean);
    const names = `${all.slice(0, 3).join(', ')}${all.length > 3 ? ', …' : ''}`;
    ctx.check(`Safety policy integrity (${label})`, false, `${parts.join(', ')} classifier file(s) (${names}) — Run: npx huaweicloud-devkit install`);
}
