import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { platform } from 'node:os';
import { runInitializeSideEffects, normalizeToolCallParams } from "./mcp-protocol.js";
import { detectAgent } from "./telemetry/agent-detect.js";
import { spoolTelemetryEvents } from "./telemetry/telemetry.js";
import { traceOutboundDisclosure } from "./lib/call-trace.js";
// LSP-style Content-Length frames and newline-delimited JSON on the same
// stream. The response framing echoes the client's: framed requests get
// framed responses, line requests get newline responses. Release smoke
// gates and the Hermes-on-Windows manual workaround both speak
// Content-Length, which the SDK StdioServerTransport does not.
export class DevkitStdioTransport {
    onmessage;
    onerror;
    onclose;
    buffer = Buffer.alloc(0);
    useContentLengthFraming = true;
    closed = false;
    // Keep the event loop alive after stdin is closed (Windows Hermes
    // workaround). Node exits when no active handles remain; the stdin 'data'
    // listener is the only handle. On Windows, Hermes may close the stdin pipe
    // after the initial handshake, causing the process to exit silently
    // (exit 0). For Hermes on Windows: arm a keepalive timer on stdin close
    // and only shut down when stdout also closes. For every other agent,
    // stdin close is the shutdown signal — exit cleanly so the host does not
    // see CLOSE_TIMEOUT.
    //
    // Close semantics vs the SDK lifecycle: Protocol.connect wraps onclose and
    // aborts in-flight handlers when it fires. Arming the keepalive must NOT
    // propagate onclose (that would tear the server down while Hermes still
    // expects it alive), and the non-Hermes exit path bypasses onclose by
    // design — process.exit(0) is the whole point. Only stdout close runs the
    // real onclose/cleanup path.
    needsKeepalive = detectAgent().harness === 'hermes' && platform() === 'win32';
    keepAlive = null;
    options;
    stdin;
    stdout;
    constructor(options = {}) {
        this.options = options;
        this.stdin = options.streams?.stdin ?? processStdin;
        this.stdout = options.streams?.stdout ?? processStdout;
    }
    async start() {
        this.stdin.on('close', () => this.onStdinClose());
        this.stdin.on('end', () => this.onStdinClose());
        this.stdout.on('close', () => this.onStdoutClose());
        this.stdin.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.readFrames();
        });
    }
    async send(message, _options) {
        if (this.closed)
            return;
        // Outbound-wire disclosure tracing (see lib/call-trace.ts contract):
        // the initialize result's instructions, tools/list results, and
        // tools/list_changed notifications.
        traceOutboundDisclosure(message);
        const json = JSON.stringify(message);
        if (this.useContentLengthFraming) {
            this.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
        }
        else {
            this.stdout.write(json + '\n');
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.keepAlive) {
            clearInterval(this.keepAlive);
            this.keepAlive = null;
        }
        this.onclose?.();
    }
    onStdinClose() {
        if (this.keepAlive)
            return;
        if (this.needsKeepalive) {
            this.keepAlive = setInterval(() => { }, 60000);
        }
        else {
            // The unflushed telemetry queue hands over to the exit spool
            // synchronously here — process.exit runs no further event-loop
            // turns, so no async flush can live between the two calls. The next
            // boot ingests the spool (E4b; see spoolEventsForExit for the
            // bounded-loss analysis).
            spoolTelemetryEvents();
            process.exit(0);
        }
    }
    onStdoutClose() {
        // Same handover on the natural-drain path: the queue is spooled AND
        // cleared, so the drain (a straggler flush round, a late timer tick)
        // finds an empty queue and cannot double-send the spooled lines.
        spoolTelemetryEvents();
        process.exitCode = 0;
        void this.close();
    }
    readFrames() {
        while (true) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
                this.useContentLengthFraming = true;
                if (!this.parseContentLengthFrame(headerEnd))
                    return;
                continue;
            }
            // A frame header split across chunks: the buffer holds a prefix of the
            // Content-Length token but the terminator has not arrived. Wait for
            // more bytes; consuming the prefix as a JSON line would emit a
            // spurious -32700, flip framing to newline mode, and desync the
            // stream permanently. No valid JSON line starts with this token.
            const headerPrefix = 'Content-Length:';
            const head = this.buffer.toString('latin1', 0, headerPrefix.length);
            if (head !== '' && headerPrefix.startsWith(head))
                return;
            const lf = this.buffer.indexOf('\n');
            if (lf !== -1) {
                this.useContentLengthFraming = false;
                const line = this.buffer.subarray(0, lf).toString('utf8').trim();
                this.buffer = this.buffer.subarray(lf + 1);
                if (line) {
                    try {
                        void this.handleMessage(JSON.parse(line));
                    }
                    catch {
                        this.writeParseError();
                    }
                }
                continue;
            }
            return;
        }
    }
    parseContentLengthFrame(headerEnd) {
        const header = this.buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            this.buffer = Buffer.alloc(0);
            return true;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length < bodyEnd)
            return false;
        const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.subarray(bodyEnd);
        try {
            void this.handleMessage(JSON.parse(body));
        }
        catch {
            this.writeParseError();
        }
        return true;
    }
    async handleMessage(raw) {
        // Valid JSON that is not an object (null / array / string) is an invalid
        // request per JSON-RPC 2.0 — reply -32600 rather than silently dropping it.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            this.writeJsonRpcError(-32600, 'Invalid Request');
            return;
        }
        const message = raw;
        if (message.method === 'initialize') {
            try {
                await (this.options.initializeSideEffects ?? runInitializeSideEffects)(message.params);
            }
            catch {
                // best-effort: initialize side effects must not fail the handshake
            }
        }
        if (!Object.hasOwn(message, 'id')) {
            // Notifications (incl. notifications/initialized) carry no response.
            if (message.method && message.method.startsWith('notifications/')) {
                this.onmessage?.(raw);
            }
            return;
        }
        // An id-bearing message without a method is either a RESPONSE to a
        // server-initiated request (the elicitation form we raise during a tool
        // call) or a malformed request. A response carries result or error and
        // must reach the SDK, which correlates it by id; without this branch the
        // form answer was answered with -32601 and the server waited out its
        // request timeout (measured: every elicitation round-trip hung on the
        // real stdio face while the in-memory transport worked). A message with
        // neither result nor error is still the malformed shape: reply -32601
        // echoing the id so the failure is correlatable, matching the legacy
        // behavior.
        if (typeof message.method !== 'string' || !message.method) {
            if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
                this.onmessage?.(raw);
                return;
            }
            this.writeJsonRpcError(-32601, 'Method not found: undefined', message.id);
            return;
        }
        this.onmessage?.(normalizeToolCallParams(raw));
    }
    writeMessage(message) {
        void this.send(message);
    }
    writeJsonRpcError(code, message, id = null) {
        this.writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code, message },
        });
    }
    writeParseError() {
        this.writeJsonRpcError(-32700, 'Parse error');
    }
}
