import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeGlobalCredentials, writeObsConfig as writeObsConfigFile, setConfiguredBySession, backupGlobalCredentials, writeLastSync, globalCredentialsPath, readGlobalCredentials, } from "../auth/credentials.js";
import { fingerprint, runHcloudConfigure, runHcloudProfileDelete, resolveManagedProfile } from "../auth/reconcile.js";
import { resolveAndApplyProjectId } from "../auth/project-id.js";
import { clearUserHash } from "../telemetry/telemetry.js";
import { hdkitGenerateUserHash } from "./hdkit/hdkitservice-api.js";
import { asText } from "./as-text.js";
import { resolveSecretValue, vaultGet } from "./secret-vault/store.js";
import { formatSecretRef, parseSecretRef } from "./secret-vault/refs.js";
import { asRecord } from "./as-record.js";
export function asCredentialRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value;
    const result = {};
    if (typeof record.ak === 'string')
        result.ak = record.ak;
    if (typeof record.sk === 'string')
        result.sk = record.sk;
    if (typeof record.securityToken === 'string')
        result.securityToken = record.securityToken;
    if (typeof record.region === 'string')
        result.region = record.region;
    return result;
}
export const pendingConfirms = new Map();
// Tombstones for confirm tokens already consumed (D4-24, #745): a repeat
// huaweicloud_auth_confirm call classifies as already_processed instead of
// not_found. Kept in-memory only: confirm tokens are process-scoped — they
// never persist across processes (a new MCP server process knows no token),
// while every MCP session inside the SAME process can consume a token another
// session minted (the Map is not keyed by session; the seat-3 probe of the
// 2026-11-05 UX report pinned that).
export const consumedConfirms = new Map();
// The import channel's side-effect-free read. The approval gate resolves
// the channel BEFORE any consent, and a read that wipes the file on
// malformed content would mutate the user's state on the refusal path —
// so every reader peeks (a malformed file stays on disk,
// operator-visible), and only EXECUTION wipes (the switch handler's
// clearImportFile on non-replayable outcomes). The pre-PR-3b wiping read
// (readImportFile) is gone with its only consumer: the handler now
// resolves through the approval spec's snapshot, which peeks here.
export function peekImportFile() {
    const path = join(dirname(globalCredentialsPath()), 'creds-import.json');
    try {
        if (!existsSync(path))
            return null;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        const record = asRecord(data);
        return {
            ak: asText(record.ak || ''),
            sk: asText(record.sk || ''),
            securityToken: asText(record.securityToken || ''),
            region: asText(record.region || ''),
        };
    }
    catch {
        return null;
    }
}
export function clearImportFile() {
    const path = join(dirname(globalCredentialsPath()), 'creds-import.json');
    try {
        rmSync(path, { force: true });
    }
    catch {
        // best-effort: an absent or locked file is not an error
    }
}
// When S1 already holds a secret:// ref for a field and that ref resolves to
// the SAME value being persisted, keep the ref in the file instead of
// downgrading the representation to plaintext. The mirrors (S2/S3) still
// receive the resolved value; only S1's at-rest form is preserved. A ref
// that resolves differently (or fails to resolve) loses to the incoming
// plaintext — the caller's value is the new truth.
export function preserveRefForm(plaintext, rawStored) {
    if (typeof rawStored !== 'string')
        return plaintext;
    const ref = parseSecretRef(rawStored);
    if (!ref)
        return plaintext;
    try {
        if (vaultGet(formatSecretRef(ref)).value === plaintext)
            return rawStored;
    }
    catch {
        // Unresolvable: the strict read in auth_switch already surfaced this;
        // fall through to the plaintext write.
    }
    return plaintext;
}
export function persistCredentials(ak, sk, securityToken, region) {
    if (String(securityToken || '')) {
        return {
            status: 'error',
            error: 'Temporary STS credentials cannot be persisted (R3). Use action=temporary.',
            scope: 'rejected',
        };
    }
    // Incoming values may themselves be secret:// refs (auth_switch mode=
    // memory with refs, or a creds-import.json carrying them). Resolve them
    // BEFORE any fan-out: a literal ref string written into
    // ~/.obsutilconfig or a KooCLI profile breaks both mirrors. S1 keeps the
    // ref representation via preserveRefForm when the resolved value matches.
    const akValue = resolveSecretValue(ak) ?? ak;
    const skValue = resolveSecretValue(String(sk)) ?? String(sk);
    const before = backupGlobalCredentials();
    const rawStored = readGlobalCredentials();
    writeGlobalCredentials({
        ak: preserveRefForm(akValue, rawStored?.ak),
        sk: preserveRefForm(skValue, rawStored?.sk),
        securityToken: '',
        region,
        configuredBySession: true,
    });
    setConfiguredBySession(true);
    let obs;
    try {
        writeObsConfigFile({ ak: akValue, sk: skValue, securityToken, region });
        obs = { ok: true };
    }
    catch (error) {
        obs = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const profile = resolveManagedProfile();
    let project;
    let hcloud;
    if (!profile) {
        hcloud = { ok: false, reason: 'KooCLI current profile unresolved' };
    }
    else {
        // #920: `configure set` refuses an empty --cli-security-token, so a stale
        // token already in the profile survives the write and poisons every hcloud
        // call with APIGW.0301 — while the tool still reports "synchronized". When
        // persisting WITHOUT a token, walk the documented manual bypass (delete the
        // profile, then re-configure) so the on-disk profile truly matches the
        // incoming credentials. The delete is best-effort: a missing profile
        // ("nothing to clean") must not fail the persist.
        let profileReset = false;
        if (!String(securityToken || '')) {
            const deleted = runHcloudProfileDelete(profile);
            profileReset = deleted.ok || /not (exist|found)/i.test(deleted.error || '');
        }
        hcloud = { ...runHcloudConfigure(profile, akValue, skValue, region), profileReset };
    }
    if (hcloud.ok) {
        writeLastSync({ kooCliProfile: profile, s1Fingerprint: fingerprint(akValue, skValue) });
        // The delete/recreate purge above wiped EVERY profile setting — including
        // cli-project-id, which `configure set` (ak/sk/region only) never restores.
        // Without this re-application a routine AK/SK rotation breaks every
        // region-scoped hcloud call with APIGW.0301 while the persist still
        // reports ok. Best-effort: a failed resolution does not fail the persist,
        // but the result is SURFACED (not silently discarded) so callers can tell
        // a complete sync from a credentials-only one.
        project = resolveAndApplyProjectId({ region, profile: profile ?? undefined });
    }
    return {
        status: obs.ok && hcloud.ok ? 'ok' : 'partial',
        scope: 'persist',
        backedUp: Boolean(before),
        obs: obs.ok ? { configured: true } : { configured: false, error: obs.error },
        project,
        hcloud,
        note: 'S1 written with configuredBySession (R9), which now takes priority over env-injected credentials; S2(current profile) and S3 synced. Persisting without a security token resets the target profile first (delete + recreate) so a stale token cannot survive the write (#920). Note: running `auth init` later clears the configuredBySession flag and env credentials regain priority.',
    };
}
export function refreshUserHashAfterAuthChange({ regenerate = true } = {}) {
    clearUserHash();
    if (regenerate) {
        hdkitGenerateUserHash().catch(() => { });
    }
}
