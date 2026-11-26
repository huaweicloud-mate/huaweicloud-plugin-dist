// The OpenCode client permission rules for the approval roster — pure
// merge/cleanup logic.
//
// Purpose: in the ASK approval posture (DEVKIT_APPROVAL_MODE=ask), the
// confirmation runs on the SERVER inside the tool call — an elicitation form
// on opencode 2.x, the T3 chat round-trip on 1.19–1.x (where forms do not
// exist, so the yield hands the only mechanical client prompt to the
// round-trip, recorded as posture trust). The client rules are yield-only:
// one exact `allow` rule per roster tool suppresses the redundant client
// popup so the server's confirmation is the only prompt. A client rule can
// therefore no longer fail anything open — the gate confirms every roster
// call regardless — but a `deny` rule still bricks the call in the client,
// which is why the doctor keeps deny a FAIL direction.
//
// Shape, measured on opencode 2.2.7: the V2 config key is a top-level
// `permissions` ARRAY of { action, resource, effect } objects; the MCP tool
// action is `<server>_<tool>` (approval-roster.ts owns the derivation), and
// the config hot-reloads without restarting opencode. Exact per-tool rules
// stay the choice over a server-wide wildcard: value-exact uninstall and
// per-rule doctor verification both need per-tool rows, and a wildcard row is
// indistinguishable from a user's own. 2.2.7 still parses the V1 `permission`
// object the skills-tree seam writes (the bundle migrates it), but the V2
// rule rides ONLY the array form.
//
// opencode 1.19.0–1.x alignment (the V1 `permission` object form):
// source-verified on the v1.19.0 tag — the same version the skills-tree seam
// measures. mcp/catalog.ts toolName() builds the permission key as
// sanitize(server) + "_" + sanitize(tool), byte-identical across shapes, so
// the roster action is shared; permission/index.ts fromConfig() turns a bare
// string value under a key into { permission, pattern: "*", action: value },
// and evaluate() is findLast — appending our key last beats any earlier user
// wildcard, mirroring V2's last-matching-rule-wins. A V1 "Always allow" is
// session memory, not a persisted grant, so it dies with the process.
//
// Ownership rules: an entry on a roster action is user-owned by construction —
// add-only-if-absent per rule (a pre-existing entry that is anything but our
// exact allow survives the write; `skipped` reports it by action, so partial
// coverage is always surfaced) and value-exact deletion (only the
// devkit-written `allow`/legacy `ask` shapes are removed) are the whole
// contract. The accepted edge is the same one the seam records: a
// user-authored same-shape rule that predates the write is removed together
// with it.
//
// Legacy migration: the pre-yield posture wrote effect `ask` on the same
// action. Every install/update removes those value-exact ask rules in both
// generations before applying the allow set, so the abandoned posture never
// survives a path that touches the config.
//
// This module is pure: no fs, no spawn, no console — opencode-config.ts owns
// I/O, the version probe, and logging; tests import these functions directly.
import { APPROVAL_TOOLS, approvalToolAction } from "../approval-roster.js";
import { asRecord } from "./as-record.js";
export const PERMISSION_RULE_RESOURCE = '*';
// Every roster tool's client permission action, derived from the roster leaf
// so the writer, the uninstaller, and the doctor can never drift.
export function allowRuleActions() {
    return APPROVAL_TOOLS.map((tool) => approvalToolAction(tool));
}
function isRuleRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function allowRule(action) {
    return { action, resource: PERMISSION_RULE_RESOURCE, effect: 'allow' };
}
// ── V2: the `permissions` array form (opencode 2.0+) ──
// Mutates config in place. Fresh configs get the N-entry allow set; arrays
// without an entry on a roster action get that entry APPENDED — OpenCode
// evaluates last-matching-rule-wins, so the appended entry is the effective
// one. An action already carrying exactly our rule is the target state (a
// reinstall is a no-op, never a false "user-owned" warning); an action
// carrying anything else is the user's and is skipped by name, so the writer
// never overrides a user's deny/ask or different resource.
export function applyAllowPermissionRules(config, actions = allowRuleActions()) {
    if (config.permissions === undefined) {
        config.permissions = actions.map((action) => allowRule(action));
        return { changed: actions.length > 0, skipped: [], shapeUnreadable: false };
    }
    if (!Array.isArray(config.permissions)) {
        return { changed: false, skipped: [], shapeUnreadable: true };
    }
    const rules = config.permissions;
    const skipped = [];
    let changed = false;
    for (const action of actions) {
        const matching = rules.filter(isRuleRecord).filter((rule) => rule.action === action);
        if (matching.length > 0) {
            const ours = matching.every((rule) => rule.resource === PERMISSION_RULE_RESOURCE && rule.effect === 'allow');
            if (!ours)
                skipped.push(action);
            continue;
        }
        rules.push(allowRule(action));
        changed = true;
    }
    return { changed, skipped, shapeUnreadable: false };
}
// Mutates config in place. Value-exact deletion only — an entry matching
// action + resource '*' + the given effect exactly is ours; a user-modified
// entry (any other effect or resource) survives. The array key is pruned only
// when OUR removals emptied it; a pre-existing empty array is left untouched.
function removeExactRules(config, actions, effect) {
    if (!Array.isArray(config.permissions))
        return false;
    const rules = config.permissions;
    const kept = rules.filter((rule) => !(isRuleRecord(rule) &&
        typeof rule.action === 'string' &&
        actions.includes(rule.action) &&
        rule.resource === PERMISSION_RULE_RESOURCE &&
        rule.effect === effect));
    if (kept.length === rules.length)
        return false;
    if (kept.length === 0) {
        delete config.permissions;
    }
    else {
        config.permissions = kept;
    }
    return true;
}
// The client half at uninstall: every devkit-written allow rule, value-exact.
export function removeAllowPermissionRules(config, actions = allowRuleActions()) {
    return removeExactRules(config, actions, 'allow');
}
// The abandoned ask posture, value-exact: migration (install/update) and
// uninstall both remove it.
export function removeAskPermissionRules(config, actions = allowRuleActions()) {
    return removeExactRules(config, actions, 'ask');
}
// ── V1: the `permission` object form (opencode 1.19.0 – 1.x) ──
// Mutates config in place. Fresh configs get the N-key allow object; object
// configs without a roster key get it APPENDED — V1's evaluate() is findLast
// over the fromConfig() ruleset, and Object.entries preserves insertion
// order, so the appended key is the effective one. A key already set to
// 'allow' is the target state (reinstall no-op); any other value is the
// user's and is skipped by name. A scalar-shaped `permission` (the user's
// global posture) is never converted.
export function applyAllowPermissionRulesV1(config, actions = allowRuleActions()) {
    if (config.permission === undefined) {
        config.permission = Object.fromEntries(actions.map((action) => [action, 'allow']));
        return { changed: actions.length > 0, skipped: [], shapeUnreadable: false };
    }
    if (!isRuleRecord(config.permission)) {
        return { changed: false, skipped: [], shapeUnreadable: true };
    }
    const permission = config.permission;
    const skipped = [];
    let changed = false;
    for (const action of actions) {
        const value = permission[action];
        if (value === 'allow')
            continue;
        if (value !== undefined) {
            skipped.push(action);
            continue;
        }
        permission[action] = 'allow';
        changed = true;
    }
    return { changed, skipped, shapeUnreadable: false };
}
function removeExactKeys(config, actions, effect) {
    if (!isRuleRecord(config.permission))
        return false;
    const permission = config.permission;
    let removed = false;
    for (const action of actions) {
        if (permission[action] === effect) {
            delete permission[action];
            removed = true;
        }
    }
    if (!removed)
        return false;
    if (Object.keys(permission).length === 0)
        delete config.permission;
    return true;
}
export function removeAllowPermissionRulesV1(config, actions = allowRuleActions()) {
    return removeExactKeys(config, actions, 'allow');
}
export function removeAskPermissionRulesV1(config, actions = allowRuleActions()) {
    return removeExactKeys(config, actions, 'ask');
}
export function readPermissionRules(config, actions = allowRuleActions()) {
    if (config.permissions !== undefined && !Array.isArray(config.permissions)) {
        return {
            sectionUnreadable: true,
            rules: actions.map((action) => ({ action, state: 'foreign', askResidue: false })),
        };
    }
    const rules = Array.isArray(config.permissions) ? config.permissions : [];
    return {
        sectionUnreadable: false,
        rules: actions.map((action) => {
            const matching = rules.filter(isRuleRecord).filter((rule) => rule.action === action);
            const askResidue = matching.some((rule) => rule.resource === PERMISSION_RULE_RESOURCE && rule.effect === 'ask');
            // A deny anywhere on the action is a bricked call, whether or not a
            // later allow row currently shadows it for some resources.
            if (matching.some((rule) => rule.effect === 'deny'))
                return { action, state: 'deny', askResidue };
            const exact = matching.filter((rule) => rule.resource === PERMISSION_RULE_RESOURCE);
            const last = exact.at(-1);
            if (last === undefined) {
                return { action, state: matching.length > 0 ? 'user-other' : 'absent', askResidue };
            }
            if (last.effect === 'allow')
                return { action, state: 'allow', askResidue };
            if (last.effect === 'ask')
                return { action, state: 'ask', askResidue };
            return { action, state: 'foreign', askResidue };
        }),
    };
}
export function readPermissionRulesV1(config, actions = allowRuleActions()) {
    if (config.permission !== undefined && !isRuleRecord(config.permission)) {
        return {
            sectionUnreadable: true,
            rules: actions.map((action) => ({ action, state: 'foreign', askResidue: false })),
        };
    }
    const permission = asRecord(config.permission);
    return {
        sectionUnreadable: false,
        rules: actions.map((action) => {
            const value = permission[action];
            if (value === undefined)
                return { action, state: 'absent', askResidue: false };
            if (value === 'allow')
                return { action, state: 'allow', askResidue: false };
            if (value === 'ask')
                return { action, state: 'ask', askResidue: true };
            if (value === 'deny')
                return { action, state: 'deny', askResidue: false };
            // A pattern map (or any other value) is not a single-effect posture;
            // the installer never writes one, so it is unverifiable, never ours.
            return { action, state: 'foreign', askResidue: false };
        }),
    };
}
// Floor check for the probe result: the `permissions` array is the documented
// V2 shape, measured on 2.2.7 only. Opencode major >= 2 (the anchored
// `v<major>.` form, mirroring opencodeSeamVersionSupported's
// extract-not-pass-raw polarity); null and unparsable output are unsupported
// — the caller's polarity is skip, keeping BOTH the terminal token gate and
// its mcp env untouched rather than guessing.
export function opencodeAskRuleVersionSupported(version) {
    return askRuleShapeFor(version) === 'v2-array';
}
export function askRuleShapeFor(version) {
    if (version === null)
        return 'unsupported';
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!match)
        return 'unsupported';
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major >= 2)
        return 'v2-array';
    if (major === 1 && minor >= 19)
        return 'v1-object';
    return 'unsupported';
}
