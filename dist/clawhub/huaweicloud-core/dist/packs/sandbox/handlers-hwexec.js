import { execOneShot, getCurrentWorkspaceId } from "../../sandbox/session-manager.js";
import { SANDBOX_TIMEOUT_MS } from "./schemas.js";
import { HWEXEC_TAIL_BYTES_DEFAULT, buildHwexecPollScript, buildHwexecStartScript, classifyHwexecStartOutput, deriveHwexecVerdict, generateHwexecTaskId, hwexecTaskDir, parseHwexecPollOutput, resolveHwexecPollTimeoutMs, validateHwexecTailBytes, validateHwexecTaskId, validateHwexecWaitMs, } from "../../sandbox/hwexec-task.js";
let oneShotForTests = null;
export function _setOneShotForTests(fn) {
    oneShotForTests = fn;
}
async function runOneShot(workspaceId, command, username, timeoutMs) {
    return (oneShotForTests ?? execOneShot)(workspaceId, command, username, timeoutMs);
}
// The client's advisory task memory (process lifetime — an agent restart
// forgets it by design). Poll correctness NEVER depends on it: it only
// separates lost (this process remembers the task, the directory is gone →
// the sandbox rebooted) from unknown (no memory of it), and enriches the
// poll receipt with firstStartedAt. The durable half is the caller's own
// task_id knowledge.
const hwexecTaskMemory = new Map();
function rememberHwexecTask(taskId, workspaceId, username) {
    hwexecTaskMemory.set(taskId, { workspaceId, username, startedAt: new Date().toISOString() });
}
// The ws-exec timeout path (hwlink-exec-session.ts) throws its
// WebSocketExecError with exitCode 124 — both the ready-phase and the
// exec-phase timeout. Duck-typed: the number is the contract.
function isHwexecExecTimeout(error) {
    return error instanceof Error && error.exitCode === 124;
}
// One poll of the task's current verdict, shared by the poll tool and the
// dup receipt (wait 0 — a snapshot, never a wait).
async function pollHwexecVerdict(taskId, workspaceId, username) {
    const script = buildHwexecPollScript(taskId, 0, HWEXEC_TAIL_BYTES_DEFAULT);
    const result = await runOneShot(workspaceId, script, username, resolveHwexecPollTimeoutMs(0, SANDBOX_TIMEOUT_MS.exec_poll));
    return deriveHwexecVerdict(parseHwexecPollOutput(result.stdout), hwexecTaskMemory.has(taskId));
}
// The async branch of huaweicloud_sandbox_exec_one_shot: validate (or
// generate) the task id, build the claim-protocol start script, run it as
// one short exec, and fold the output (or a timeout) into the receipt.
export async function startHwexecTask(args, workspaceId, username) {
    const taskId = args.task_id ? validateHwexecTaskId(args.task_id) : generateHwexecTaskId();
    const taskDir = hwexecTaskDir(taskId);
    const script = buildHwexecStartScript(taskId, String(args.command ?? ''));
    const timeoutMs = args.timeout_ms || SANDBOX_TIMEOUT_MS.exec_one_shot_async;
    let stdout;
    try {
        const result = await runOneShot(workspaceId, script, username, timeoutMs);
        stdout = result.stdout;
    }
    catch (error) {
        if (!isHwexecExecTimeout(error))
            throw error;
        rememberHwexecTask(taskId, workspaceId, username);
        return {
            started: 'uncertain',
            taskId,
            taskDir,
            hint: 'The start exec timed out — the claim may already be placed. Retry with the SAME task_id: the claim file structurally prevents a second copy from ever spawning. If the retry returns started:"dup" with verdict "never", start over with a NEW task_id.',
        };
    }
    const outcome = classifyHwexecStartOutput(stdout, taskId);
    if (outcome === 'claim_error') {
        return {
            started: false,
            ok: false,
            taskId,
            taskDir,
            error: 'The task claim failed (the task directory could not be created, or the claim file could not be claimed) — the command was not started.',
            hint: 'Check the sandbox /tmp state and retry; a stale /tmp/.hwexec directory with wrong permissions is the usual cause.',
        };
    }
    rememberHwexecTask(taskId, workspaceId, username);
    if (outcome === 'started') {
        return {
            started: true,
            taskId,
            taskDir,
            hint: 'The task is claimed and the command is spawning detached. Poll with huaweicloud_sandbox_exec_poll (task_id, wait_ms up to 60000) until the verdict is done.',
        };
    }
    // outcome === 'dup': the claim already existed. The receipt carries the
    // current verdict — a done verdict hands the result over immediately; a
    // never verdict is the claim protocol's trade teaching a NEW task_id.
    let verdict = { verdict: 'unknown' };
    try {
        verdict = await pollHwexecVerdict(taskId, workspaceId, username);
    }
    catch {
        // The dup fact is already certain; a failed verdict poll degrades to
        // 'unknown' — the caller can poll again with the tool directly.
    }
    return {
        started: 'dup',
        taskId,
        taskDir,
        verdict: verdict.verdict,
        exitCode: verdict.verdict === 'done' ? verdict.exitCode : undefined,
        logTail: 'logTail' in verdict ? verdict.logTail : undefined,
        hint: verdict.verdict === 'never'
            ? 'The task was claimed but never launched (the start exec died between claim and spawn). Start over with a NEW task_id — a same-id retry can never spawn.'
            : undefined,
    };
}
const HWEXEC_VERDICT_HINTS = {
    done: 'The command finished: exitCode is the command\u2019s exit status, logTail its captured stdout+stderr.',
    running: 'Still running — poll again; pass wait_ms (up to 60000) to wait inside the poll.',
    lost: 'The task is unrecoverable: the wrapper died without writing an exit status, or the task directory vanished (a sandbox reboot) while this process remembered the task. Restart the command with a NEW task_id if it still needs to run.',
    never: 'The task was claimed but never launched (the start exec died between claim and spawn). Start over with a NEW task_id — a same-id retry can never spawn.',
    unknown: 'No task directory and this process has no memory of this task_id — it never started here, or both the sandbox and this agent restarted since. Start the command with a NEW task_id.',
};
// huaweicloud_sandbox_exec_poll: run the bounded-wait poll script once and
// return the parsed verdict — never raw stdout. The exec timeout folds to
// wait_ms + 15s so the bounded wait always fits inside it.
export async function handleHwexecPoll(args = {}, _opts = {}) {
    const workspaceId = args.workspace_id || getCurrentWorkspaceId();
    if (!workspaceId) {
        throw new Error('workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
            'or set HW_WORKSPACE_ID environment variable, before polling an async task.');
    }
    const username = args.username || 'root';
    const taskId = validateHwexecTaskId(args.task_id);
    const waitMs = validateHwexecWaitMs(args.wait_ms);
    const tailBytes = validateHwexecTailBytes(args.tail_bytes);
    const script = buildHwexecPollScript(taskId, waitMs, tailBytes);
    const timeoutMs = resolveHwexecPollTimeoutMs(waitMs, args.timeout_ms || SANDBOX_TIMEOUT_MS.exec_poll);
    const result = await runOneShot(workspaceId, script, username, timeoutMs);
    const facts = parseHwexecPollOutput(result.stdout);
    const memory = hwexecTaskMemory.get(taskId);
    const verdict = deriveHwexecVerdict(facts, memory !== undefined);
    return {
        taskId,
        taskDir: hwexecTaskDir(taskId),
        verdict: verdict.verdict,
        exitCode: verdict.verdict === 'done' ? verdict.exitCode : undefined,
        logTail: 'logTail' in verdict ? verdict.logTail : undefined,
        firstStartedAt: memory?.startedAt,
        hint: HWEXEC_VERDICT_HINTS[verdict.verdict],
    };
}
