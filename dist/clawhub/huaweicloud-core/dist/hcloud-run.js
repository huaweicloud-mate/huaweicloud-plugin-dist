// The hcloud run engine's retrying orchestrator, extracted from the
// hcloud-cli monolith (the stable src/hcloud-cli.ts face re-exports
// runHcloud and the run types): plan/assert gating, the expired-STS
// fail-fast, per-command STS argv injection, the retry loop with its
// network-error classification and the runtime-current mismatch warning,
// and the "Unsupported service" language annotation. The single-execution
// child supervisor lives in hcloud-run-once.ts.
import { assertAllowed } from "./safety-policy.js";
import { appendLangHint, UNSUPPORTED_SERVICE_RE } from "./hcloud-catalog.js";
import { isTemporaryStsExpired, resolveStsInjectArgs } from "./hcloud-sts.js";
import { planHcloudCommand, stripLeadingHcloudBinArgs } from "./hcloud-plan.js";
import { runHcloudOnce } from "./hcloud-run-once.js";
const DEFAULT_MAX_RETRIES = 1;
export async function runHcloud(args, options = {}) {
    const inputArgs = Array.isArray(args) ? args.map(String) : [];
    // Same seam as the plan face: rawArgs (what the child actually receives)
    // must be the effective args, so a leading bin token in the input can no
    // longer reach the spawn as a doubled `hcloud hcloud ...` prefix. The
    // warning for the stripped token comes from the plan this call builds.
    const { args: normalizedArgs } = stripLeadingHcloudBinArgs(inputArgs);
    // Run paths never mint approval tokens: only the plan face does, so a run
    // result can never hand the agent a fresh usable token for the next
    // execution.
    const plan = {
        ...planHcloudCommand(normalizedArgs, { ...options, mintApprovalToken: false }),
        rawArgs: normalizedArgs,
    };
    assertAllowed(plan.classification);
    // Fail fast when the platform-injected temporary STS is already expired —
    // otherwise hcloud would make a doomed IAM round trip and surface a
    // misleading error (e.g. "缺少 cli-domain-id"). Permanent AK/SK and
    // unknown-expiry tokens are never gated.
    if (isTemporaryStsExpired()) {
        return {
            ok: false,
            code: 'CREDENTIAL_EXPIRED',
            error: 'Temporary STS credentials have expired. Re-login or start a new session so the platform injects fresh credentials, then retry.',
            stderr: '',
            stdout: '',
            plan,
        };
    }
    // Link B: when the runtime/environment carries live temporary STS credentials
    // (security token set), KooCLI/obsutil would not see them (they read S2/S3 only
    // and R3 forbids writing them to disk). Inject per-command so hcloud actually
    // authenticates with the platform-provided STS. Injection args are appended to
    // the EXECUTED args only; classification/approval used the original args.
    const stsInject = resolveStsInjectArgs(normalizedArgs);
    if (stsInject.length > 0) {
        plan.rawArgs = [...plan.rawArgs, ...stsInject];
    }
    const metaDir = options.metaDir;
    // KooCLI only switches language globally (`hcloud configure set --cli-lang=cn`); there is no
    // per-command `--cli-lang` flag (it is rejected as "不正确的参数:cli-lang"). So we never mutate
    // the command — we run it as-is and annotate `Unsupported service` with an actionable cause.
    const result = await runHcloudOnceWithRetries(plan, options);
    const text = `${result.stderr || ''}\n${result.stdout || ''}`;
    const match = text.match(UNSUPPORTED_SERVICE_RE);
    if (match && !result.ok) {
        // UNSUPPORTED_SERVICE_RE's capture group always participates on a match.
        return appendLangHint(result, match[1], metaDir);
    }
    return result;
}
async function runHcloudOnceWithRetries(plan, options) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const result = await runHcloudOnce(plan, options);
        if (result.ok || attempt >= maxRetries || !isRetryableNetworkError(result)) {
            const merged = {
                ...result,
                retries: attempt,
                attempts: attempt + 1,
            };
            if (merged.ok) {
                const warning = await runtimeCurrentMismatchWarning();
                return warning ? { ...merged, authWarning: warning } : merged;
            }
            return merged;
        }
        await wait((options.retryBaseDelayMs ?? 500) * 2 ** attempt);
    }
    throw new Error('Unreachable retry state.');
}
async function runtimeCurrentMismatchWarning() {
    try {
        const { hasRuntimeCredentials, scanState } = await import("./auth/reconcile.js");
        if (!hasRuntimeCredentials())
            return null;
        const scan = scanState();
        const { runtimeFingerprint, currentFingerprint } = scan.stores;
        if (runtimeFingerprint && currentFingerprint && runtimeFingerprint !== currentFingerprint) {
            return '会话内临时账号与 KooCLI current 档不一致：hcloud 命令仍使用 current 档账号。如需对齐请用 huaweicloud_auth_switch action=persist。';
        }
        return null;
    }
    catch {
        // reconcile unavailable → no warning, never block the command
        return null;
    }
}
function isRetryableNetworkError(result) {
    if (result.code === 'TIMEOUT')
        return false;
    const text = `${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
    return /\[NETWORK_ERROR\]|connection timed out|ECONNRESET|ETIMEDOUT|temporary failure|TLS handshake timeout/i.test(text);
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
