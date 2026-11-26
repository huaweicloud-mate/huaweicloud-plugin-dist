import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDepLock } from "../../dep/receipts.js";
import { clearCustodyCache, defaultSecretsRoot, ensureMasterKey, resolveMasterKey } from "./custody.js";
import { formatSecretRef, isValidNameSegment, isValidScopeSegment, parseSecretRef, VaultError, } from "./refs.js";
import { asRecord } from "../as-record.js";
export { VaultError };
const FORMAT_VERSION = 1;
function rootOf(options) {
    return options?.root ?? defaultSecretsRoot();
}
function scopeDir(root, scope) {
    return join(root, scope);
}
function secretFile(root, ref) {
    return join(scopeDir(root, ref.scope), `${ref.name}.json`);
}
function fingerprintOf(masterKey, value) {
    return createHmac('sha256', masterKey).update(value, 'utf8').digest('hex').slice(0, 16);
}
function encrypt(masterKey, ref, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from(formatSecretRef(ref), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}
function decrypt(masterKey, ref, record) {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(formatSecretRef(ref), 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    try {
        return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    }
    catch {
        throw new VaultError('VAULT_DECRYPT_FAILED', `Decrypting ${formatSecretRef(ref)} failed: the master key does not match the one this secret was encrypted with (rotated custody tier?), or the file was tampered with. Version ${record.version}.`);
    }
}
function readRecord(path) {
    if (!existsSync(path))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        // A delete racing this read surfaces as ENOENT — that is a missing
        // secret, not corruption; the boundary error shape stays consistent.
        if (error.code === 'ENOENT')
            return null;
        throw new VaultError('VAULT_RECORD_CORRUPT', `${path} is not valid JSON. Restore or delete it, then re-create the secret.`);
    }
    const raw = asRecord(parsed);
    if (raw.format !== FORMAT_VERSION) {
        throw new VaultError('VAULT_FORMAT_UNKNOWN', `${path} has store format ${String(raw.format)}; this devkit understands format ${FORMAT_VERSION}. Upgrade the devkit (npx huaweicloud-devkit@latest) and retry.`);
    }
    const str = (key) => (typeof raw[key] === 'string' ? raw[key] : null);
    const version = typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : null;
    // ciphertext is a presence check, NOT truthiness: encrypting '' yields an
    // empty string, and a truthiness check here would misread the record as
    // corrupt (bricking list/get/rotate for the whole vault). The other
    // fields are never empty in a record this store writes.
    const requiredNonEmpty = ['created', 'updated', 'fingerprint', 'iv', 'tag'];
    for (const key of requiredNonEmpty) {
        if (!str(key)) {
            throw new VaultError('VAULT_RECORD_CORRUPT', `${path} is missing the ${key} field. Restore or delete it, then re-create the secret.`);
        }
    }
    if (str('ciphertext') === null) {
        throw new VaultError('VAULT_RECORD_CORRUPT', `${path} is missing the ciphertext field. Restore or delete it, then re-create the secret.`);
    }
    if (version === null) {
        throw new VaultError('VAULT_RECORD_CORRUPT', `${path} has an invalid version field. Restore or delete it, then re-create the secret.`);
    }
    return {
        format: FORMAT_VERSION,
        version,
        created: str('created'),
        updated: str('updated'),
        note: str('note') || '',
        fingerprint: str('fingerprint'),
        iv: str('iv'),
        tag: str('tag'),
        ciphertext: str('ciphertext'),
    };
}
function writeRecord(root, ref, record) {
    const dir = scopeDir(root, ref.scope);
    mkdirSync(dir, { recursive: true });
    const file = secretFile(root, ref);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
}
function masterKeyForRead(options) {
    const resolved = resolveMasterKey(options);
    if (!resolved) {
        throw new VaultError('VAULT_NOT_INITIALIZED', 'The secret vault has no master key. Create one by storing the first secret (npx huaweicloud-devkit secret set secret://<scope>/<name> --file <path>) or set HW_VAULT_MASTER_KEY.');
    }
    return resolved.key;
}
export function vaultSet(refInput, plaintext, note, options) {
    const ref = parseSecretRef(refInput);
    if (!ref)
        throw new VaultError('VAULT_BAD_REF', `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`);
    // The shared boundary for both faces (CLI and MCP): an empty plaintext is
    // far more likely a botched delivery than a deliberate value, and storing
    // it would silently destroy the previous secret. The message stays
    // channel-agnostic — the CLI and MCP faces name their own channels.
    if (plaintext === '') {
        throw new VaultError('VAULT_EMPTY_SECRET', `refusing to store an empty secret for ${refInput} — the delivered value was empty; check the delivery channel (a trailing newline is stripped).`);
    }
    const root = rootOf(options);
    const master = ensureMasterKey(options);
    return withDepLock(() => {
        const now = new Date().toISOString();
        const existing = readRecord(secretFile(root, ref));
        const fingerprint = fingerprintOf(master.key, plaintext);
        if (existing && existing.fingerprint === fingerprint) {
            return { status: 'unchanged', version: existing.version, fingerprint };
        }
        // Overwrite guard: an existing record that does not DECRYPT under the
        // current master key means the key changed since it was written (stray
        // HW_VAULT_MASTER_KEY, recovered-but-different keychain). Overwriting
        // would destroy the last copy under the original key — there is no
        // version history. The custody bootstrap already refuses to mint a key
        // over records; this closes the different-but-resolvable-key shape.
        if (existing) {
            try {
                decrypt(master.key, ref, existing);
            }
            catch {
                throw new VaultError('VAULT_MASTER_KEY_MISMATCH', `The existing record for ${refInput} does not decrypt under the current master key; refusing to overwrite (that would destroy the previous value). Restore the original key, or run "npx huaweicloud-devkit secret rm ${refInput}" first if the old value is truly gone.`);
            }
        }
        const encrypted = encrypt(master.key, ref, plaintext);
        const record = {
            format: FORMAT_VERSION,
            version: (existing?.version ?? 0) + 1,
            created: existing?.created ?? now,
            updated: now,
            note: note ?? existing?.note ?? '',
            fingerprint,
            ...encrypted,
        };
        writeRecord(root, ref, record);
        return { status: 'set', version: record.version, fingerprint };
    }, root);
}
export function vaultGet(refInput, options) {
    const ref = parseSecretRef(refInput);
    if (!ref)
        throw new VaultError('VAULT_BAD_REF', `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`);
    const root = rootOf(options);
    const masterKey = masterKeyForRead(options ?? {});
    const record = readRecord(secretFile(root, ref));
    if (!record) {
        throw new VaultError('VAULT_REF_NOT_FOUND', `${formatSecretRef(ref)} is not stored in the vault. Store it first: npx huaweicloud-devkit secret set ${formatSecretRef(ref)} --file <path>.`);
    }
    return { value: decrypt(masterKey, ref, record), version: record.version, note: record.note };
}
export function vaultDelete(refInput, options) {
    const ref = parseSecretRef(refInput);
    if (!ref)
        throw new VaultError('VAULT_BAD_REF', `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`);
    const root = rootOf(options);
    return withDepLock(() => {
        const file = secretFile(root, ref);
        if (!existsSync(file))
            return { removed: 0 };
        rmSync(file, { force: true });
        return { removed: 1 };
    }, root);
}
export function vaultList(scope, options) {
    const root = rootOf(options);
    if (scope !== undefined && !isValidScopeSegment(scope)) {
        throw new VaultError('VAULT_BAD_SCOPE', `"${String(scope)}" is not a valid scope (segments [a-z0-9-]).`);
    }
    const scopes = [];
    if (scope === undefined) {
        if (!existsSync(root))
            return [];
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            if (isValidScopeSegment(entry.name))
                scopes.push(entry.name);
        }
        scopes.sort((a, b) => a.localeCompare(b));
    }
    else {
        scopes.push(scope);
    }
    const out = [];
    for (const scopeName of scopes) {
        const dir = scopeDir(root, scopeName);
        if (!existsSync(dir))
            continue;
        for (const entry of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
            if (!entry.endsWith('.json') || !isValidNameSegment(entry.slice(0, -'.json'.length)))
                continue;
            const name = entry.slice(0, -'.json'.length);
            const record = readRecord(join(dir, entry));
            if (!record)
                continue;
            out.push({
                ref: `secret://${scopeName}/${name}`,
                scope: scopeName,
                name,
                version: record.version,
                updated: record.updated,
                note: record.note,
                fingerprint: record.fingerprint,
            });
        }
    }
    return out;
}
// Resolve a value that may be a secret ref; plain strings pass through.
// The seam every credential consumer goes through so no raw `secret://`
// string propagates into KooCLI/OBS config or fingerprints.
export function resolveSecretValue(value, options) {
    if (value === undefined)
        return undefined;
    const ref = parseSecretRef(value);
    if (!ref)
        return value;
    return vaultGet(formatSecretRef(ref), options).value;
}
export { clearCustodyCache };
