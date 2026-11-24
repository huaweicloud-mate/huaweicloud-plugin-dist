import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from "../safety-policy.js";
import { redactWithSupplementalKeys } from "./supplemental-redaction.js";
import { ensureMasterKey, resolveMasterKey } from "./secret-vault/custody.js";
import { devkitStateBase } from "./pack-state.js";
const APPROVAL_TTL_MS = 5 * 60_000;
function approvalFilePath() {
    return join(devkitStateBase(), 'approvals.json');
}
function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
// Canonical JSON for token hashes: recursively sort object keys so agent
// re-serialization cannot change the hash of the same logical value.
// Arrays keep their order (order is semantic); undefined-valued keys are
// dropped by JSON.stringify exactly as before, on both sides of the hash.
// The target object is null-prototype: a plain object literal invokes the
// prototype setter for '__proto__', silently dropping the key from own
// properties and from the hash — a replay smuggling a different nested
// __proto__ (JSON.parse makes it an own property) hashed identically to
// the approved form (round-5 probe). On a null-prototype target, plain
// assignment creates an own property for every key, so the hash sees
// exactly what the wire sees. The seen-set bounds recursion on circular
// input (unreachable past the JSON boundary, reachable from direct
// callTool callers) — hash must never reject, only hash.
// The seen-set is a RECURSION PATH (add before recursing, delete after),
// not a global visited set: a DAG (the same object referenced twice, never
// circular) serializes structurally with it, while a visited-set collapsed
// the second reference to null — making {a:X,b:X} and {a:X,b:null} hash
// identically for direct callTool callers (round-7 probe). True cycles
// still terminate: the cycle edge revisits an ancestor and reads null.
function canonicalize(value, seen = new Set()) {
    if (Array.isArray(value)) {
        // Arrays join the recursion path too: a self-referential array
        // recursed unboundedly through the map before the object guard ever
        // saw it (round-8 probe: RangeError), violating the module's own
        // "hash never rejects" contract.
        if (seen.has(value))
            return null;
        seen.add(value);
        try {
            return value.map((item) => canonicalize(item, seen));
        }
        finally {
            seen.delete(value);
        }
    }
    if (value !== null && typeof value === 'object') {
        if (seen.has(value))
            return null;
        seen.add(value);
        try {
            const source = value;
            const sorted = Object.create(null);
            // Code-unit comparison, the default sort's exact semantics made explicit.
            for (const key of Object.keys(source).sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))) {
                sorted[key] = canonicalize(source[key], seen);
            }
            return sorted;
        }
        finally {
            seen.delete(value);
        }
    }
    return value;
}
export function hashArgs(args) {
    return sha256Hex(JSON.stringify(canonicalize(args)));
}
function readApprovals() {
    try {
        const path = approvalFilePath();
        if (!existsSync(path))
            return {};
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const result = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            const entry = value;
            if (typeof entry.consumedAt === 'number' && typeof entry.createdAt === 'number') {
                // Tombstone (D4-24): consumed, kept for already_processed classification.
                result[key] = { consumedAt: entry.consumedAt, createdAt: entry.createdAt };
                continue;
            }
            if (typeof entry.argsHash !== 'string' || typeof entry.createdAt !== 'number')
                continue;
            result[key] = {
                argsHash: entry.argsHash,
                argsRedacted: entry.argsRedacted,
                createdAt: entry.createdAt,
                ...(entry.secretsSubstitutable === true ? { secretsSubstitutable: true } : {}),
                ...(entry.argsPinView !== undefined ? { argsPinView: entry.argsPinView } : {}),
                ...(isApprovalEntryState(entry.state) ? { state: entry.state } : {}),
                ...(isConfirmGrant(entry.confirmGrant)
                    ? { confirmGrant: { confirmedAt: entry.confirmGrant.confirmedAt, mac: entry.confirmGrant.mac } }
                    : {}),
            };
        }
        return result;
    }
    catch {
        return {};
    }
}
// The store is untrusted input: a malformed field reads as absent, never as
// a value. A wrong-typed state or grant therefore degrades to the legacy
// entry shape (awaiting_user, no grant), which every consumer fails closed on.
function isApprovalEntryState(value) {
    return value === 'awaiting_user' || value === 'user_confirmed';
}
function isConfirmGrant(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const grant = value;
    return typeof grant.confirmedAt === 'number' && typeof grant.mac === 'string';
}
function writeApprovals(map) {
    try {
        const path = approvalFilePath();
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
    }
    catch {
        // Best-effort: an in-file failure degrades cross-process persistence but a
        // token created/consumed within one process still works.
    }
}
function pruneStale(map, now = Date.now()) {
    let changed = false;
    for (const [key, value] of Object.entries(map)) {
        if (now - value.createdAt > APPROVAL_TTL_MS) {
            delete map[key];
            changed = true;
        }
    }
    return changed;
}
function consumedMarkerDir() {
    return join(devkitStateBase(), 'approvals-consumed');
}
// Exclusive-create claim on a token: 'wx' maps to O_EXCL|O_CREAT, so the
// first consumer wins atomically and every replay sees EEXIST. Claimed
// only AFTER the entry is confirmed present and valid, so bogus or expired
// tokens never create marker files. Any non-EEXIST failure (read-only
// home) returns true — degradation to file-only single-use, which is no
// worse than the pre-marker state.
function claimSingleUse(token) {
    try {
        mkdirSync(consumedMarkerDir(), { recursive: true, mode: 0o700 });
        writeFileSync(join(consumedMarkerDir(), `${token}.claimed`), '', { flag: 'wx', mode: 0o600 });
        return true;
    }
    catch (error) {
        return error.code !== 'EEXIST';
    }
}
// Markers outlive their tokens only briefly: prune ones older than 4x the
// TTL, long past any window in which the token could still validate.
function pruneConsumedMarkers(now = Date.now()) {
    try {
        const dir = consumedMarkerDir();
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            try {
                if (now - statSync(path).mtimeMs > APPROVAL_TTL_MS * 4)
                    unlinkSync(path);
            }
            catch {
                // raced away between readdir and stat/unlink; harmless
            }
        }
    }
    catch {
        // dir absent or unreadable: nothing to prune
    }
}
export function createApprovalToken(rawArgs, opts = {}) {
    const token = randomUUID();
    const map = readApprovals();
    map[token] = {
        argsHash: hashArgs(rawArgs),
        // The same supplemental-key pass the trace face and the gate's pin views
        // run (lib/supplemental-redaction.ts): redactSecrets alone lets a
        // long-lived key under api_key ride the store entry and the approve
        // CLI's Confirming line in plaintext (interrogate round 2, F2).
        argsRedacted: redactWithSupplementalKeys(redactSecrets(rawArgs)),
        createdAt: Date.now(),
        ...(opts.secretsSubstitutable === true ? { secretsSubstitutable: true } : {}),
        ...(opts.argsPinView !== undefined ? { argsPinView: opts.argsPinView } : {}),
        state: 'awaiting_user',
    };
    pruneStale(map);
    pruneConsumedMarkers();
    writeApprovals(map);
    return token;
}
// Tokens are minted by randomUUID(); anything else is agent noise. The
// shape check runs before ANY filesystem effect: the token string once
// reached join() unsanitized, so a '..'-bearing "token" could write
// marker files outside the marker directory.
const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isTombstone(entry) {
    return entry.consumedAt !== undefined;
}
// Inspect a token's lifecycle state WITHOUT consuming it. Used by
// runApprovedCommand to decide between the 'expired' / 'already_consumed'
// / 'not_found' JSON shapes (D4-24, #745). Aged-but-unpruned tombstones read
// as not_found — the same answer the next mint's prune would give, so the
// classification is time-consistent across the TTL boundary instead of
// depending on unrelated mints.
export function inspectApprovalToken(token) {
    if (!TOKEN_SHAPE.test(token))
        return { state: 'not_found' };
    const entry = readApprovals()[token];
    if (!entry)
        return { state: 'not_found' };
    if (isTombstone(entry)) {
        return Date.now() - entry.createdAt > APPROVAL_TTL_MS ? { state: 'not_found' } : { state: 'already_consumed' };
    }
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS)
        return { state: 'expired' };
    return { state: 'valid', entry };
}
export function consumeApprovalToken(token, opts = {}) {
    if (!TOKEN_SHAPE.test(token))
        return { status: 'gone' };
    const map = readApprovals();
    const entry = map[token];
    if (!entry || isTombstone(entry))
        return { status: 'gone' };
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
        delete map[token];
        writeApprovals(map);
        return { status: 'gone' };
    }
    // The confirmation gate rides INSIDE the consume cycle, on THIS freshly
    // read snapshot: state and grant are verified on the same entry the
    // execution will consume, before any marker claim and before any
    // tombstone write — the ApprovalSafety Run step is one atomic read over
    // the entry, by construction. A gate that read a different snapshot than
    // the one execution consumed was the TOCTOU the adversarial review
    // reproduced.
    if (opts.requireGrant) {
        const grant = verifyConfirmationGrant(entry, token);
        if (!grant.ok)
            return { status: 'grant_required', reason: grant.reason };
    }
    // Claim after validation: the marker exists only for tokens that were
    // real, unexpired, and (when required) grant-verified at read time. A
    // crash between claim and the tombstone-write below can burn a valid
    // token without spending it — fail-closed, rare, accepted.
    if (!claimSingleUse(token))
        return { status: 'gone' };
    // Tombstone instead of deleting outright (D4-24): a repeat call is
    // already_processed, not not_found.
    map[token] = { consumedAt: Date.now(), createdAt: entry.createdAt };
    writeApprovals(map);
    return { status: 'consumed', entry };
}
// The grant mac's domain separator: custody-keyed material from one HMAC use
// never verifies in another (the approval PIN has its own domain), and the
// mac binds the token, the confirmation time, and the FULL execution-gating
// shape of the entry — a same-user edit of any field the run gate trusts
// (argsHash, argsPinView, argsRedacted, secretsSubstitutable, createdAt)
// breaks verification, not just an argsHash swap.
const GRANT_MAC_DOMAIN = 'huaweicloud-approval-grant';
// The reusable custody-HMAC grant primitive: the evidence stamp shared by
// every confirmation channel (terminal today; elicitation and memo stamps
// in the later approval-chain PRs, each under its own domain). Custody
// material from one domain never verifies in another, so a grant proves
// both WHO confirmed (possession of the custody key) and WHAT they
// confirmed (the subject) and WHEN (the timestamp rides the message).
export function custodyGrantMac(masterKey, domain, subject, confirmedAt) {
    return createHmac('sha256', masterKey)
        .update(`${domain}\x00${subject}\x00${String(confirmedAt)}`)
        .digest('hex');
}
// The shape digests through hashArgs (the module's canonical-JSON machinery),
// so the confirm side and the verify side agree no matter how the store was
// re-serialized between them. undefined-valued keys drop on both sides.
// createdAt is covered so an attacker extending it cannot lengthen the
// 5-minute window on an old confirmation.
function grantMac(masterKey, token, entry, confirmedAt) {
    const shapeDigest = hashArgs({
        argsHash: entry.argsHash,
        argsPinView: entry.argsPinView,
        argsRedacted: entry.argsRedacted,
        secretsSubstitutable: entry.secretsSubstitutable,
        createdAt: entry.createdAt,
    });
    return custodyGrantMac(masterKey, GRANT_MAC_DOMAIN, `${token}\x00${shapeDigest}`, confirmedAt);
}
export function confirmApprovalToken(token) {
    if (!TOKEN_SHAPE.test(token))
        return { status: 'not_found' };
    const map = readApprovals();
    const entry = map[token];
    if (!entry)
        return { status: 'not_found' };
    if (isTombstone(entry)) {
        return Date.now() - entry.createdAt > APPROVAL_TTL_MS ? { status: 'not_found' } : { status: 'already_consumed' };
    }
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS)
        return { status: 'expired' };
    // No rewrite on an already-confirmed entry, even one whose grant a hand
    // edit mangled: re-minting would upgrade a forged state string to a real
    // grant the forger cannot make. verifyConfirmationGrant keeps rejecting it.
    if (entry.state === 'user_confirmed')
        return { status: 'already_confirmed' };
    let master;
    try {
        // Mutating path, so bootstrap semantics match `secret set`: the first
        // confirm on a keyless machine creates the custody key.
        master = ensureMasterKey();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'custody_unavailable', reason: `vault master key unavailable: ${message}` };
    }
    const confirmedAt = Date.now();
    const grant = {
        confirmedAt,
        mac: grantMac(master.key, token, entry, confirmedAt),
    };
    // The spread is safe because readApprovals rebuilds entries through the
    // whitelist: unknown fields planted in the file never reach this object.
    map[token] = { ...entry, state: 'user_confirmed', confirmGrant: grant };
    writeApprovals(map);
    return { status: 'confirmed' };
}
export function resolveVerificationMasterKey() {
    try {
        const master = resolveMasterKey();
        if (!master)
            return { failure: 'vault master key unavailable' };
        return { key: master.key };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { failure: `vault master key unreadable: ${message}` };
    }
}
export function verifyConfirmationGrant(entry, token) {
    if (entry.state !== 'user_confirmed') {
        return { ok: false, reason: 'token is awaiting user confirmation' };
    }
    const grant = entry.confirmGrant;
    if (!isConfirmGrant(grant)) {
        return { ok: false, reason: 'confirmation grant is missing or malformed' };
    }
    const master = resolveVerificationMasterKey();
    if ('failure' in master)
        return { ok: false, reason: master.failure };
    if (!/^[0-9a-f]{64}$/.test(grant.mac)) {
        return { ok: false, reason: 'confirmation grant mac is malformed' };
    }
    const expected = grantMac(master.key, token, entry, grant.confirmedAt);
    const matches = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(grant.mac, 'hex'));
    return matches ? { ok: true } : { ok: false, reason: 'confirmation grant does not verify' };
}
