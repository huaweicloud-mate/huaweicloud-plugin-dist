import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DEPENDENCIES } from "../../lib/dependency-model.js";
import { resolveDependencyCommand } from "../../lib/dep-resolve.js";
import { ensurePackState, packStateDir } from "../../lib/pack-state.js";
import { redactSecrets } from "../../safety-policy.js";
// Process-scope singleton for the huaweicloud-open-mcp sidecar.
//
// Ownership: the sidecar belongs to THIS PROCESS, never to an McpServer
// object. The remote transport constructs and closes a server per HTTP
// request (src/mcp-server-remote.ts), so any lifecycle hooked on server
// construction or close would kill the sidecar once per request. The
// registry imports every pack's handler modules unconditionally, so module
// scope must stay side-effect free: the child spawns lazily on the first
// tool call, which is also what keeps a DEVKIT_PACKS-trimmed server from
// ever spawning it — the tools are not registered, so no call arrives.
//
// Lifetime: the child's stdin is a pipe held by this process. When the
// parent dies the pipe closes and the child sees EOF on stdin — the same
// shutdown signal this devkit's own stdio transport uses — and exits. No
// detached flag, no pidfile.
//
// Protocol: hand-rolled newline-delimited JSON-RPC 2.0 client. Only
// dist/mcp-server.js may import the MCP SDK (esbuild bundles it there), so
// the sidecar speaks the wire protocol directly; initialize +
// notifications/initialized + tools/call is the full surface the proxy
// needs. A per-call timeout rejects the pending entry without killing the
// child: the gateway retries its own HTTP internally, and one slow call
// must not take the server down for the calls after it.
const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LIMIT = 4096;
const stats = { spawns: 0, lastPid: null };
class OpenMcpSidecar {
    child;
    nextId = 1;
    pending = new Map();
    // Named lineBuffer, not buffer: the unicorn no-unsafe-buffer-conversion
    // rule pattern-matches `<x>.buffer.slice(...)` as a TypedArray conversion.
    lineBuffer = '';
    stderrTail = '';
    alive = true;
    constructor(child) {
        this.child = child;
        if (!child.stdout || !child.stderr || !child.stdin)
            throw new Error('sidecar spawned without piped stdio');
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.onStdout(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
        });
        // A write landing in the window between the child's OS-level death and
        // Node's 'exit' delivery EPIPEs asynchronously on this socket; without a
        // listener that error is unhandled and takes down the whole server.
        // Routing it into onExit rejects the in-flight call fast instead.
        child.stdin.on('error', () => this.onExit('sidecar stdin write failed'));
        child.on('exit', () => this.onExit('sidecar process exited'));
        child.on('error', (error) => this.onExit(error.message));
    }
    onStdout(chunk) {
        this.lineBuffer += chunk;
        let newline = this.lineBuffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.lineBuffer.slice(0, newline).trim();
            this.lineBuffer = this.lineBuffer.slice(newline + 1);
            if (line)
                this.onLine(line);
            newline = this.lineBuffer.indexOf('\n');
        }
    }
    onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return; // non-JSON noise on stdout; the protocol is line-delimited JSON only
        }
        if (typeof message.id !== 'number')
            return; // server notification: nothing subscribed
        const entry = this.pending.get(message.id);
        if (!entry)
            return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error)
            entry.reject(new Error(message.error.message || 'open-mcp gateway error'));
        else
            entry.resolve(message.result);
    }
    onExit(reason) {
        if (!this.alive)
            return;
        this.alive = false;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`${reason}${this.stderrTail ? ` (stderr: ${this.stderrTail})` : ''}`));
        }
        this.pending.clear();
        // Only the current singleton's death clears it: a stale child (a
        // handshake-failure orphan being killed, or a reset victim exiting
        // late) must not drop a healthy replacement.
        if (currentSidecar === this) {
            currentSidecar = null;
            sidecarPromise = null;
        }
    }
    request(method, params, timeoutMs) {
        if (!this.alive) {
            // The caller holds a reference from before the child died; writing
            // would be silently dropped and burn the full timeout.
            return Promise.reject(new Error('open-mcp gateway sidecar is dead; the next call respawns it'));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`open-mcp gateway ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
    }
    notify(method) {
        if (!this.alive)
            return;
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    }
    // SIGTERM → SIGKILL escalation, the hcloud-cli.ts supervision pattern:
    // a child that ignores SIGTERM still dies, and the escalation timer is
    // cleared the moment the exit lands.
    kill() {
        if (!this.alive)
            return;
        this.child.kill('SIGTERM');
        const force = setTimeout(() => this.child.kill('SIGKILL'), 3000);
        this.child.once('exit', () => clearTimeout(force));
    }
    // kill() plus the bounded wait for the actual exit, so a replacement spawn
    // never overlaps a live old child. The bound sits past kill's 3s SIGKILL
    // escalation; a child still alive after that resolves anyway — the next
    // spawn's handshake failure path would kill its own child, never this one.
    async stop() {
        if (!this.alive)
            return;
        this.kill();
        await new Promise((resolve) => {
            const bound = setTimeout(resolve, 4500);
            this.child.once('exit', () => {
                clearTimeout(bound);
                resolve();
            });
        });
    }
    async handshake() {
        await this.request('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'huaweicloud-devkit', version: '1.0.0' },
        }, HANDSHAKE_TIMEOUT_MS);
        this.notify('notifications/initialized');
    }
    async call(name, args, timeoutMs = CALL_TIMEOUT_MS) {
        return this.request('tools/call', { name, arguments: args }, timeoutMs);
    }
}
let sidecarPromise = null;
// The resolved instance behind sidecarPromise; onExit compares against it so
// a stale child's late exit cannot clear a healthy replacement.
let currentSidecar = null;
export function resolveGatewayCommand(env = process.env) {
    const resolved = resolveDependencyCommand(DEPENDENCIES['open-mcp-gateway'].resolution, env);
    if (!resolved)
        return null;
    return { command: resolved.command, argsPrefix: [...resolved.argsPrefix] };
}
const SUPPORTED_MODE_TOKENS = new Set(['openapi', 'data']);
// Single definition of the provisioned policy file name: the spawn arg,
// the provisioning call, and the approval module's permanent-grant
// guidance all derive from it, so they cannot drift apart (the gateway
// fail-fasts on a missing --policy target, which is exactly the failure
// pre-spawn provisioning exists to prevent).
export const POLICY_FILE = 'policy';
export function resolveGatewaySpawnArgs(env = process.env) {
    // Relative operator paths are rejected before anything consumes them:
    // the gateway child resolves them against its scratch cwd, this server
    // against its own, and the protected-tree guard against tmpdir — three
    // anchors, three different files. Refusing the ambiguous form is the
    // same philosophy as the guard refusing '..' segments.
    for (const key of ['HUAWEICLOUD_MCP_POLICY_FILE', 'HUAWEICLOUD_MCP_AUDIT_FILE']) {
        const value = (env[key] ?? '').trim();
        if (value !== '' && !isAbsolute(value)) {
            throw new Error(`${key} must be an absolute path (got "${value}"): the gateway child, this server, and the protected-tree guard each resolve relative paths against different working directories.`);
        }
    }
    const args = ['--elicitation', 'off'];
    const mode = (env.HUAWEICLOUD_MCP_MODE ?? '').trim();
    if (mode === '') {
        args.push('--mode', 'openapi');
    }
    else {
        const tokens = mode
            .split(',')
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
        const unsupported = tokens.filter((token) => !SUPPORTED_MODE_TOKENS.has(token));
        if (tokens.length === 0 || unsupported.length > 0) {
            throw new Error(`HUAWEICLOUD_MCP_MODE "${mode}" is not supported by the devkit proxy. Supported: openapi, data (comma-combinable). ` +
                'The gateway discover mode proxies arbitrary external MCP servers and is not modeled by the devkit approval boundary yet.');
        }
        // Operator pinned a mode through the gateway's own env: pass no --mode.
    }
    const policyEnv = (env.HUAWEICLOUD_MCP_POLICY_FILE ?? '').trim();
    let provision = null;
    if (policyEnv === '') {
        const dir = packStateDir('huaweicloud-open-mcp', env);
        provision = { dir, policyPath: join(dir, POLICY_FILE) };
        args.push('--policy', provision.policyPath);
    }
    // The gateway's logging defaults to a RELATIVE logs/ path that it mkdirs
    // at boot: bare, it would drop a logs/ directory into whatever cwd the
    // child inherited and die outright on a read-only cwd. Pin it to tmpdir
    // unless the operator already configured the gateway's own env var.
    if (!(env.HUAWEICLOUD_MCP_LOG_FILE ?? '').trim()) {
        args.push('--log-file', join(tmpdir(), 'huaweicloud-open-mcp.log'));
    }
    return { args, provision };
}
// Scratch-cwd bookkeeping for spawnSidecar: every spawn pins its gateway
// child to a per-child mkdtemp cwd, and each is removed when that child
// closes, plus a process-exit sweep. 'close', not 'exit': a failed spawn
// (a resolvable-but-broken gateway binary, ENOENT/EACCES) emits 'error'
// then 'close' and never 'exit', and openMcpSidecar resets its promise on
// failure — an exit-only hook would stack one scratch dir per retried
// call for the process lifetime. The sweep is
// required for the production path — the child follows the parent's stdin,
// but a parent racing through process exit cannot wait for the child's
// exit event — and the close hook covers mid-process death so a
// replacement spawn does not stack scratch dirs (one per spawn leaked
// before; the 2026-10-09 TMPDIR=$HOME runs made ~23 per suite visible).
// Registered lazily inside spawnSidecar so module scope stays
// side-effect free. Removal is best-effort: a gateway artifact the host
// refuses to delete must never fail the server.
const scratchCwds = new Set();
let scratchExitSweepInstalled = false;
function removeScratchCwd(dir) {
    scratchCwds.delete(dir);
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        // best-effort by design
    }
}
async function spawnSidecar() {
    const gateway = resolveGatewayCommand();
    if (!gateway) {
        throw new Error('huaweicloud-open-mcp gateway not found. Install it with pip (`pip install huaweicloud-open-mcp`) or keep `uvx` on PATH to run it without a persistent install (`uv tool install huaweicloud-open-mcp` also works). OPENMCP_BIN can point at the gateway binary directly.');
    }
    const plan = resolveGatewaySpawnArgs();
    if (plan.provision) {
        // Precedes spawn: the gateway fail-fasts on a missing policy file, and
        // the policy store is the authorization base for the delegated face.
        ensurePackState('huaweicloud-open-mcp', [POLICY_FILE]);
    }
    // Per-child scratch cwd, not the shared tmpdir root: two MCP server
    // processes (stdio + remote) each spawn a gateway child, and relative
    // out.path/tables.path values resolve against this cwd — a shared root
    // would make their relative writes collide. The protected-tree guard
    // anchors relative targets at tmpdir(), the PARENT of every scratch cwd:
    // a relative name can only ever be over-denied there (basename collision
    // with a protected root), never under-denied, because any climb out
    // needs '..' — which the guard refuses outright.
    const scratchCwd = mkdtempSync(join(tmpdir(), 'openmcp-gw-'));
    scratchCwds.add(scratchCwd);
    if (!scratchExitSweepInstalled) {
        scratchExitSweepInstalled = true;
        process.on('exit', () => {
            for (const dir of scratchCwds)
                removeScratchCwd(dir);
        });
    }
    // A JS entry (OPENMCP_BIN pointed at a .mjs/.js/.cjs file — the test
    // fixture's shape, or any script-style install) must run under the
    // current Node, not be exec'd directly: win32 CreateProcess only runs PE
    // images and Node reports EFTYPE for the script file, while POSIX merely
    // tolerates it via the shebang. Extension detection only — the catalog's
    // real installs are native entry points (pip/pipx/uv shims), never .js.
    const isJsEntry = /\.(?:mjs|cjs|js)$/i.test(gateway.command);
    const child = spawn(isJsEntry ? process.execPath : gateway.command, isJsEntry ? [gateway.command, ...gateway.argsPrefix, ...plan.args] : [...gateway.argsPrefix, ...plan.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: scratchCwd,
    });
    child.on('close', () => removeScratchCwd(scratchCwd));
    stats.spawns += 1;
    stats.lastPid = child.pid ?? null;
    const sidecar = new OpenMcpSidecar(child);
    try {
        await sidecar.handshake();
    }
    catch (error) {
        // A failed handshake must not leak the child: the parent holds its
        // stdin pipe open, so an un-killed orphan stays alive — and pins the
        // event loop — for the process lifetime, once per retry.
        sidecar.kill();
        throw error;
    }
    return sidecar;
}
export function openMcpSidecar() {
    if (!sidecarPromise) {
        sidecarPromise = spawnSidecar()
            .then((sidecar) => {
            currentSidecar = sidecar;
            return sidecar;
        })
            .catch((error) => {
            sidecarPromise = null; // spawn or handshake failed: the next call retries
            throw error;
        });
    }
    return sidecarPromise;
}
// The gateway's wire envelope reports refusals as {ok:false, reason} inside
// a SUCCESSFUL tools/call result, while every other pack surfaces failures
// as {ok:false, error}. Map reason into error so callers and telemetry see
// one failure shape; reason is kept for gateway fidelity.
function withErrorKey(result) {
    if (result.ok === false && result.error === undefined && typeof result.reason === 'string') {
        return { ...result, error: result.reason };
    }
    return result;
}
// Error text crosses the boundary with both redactors applied: if the
// text parses as JSON (validation failures echo the offending input as an
// object), the key-name walk is stronger than any string pattern; the
// quoted-key string patterns cover the rest.
function redactErrorText(text) {
    try {
        return JSON.stringify(redactSecrets(JSON.parse(text)));
    }
    catch {
        return String(redactSecrets(text));
    }
}
// One proxied tools/call, normalized to the devkit result shape. The
// gateway is the authoritative validator of its own tool inputs; the zod
// schemas in tools.ts are a thin boundary guard, so unexpected extras pass
// through and errors surface as {ok:false} rather than throws. Success
// payloads cross this boundary redacted (gateway output can echo secret
// arguments); error paths redact too — refusal prose survives verbatim,
// only credential-shaped values are rewritten.
//
// forwarded marks a COMPLETED proxied tools/call: only the returns past
// sidecar.call's await carry it, never the catch. The catch covers every
// non-round-trip failure (timeout, mid-call child death, spawn/handshake
// failure) and one answered-but-rejected shape: a JSON-RPC error reply
// (Unknown tool) rejects in onLine and lands here too — conservative, and
// unreachable for the eval's vocabulary-pinned tasks. Callers
// distinguishing "the gateway answered" from "the call never completed"
// (the eval harness's reached verdict, drift reporting) must read this
// flag, not infer it from tool presence — the catch also sets tool, so
// tool alone proves only that callOpenMcpTool was entered.
export async function callOpenMcpTool(name, args, timeoutMs) {
    try {
        const sidecar = await openMcpSidecar();
        const raw = (await sidecar.call(name, args, timeoutMs));
        if (raw.isError) {
            const text = (raw.content || [])
                .map((part) => part.text || '')
                .join('\n')
                .trim();
            return { ok: false, forwarded: true, tool: name, error: redactErrorText(text) || 'open-mcp gateway tool error' };
        }
        if (raw.structuredContent && typeof raw.structuredContent === 'object') {
            // Redact the payload object itself, not the ok/tool envelope keys the
            // devkit layers on top of the spread.
            return withErrorKey({
                ok: true,
                forwarded: true,
                tool: name,
                ...redactSecrets(raw.structuredContent),
            });
        }
        const text = (raw.content || [])
            .map((part) => part.text || '')
            .join('\n')
            .trim();
        try {
            return withErrorKey({
                ok: true,
                forwarded: true,
                tool: name,
                ...redactSecrets(JSON.parse(text)),
            });
        }
        catch {
            return { ok: true, forwarded: true, tool: name, raw: redactSecrets(text) };
        }
    }
    catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        return { ok: false, tool: name, error: message };
    }
}
// The child's tools/list, normalized for the gateway_list_tools face:
// full entries (descriptions, input schemas) plus the drift report
// against the devkit's static projection (KNOWN_GATEWAY_TOOLS in
// tools.ts).
export async function listGatewayTools() {
    const sidecar = await openMcpSidecar();
    const raw = (await sidecar.request('tools/list', {}, CALL_TIMEOUT_MS));
    const tools = [];
    for (const entry of Array.isArray(raw?.tools) ? raw.tools : []) {
        if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string')
            continue;
        tools.push({
            name: entry.name,
            description: typeof entry.description === 'string' ? entry.description : undefined,
            inputSchema: entry.inputSchema,
        });
    }
    return tools;
}
// Test hooks, same convention as _resetHintConsumption in mcp-protocol.ts.
// lastPid records the most recent spawn attempt's child pid so tests can
// assert orphan-freedom (no live process left) after failure paths.
export function _openMcpSidecarStats() {
    return { spawns: stats.spawns, alive: sidecarPromise !== null, lastPid: stats.lastPid };
}
export async function _resetOpenMcpSidecar() {
    const promise = sidecarPromise;
    currentSidecar = null;
    sidecarPromise = null;
    if (!promise)
        return;
    try {
        const sidecar = await promise;
        sidecar.kill();
    }
    catch {
        // spawn or handshake already failed; spawnSidecar's catch killed the child
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
}
// First-class in-session restart: recycle the gateway child, e.g. after the
// host upgraded the binary (npx huaweicloud-devkit dep install
// open-mcp-gateway) while the agent was live. The old child is stopped and
// its real exit awaited (bounded by the kill escalation window) before the
// replacement spawns, so the upgraded binary is the one that runs.
//
// Serialization: the restart continuation itself becomes the sidecar
// promise, so tool calls racing the restart await the same replacement
// spawn instead of interleaving their own. currentSidecar is cleared BEFORE
// the old child stops, so the old child's onExit (which only clears state
// when currentSidecar === this) cannot wipe the continuation. In-flight
// proxied calls are rejected by the pending-entry machinery when the old
// child dies — the restart tool's description sets that expectation.
// Idempotent: no live singleton means the call is just a spawn.
export function restartOpenMcpSidecar() {
    const previous = sidecarPromise;
    currentSidecar = null;
    const next = (async () => {
        if (previous) {
            try {
                const old = await previous;
                await old.stop();
            }
            catch {
                // A failed spawn or handshake already killed its child.
            }
        }
        const sidecar = await spawnSidecar();
        currentSidecar = sidecar;
        return sidecar;
    })();
    sidecarPromise = next.catch((error) => {
        sidecarPromise = null; // the restart's spawn failed: the next call retries
        throw error;
    });
    return sidecarPromise.then(() => ({ pid: stats.lastPid, spawns: stats.spawns }));
}
