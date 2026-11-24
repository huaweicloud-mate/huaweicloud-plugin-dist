/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */
// The hwlink terminal exec session, extracted from hwlink-exec-client in
// the ws-exec family split: the session class (open-handshake wiring, data
// pump, ready correlation, teardown) plus the connect and one-shot exec
// entry points built on it.
import { DEFAULT_TIMEOUT_MS, WebSocketExecError, buildMarkers, buildShellCommands } from "./ws-exec-client.js";
import { HwlinkWebSocketMultiplexer } from "./hwlink-multiplexer.js";
import { HwlinkTerminalChannel } from "./hwlink-terminal-channel.js";
import { errorMessage, isFiniteNumber, normalizeCommand, normalizeSource, normalizeTimeout, normalizeUrl, } from "./hwlink-normalize.js";
import { armPendingExec, completePendingExec, settlePendingExec, } from "./hwlink-exec-pending.js";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
class HwlinkTerminalExecSession {
    url;
    source;
    username;
    timeoutMs;
    onData;
    initialCols;
    initialRows;
    state;
    readyBuffer;
    inputEchoed;
    pending;
    queue;
    readyMarkers;
    readyCommand;
    readyPromise;
    resolveReady;
    rejectReady;
    readyTimeout;
    mux;
    term;
    constructor(options = {}) {
        const { url, source, username = 'root', timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket, protocol = 'devenv', cols, rows, onFrame, onData, trace = false, } = options;
        this.url = normalizeUrl(url);
        this.source = normalizeSource(source);
        this.username = username;
        this.timeoutMs = normalizeTimeout(timeoutMs);
        this.onData = onData;
        this.initialCols = cols;
        this.initialRows = rows;
        this.state = 'opening';
        this.readyBuffer = '';
        this.inputEchoed = false;
        this.pending = null;
        this.queue = Promise.resolve();
        this.readyMarkers = buildMarkers();
        const { readyCommand } = buildShellCommands(this.readyMarkers);
        this.readyCommand = readyCommand;
        this.resolveReady = () => { };
        this.rejectReady = () => { };
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.readyTimeout = setTimeout(() => {
            this.fail(new WebSocketExecError(`hwlink terminal ready timeout after ${this.timeoutMs}ms`, 124, {
                partialOutput: this.readyBuffer,
                phase: 'opening',
            }));
        }, this.timeoutMs);
        try {
            this.mux = new HwlinkWebSocketMultiplexer(this.url, this.source, {
                WebSocketImpl,
                protocol,
                onFrame,
                trace,
            });
        }
        catch (error) {
            clearTimeout(this.readyTimeout);
            throw new WebSocketExecError(errorMessage(error), 2, { cause: error, phase: 'opening' });
        }
        this.term = new HwlinkTerminalChannel(username);
        this.term.onData((data) => this.handleTerminalData(data));
        this.term.onError((error) => {
            this.fail(new WebSocketExecError(`hwlink terminal error: ${errorMessage(error)}`, 1, {
                cause: error,
                phase: this.state,
            }));
        });
        this.term.onReady(() => {
            if (isFiniteNumber(this.initialCols) && isFiniteNumber(this.initialRows)) {
                this.term.resize(this.initialCols, this.initialRows);
            }
            this.sendLine(this.readyCommand);
        });
        this.term.onClose(() => {
            if (this.state !== 'closed') {
                this.fail(new WebSocketExecError('hwlink terminal closed before completion marker', 1, {
                    phase: this.state,
                }));
            }
        });
        this.mux.onClose = () => {
            if (this.state !== 'closed') {
                this.fail(new WebSocketExecError('hwlink websocket closed before completion marker', 1, {
                    phase: this.state,
                }));
            }
        };
        this.mux.onError = (error) => {
            if (this.state !== 'closed') {
                this.fail(new WebSocketExecError(`hwlink websocket error: ${errorMessage(error)}`, 1, {
                    cause: error,
                    phase: this.state,
                }));
            }
        };
        this.term.attach(this.mux);
    }
    ready() {
        return this.readyPromise;
    }
    exec(command, options = {}) {
        const run = () => this.runExec(command, options);
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => { });
        return result;
    }
    resize(cols, rows) {
        this.term.resize(cols, rows);
    }
    close() {
        if (this.state === 'closed')
            return;
        const wasOpening = this.state === 'opening';
        const pending = this.pending;
        this.state = 'closed';
        clearTimeout(this.readyTimeout);
        this.pending = null;
        if (wasOpening) {
            this.rejectReady(new WebSocketExecError('hwlink terminal session closed before ready', 1, {
                phase: 'opening',
            }));
        }
        if (pending) {
            settlePendingExec(pending, new WebSocketExecError('hwlink terminal session closed before completion marker', 1, {
                phase: 'running',
            }));
        }
        this.term.close();
        this.mux.close();
    }
    fail(error) {
        if (this.state === 'closed')
            return;
        const wasOpening = this.state === 'opening';
        const pending = this.pending;
        this.state = 'closed';
        this.pending = null;
        clearTimeout(this.readyTimeout);
        if (wasOpening) {
            this.rejectReady(error);
        }
        if (pending) {
            settlePendingExec(pending, error);
        }
        this.term.close();
        this.mux.close();
    }
    handleTerminalData(data) {
        if (this.state === 'closed')
            return;
        const chunk = decoder.decode(data, { stream: true });
        if (this.onData)
            this.onData(data, chunk);
        if (this.state === 'opening') {
            this.readyBuffer += chunk;
            this.tryCompleteReady();
            return;
        }
        if (this.pending) {
            this.pending.buffer += chunk;
            completePendingExec(this);
        }
    }
    tryCompleteReady() {
        const readyIndex = this.readyBuffer.indexOf(this.readyMarkers.readyMarker);
        if (readyIndex === -1)
            return;
        this.inputEchoed = this.readyBuffer.slice(0, readyIndex).includes(this.readyCommand);
        this.readyBuffer = '';
        this.state = 'ready';
        clearTimeout(this.readyTimeout);
        this.resolveReady(this);
    }
    runExec(command, options = {}) {
        if (this.state !== 'ready') {
            return Promise.reject(new WebSocketExecError('hwlink terminal exec session is not ready', 1, {
                phase: this.state,
            }));
        }
        const shellCommand = normalizeCommand(command);
        const timeoutMs = normalizeTimeout(options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs);
        return armPendingExec(this, shellCommand, timeoutMs, (pending) => {
            this.fail(new WebSocketExecError(`hwlink terminal exec timeout after ${timeoutMs}ms`, 124, {
                partialOutput: pending ? pending.buffer : '',
                phase: 'running',
            }));
        });
    }
    sendLine(line) {
        this.term.sendInput(encoder.encode(`${line}\n`));
    }
}
async function connectHwlinkTerminalSession(options = {}) {
    const session = new HwlinkTerminalExecSession(options);
    await session.ready();
    return session;
}
async function executeHwlinkCommand(options = {}) {
    const { command, timeoutMs = DEFAULT_TIMEOUT_MS, ...sessionOptions } = options;
    const shellCommand = normalizeCommand(command);
    const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
    const session = await connectHwlinkTerminalSession({
        ...sessionOptions,
        timeoutMs: normalizedTimeoutMs,
    });
    try {
        return await session.exec(shellCommand, { timeoutMs: normalizedTimeoutMs });
    }
    finally {
        session.close();
    }
}
export { HwlinkTerminalExecSession, connectHwlinkTerminalSession, executeHwlinkCommand };
