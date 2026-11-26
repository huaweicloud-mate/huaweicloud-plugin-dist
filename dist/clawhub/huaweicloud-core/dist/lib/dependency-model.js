import { PACK_IDS } from "./pack-types.js";
// First-class dependency vocabulary for the pack system, shared by both
// processes: dist/setup-cli.js (plain tsc output, no zod) and the bundled
// dist/mcp-server.js. Like pack-types.ts, this module's runtime import graph
// stays at zero beyond pack-types itself — the installer must never pull the
// zod-dependent registry chain.
//
// The model separates WHAT exists (DEPENDENCIES, one catalog entry per
// binary) from WHO needs it (PACK_DEPENDENCIES edges). Shared substrate like
// hcloud is declared once and referenced by every consuming pack; core
// deliberately declares no dependency: a core edge would auto-provision
// hcloud for CLI-less trimmed configurations and would make receipt-gated
// uninstall unreachable, because core sits in every enablement closure.
//
// Consumers:
//   - src/packs/enable.ts        (parseDevkitPacks — boot enablement)
//   - src/setup-cli.ts           (parseDevkitPacks — doctor pack status loop;
//                                 requiredDependencies/PACK_USES — doctor binary
//                                 section; effectivePackUnion — dep status/uninstall)
//   - src/dep/provision.ts      (PACK_DEPENDENCIES — receipt-gated uninstall)
//   - src/dep/receipts.ts       (DEPENDENCIES/DependencyId — receipt ids)
export const DEPENDENCY_IDS = ['hcloud', 'open-mcp-gateway', 'devbridge'];
export const DEPENDENCIES = {
    hcloud: {
        kind: 'cli',
        title: 'KooCLI (hcloud)',
        note: 'Shared substrate for CLI execution, auth, and OBS config; owned by no single pack.',
        resolution: {
            envBin: 'HCLOUD_BIN',
            candidates: {
                win32: ['~/hcloud/hcloud.exe'],
                unix: ['~/.local/bin/hcloud', '/usr/local/bin/hcloud', '~/hcloud/hcloud'],
            },
        },
        installPolicy: 'auto',
        installHint: 'Run: npx huaweicloud-devkit dep install hcloud',
    },
    'open-mcp-gateway': {
        kind: 'managed-child',
        title: 'Open MCP Gateway',
        note: 'OpenAPI catalog discovery proxied through a local gateway child of the MCP server (pip package huaweicloud-open-mcp).',
        resolution: {
            envBin: 'OPENMCP_BIN',
            candidates: {
                win32: ['~/.local/bin/huaweicloud-open-mcp.exe'],
                unix: ['~/.local/bin/huaweicloud-open-mcp'],
            },
            fallback: { command: 'uvx', argsPrefix: ['huaweicloud-open-mcp'] },
        },
        installPolicy: 'prompt',
        installHint: 'Run: npx huaweicloud-devkit dep install open-mcp-gateway (uv/pipx/pip all work; uvx needs no install)',
        supervision: {
            owner: 'mcp-server',
            spawn: 'lazy-on-first-call',
            lifetime: 'parent-stdin-pipe',
            escalation: 'sigterm-sigkill-3s',
            respawn: 'on-next-call',
        },
    },
    devbridge: {
        kind: 'sandbox-resident',
        title: 'DevBridge',
        note: 'CDN-distributed binary that ships inside the cloud sandbox; the host never manages it.',
    },
};
// Pack → binary requirement edges. All ten packs are declared (an empty list
// is a declaration: "this pack needs nothing beyond the payload"). hcloud is
// attributed to every real consumer and to core not at all.
export const PACK_DEPENDENCIES = {
    core: [],
    'huaweicloud-cli': ['hcloud'],
    sandbox: ['devbridge'],
    auth: ['hcloud'],
    obs: ['hcloud'],
    voucher: [],
    update: [],
    discovery: [],
    'huaweicloud-open-mcp': ['open-mcp-gateway'],
    secrets: [],
};
// Pack → pack edges. requires is the hard closure (enabling a pack enables
// its dependencies); uses is the soft degradation shadow (doctor warns when a
// used pack is disabled; the SKILL.md manual fallbacks stay authoritative).
// No hard edges exist today; the mechanism ships so the first real one is a
// one-line declaration.
export const PACK_REQUIRES = {};
export const PACK_USES = {
    // huawei-sandbox SKILL.md documents detect_framework (discovery) and
    // setup_obs_config (obs) with manual fallbacks when those packs are off.
    sandbox: ['discovery', 'obs'],
};
// The one closure algorithm. The injected graph keeps it testable against
// synthetic cycles and diamonds; the product binding below is the only place
// core force-include and PACK_REQUIRES meet.
export function closeEnablement(requested, requires) {
    const requestedSet = new Set(requested);
    const enabled = new Set(requestedSet);
    const queue = [...requestedSet];
    while (queue.length > 0) {
        const id = queue.pop();
        if (id === undefined)
            break;
        for (const dep of requires(id)) {
            if (enabled.has(dep))
                continue;
            enabled.add(dep);
            queue.push(dep);
        }
    }
    const pulledBy = new Map();
    for (const id of enabled) {
        if (requestedSet.has(id))
            continue;
        const requirers = [...enabled].filter((other) => requires(other).includes(id));
        pulledBy.set(id, requirers);
    }
    return { requested: requestedSet, enabled, pulledBy };
}
// Product binding: core is force-included (disclosure invariant — the pack
// meta tools live in core, so trimming can never hide what was disabled),
// then closed under PACK_REQUIRES.
export function closePackEnablement(requested) {
    return closeEnablement(new Set(['core', ...requested]), (id) => PACK_REQUIRES[id] ?? []);
}
// Tolerant DEVKIT_PACKS parse for diagnostic boundaries (doctor, install
// read-back): unknown ids are reported, never thrown. Blank/unset yields the
// full default surface. The result is already closed and core-forced, so no
// consumer re-applies either rule.
export function parseDevkitPacks(raw) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
        return { raw: '', requested: [], unknown: [], enabled: new Set(PACK_IDS) };
    }
    const items = trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    const valid = new Set(PACK_IDS);
    const unknown = items.filter((item) => !valid.has(item));
    const requested = items.filter((item) => valid.has(item));
    return { raw: trimmed, requested, unknown, enabled: closePackEnablement(requested).enabled };
}
// The host-side requirement set for an enabled pack set. Sandbox-resident
// entries are included; provisioning consumers filter by scope.
export function requiredDependencies(enabled) {
    const out = new Set();
    for (const id of enabled) {
        for (const dep of PACK_DEPENDENCIES[id])
            out.add(dep);
    }
    return out;
}
