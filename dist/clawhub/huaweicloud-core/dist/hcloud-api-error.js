// KooCLI child-output error extraction and MCP-safe redaction, extracted
// from the hcloud-cli monolith (the stable src/hcloud-cli.ts face
// re-exports these): the API-error JSON shapes (error_code/error_msg and
// the nested error object), the embedded error_code regex fallback, and
// the banner-strip + bracket-slice + JSON redaction pipeline every hcloud
// result surfaces through.
import { asRecord } from "./lib/as-record.js";
import { asString, asText } from "./lib/as-text.js";
import { redactSecrets } from "./safety-policy.js";
import { stripKooCliUpdateBanner } from "./koocli-version.js";
export function extractApiError(stdout) {
    let text = asText(stdout || '');
    // Strip KooCLI multi-version prefix lines (e.g. "ListVpcs有多个版本,默认使用该API版本v3…")
    const bracketIdx = text.indexOf('{');
    if (bracketIdx > 0)
        text = text.substring(bracketIdx);
    try {
        const parsed = JSON.parse(text);
        const record = asRecord(parsed);
        const errorCode = asString(record.error_code) ?? asString(record.errorCode);
        if (errorCode) {
            return {
                errorCode,
                errorMessage: asString(record.error_msg) ?? asString(record.errorMsg) ?? asString(record.message) ?? '',
            };
        }
        const errorValue = record.error;
        if (errorValue && typeof errorValue === 'object') {
            const errorRecord = asRecord(errorValue);
            return {
                errorCode: asString(errorRecord.code) ?? asString(errorRecord.error_code) ?? 'UNKNOWN',
                errorMessage: asString(errorRecord.message) ?? asString(errorRecord.error_msg) ?? '',
            };
        }
    }
    catch {
        // non-JSON stdout: fall through to the regex scan for an embedded error_code below
    }
    const ecMatch = text.match(/"error_code"\s*:\s*"([^"]+)"/);
    const emMatch = text.match(/"error_msg"\s*:\s*"([^"]+)"/);
    if (ecMatch) {
        return { errorCode: ecMatch[1], errorMessage: emMatch ? emMatch[1] : '' };
    }
    return null;
}
// A4 (#935): the KooCLI 7.2.x version-upgrade banner strip lives in
// koocli-version.ts (shared with the probe, which must not misparse the
// banner's target version as the installed one). redactOutput applies it to
// child-process output BEFORE the JSON bracket-slice; the only upgrade hint
// DevKit emits is check_cli/doctor's soft, one-shot mismatch hint —
// kooCliVersion in package.json stays the single source of truth, and
// check_cli/doctor keep their non-blocking semantics.
export function redactOutput(output) {
    let text = stripKooCliUpdateBanner(asText(output || ''));
    const bracketIdx = text.indexOf('{');
    if (bracketIdx > 0)
        text = text.substring(bracketIdx);
    try {
        return JSON.stringify(redactSecrets(JSON.parse(text)), null, 2);
    }
    catch {
        return redactSecrets(text);
    }
}
