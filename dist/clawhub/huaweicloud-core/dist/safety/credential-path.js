import { asText } from "../lib/as-text.js";
import { DEFAULT_POLICY } from "./default-policy.js";
import { matchesAny } from "./policy.js";
import { stripShellQuotes } from "./shell-text.js";
// Credential-file path gate for non-Bash faces: the MCP `secret_set`
// channel=file reads a path directly, with no hook between the request and
// the read — the Bash-face credentialFilePatterns deny must apply there
// too, or the tool launders a hook-denied credential file into the vault.
// Tests the raw path AND its quote-stripped shadow (same evasion class as
// the text gate).
function normalizePathText(value) {
    return value.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
}
export function credentialFileCandidates(text) {
    const shadow = stripShellQuotes(text);
    return [text, shadow, normalizePathText(text), normalizePathText(shadow)];
}
export function isCredentialFilePath(path, policy = DEFAULT_POLICY) {
    const value = asText(path || '');
    if (!value)
        return false;
    return credentialFileCandidates(value).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns));
}
