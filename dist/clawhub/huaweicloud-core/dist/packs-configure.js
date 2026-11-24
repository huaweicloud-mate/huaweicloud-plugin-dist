import { resolveEnabledPacks, setRuntimePacksOverride, clearRuntimePacksOverride, runtimePacksOverride, } from "./packs/enable.js";
import { PACK_IDS } from "./lib/pack-types.js";
import { closePackEnablement } from "./lib/dependency-model.js";
import { hashArgs } from "./lib/approval-tokens.js";
import { redactSecrets } from "./safety-policy.js";
import { asString } from "./lib/as-text.js";
export function configurePacks(args, opts) {
    const enable = (args.enable ?? []).map((id) => String(id));
    const disable = (args.disable ?? []).map((id) => String(id));
    const reset = args.reset === true;
    if (!reset && enable.length === 0 && disable.length === 0) {
        return { ok: false, error: 'Provide at least one of enable, disable, or reset.' };
    }
    const bogus = [...enable, ...disable].filter((id) => !PACK_IDS.includes(id));
    if (bogus.length > 0) {
        return {
            ok: false,
            error: 'Unknown pack id(s): ' + bogus.join(', ') + '. Valid pack ids: ' + PACK_IDS.join(', ') + '.',
        };
    }
    if (disable.includes('core')) {
        return {
            ok: false,
            error: 'core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled.',
        };
    }
    const overlap = enable.filter((id) => disable.includes(id));
    if (overlap.length > 0) {
        return {
            ok: false,
            error: 'Pack id(s) cannot be both enabled and disabled in one call: ' + overlap.join(', ') + '.',
        };
    }
    if (!opts.onPacksChanged) {
        return {
            ok: false,
            error: 'Runtime pack configuration is available in stdio agent sessions only; this surface carries no session state.',
        };
    }
    const current = runtimePacksOverride();
    if (reset && (enable.length > 0 || disable.length > 0)) {
        return {
            ok: false,
            error: 'reset drops the whole session override and cannot be combined with enable or disable.',
        };
    }
    const currentEffective = resolveEnabledPacks();
    // Both lists were validated against PACK_IDS above, so the ids are PackId
    // at runtime; one narrowing here keeps the set math below typewise clean.
    const enableIds = enable;
    const disableIds = disable;
    const next = new Set(currentEffective);
    for (const id of disableIds)
        next.delete(id);
    for (const id of enableIds)
        next.add(id);
    const wouldEnable = closePackEnablement(next).enabled;
    const same = wouldEnable.size === currentEffective.size && [...currentEffective].every((id) => wouldEnable.has(id));
    let changed = false;
    if (reset) {
        if (current) {
            clearRuntimePacksOverride();
            changed = true;
        }
    }
    else if (!same) {
        setRuntimePacksOverride(PACK_IDS.filter((id) => next.has(id)).join(','));
        changed = true;
    }
    if (changed)
        opts.onPacksChanged();
    const effective = resolveEnabledPacks();
    return {
        ok: true,
        changed,
        override: runtimePacksOverride()?.raw ?? null,
        effectivePacks: PACK_IDS.filter((id) => effective.has(id)),
        note: changed
            ? 'Session override active. Restarting the session restores the operator DEVKIT_PACKS posture.'
            : reset
                ? 'No session override was active.'
                : 'The requested surface already applies.',
    };
}
// The packs_configure approval registration (PR-3c). ALWAYS gated, because
// widening the session's disclosure face is the actual consequence — an
// enabled pack materializes its tools and skills for every later call — and
// the summarize view names the exact ids so the confirmation surface shows
// the consequence itself. requiresSessionSeam mirrors this handler's own
// stdio-only refusal: the gate checks opts.onPacksChanged BEFORE engaging
// (the refusal lives here, downstream of any dispatch-layer gate), so a
// no-seam call refuses with no token minted and no ledger entry — the
// ordering the gate's precheck exists to enforce. The binding is the
// {enable, disable, reset} projection, never the gate fields.
export const PACKS_CONFIGURE_APPROVAL_SPEC = {
    domain: 'packs',
    flavor: 'always',
    tokenSource: 'gate',
    requiresSessionSeam: true,
    normalizeArgs: (args) => ({
        enable: args.enable,
        disable: args.disable,
        reset: args.reset,
    }),
    summarize: (value) => {
        // The view folds through the shared redaction vocabulary before any
        // field reaches the summary or pin view (the ApprovalSpec contract);
        // the hash binds the raw content.
        const safe = redactSecrets(value);
        const list = (ids) => Array.isArray(ids) ? ids.map((id) => String(id)).join(', ') : (asString(ids) ?? '');
        const parts = [];
        if (Array.isArray(safe.enable) && safe.enable.length > 0)
            parts.push(`enable pack(s) ${list(safe.enable)}`);
        if (Array.isArray(safe.disable) && safe.disable.length > 0)
            parts.push(`disable pack(s) ${list(safe.disable)}`);
        if (safe.reset === true)
            parts.push('reset the session override (restore the operator DEVKIT_PACKS posture)');
        if (parts.length === 0)
            parts.push('no-op: provide enable, disable, or reset');
        return {
            summary: `huaweicloud_packs_configure: ${parts.join('; ')}`,
            argsHash: hashArgs(value),
            pinView: safe,
        };
    },
    // NoDoomedToken (interrogate round 2, fix-in-pass i): the handler's own
    // five pure validations, hoisted BEFORE the mint — a shape the handler
    // refuses would burn the user's approval on a guaranteed refusal, so it
    // never mints. Message texts mirror the handler's exactly, so the two
    // layers can never drift into different teachings; the handler keeps its
    // own copies as the belt behind this floor.
    assertArgsExecutable: (value) => {
        const { enable, disable, reset } = value;
        const enableIds = Array.isArray(enable) ? enable.map((id) => String(id)) : [];
        const disableIds = Array.isArray(disable) ? disable.map((id) => String(id)) : [];
        const resetIs = reset === true;
        if (!resetIs && enableIds.length === 0 && disableIds.length === 0) {
            throw new Error('Provide at least one of enable, disable, or reset.');
        }
        const bogus = [...enableIds, ...disableIds].filter((id) => !PACK_IDS.includes(id));
        if (bogus.length > 0) {
            throw new Error('Unknown pack id(s): ' + bogus.join(', ') + '. Valid pack ids: ' + PACK_IDS.join(', ') + '.');
        }
        if (disableIds.includes('core')) {
            throw new Error('core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled.');
        }
        const overlap = enableIds.filter((id) => disableIds.includes(id));
        if (overlap.length > 0) {
            throw new Error('Pack id(s) cannot be both enabled and disabled in one call: ' + overlap.join(', ') + '.');
        }
        if (resetIs && (enableIds.length > 0 || disableIds.length > 0)) {
            throw new Error('reset drops the whole session override and cannot be combined with enable or disable.');
        }
    },
};
