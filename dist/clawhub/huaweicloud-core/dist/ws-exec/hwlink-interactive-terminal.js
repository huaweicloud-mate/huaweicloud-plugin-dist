/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */
// The one-shot interactive hwlink terminal, extracted from
// hwlink-exec-client in the ws-exec family split: the terminal factory
// (multiplexer + terminal-channel composition, ready handshake, close
// plumbing) and its await-ready wrapper.
import { WebSocketExecError } from "./ws-exec-client.js";
import { HwlinkWebSocketMultiplexer } from "./hwlink-multiplexer.js";
import { HwlinkTerminalChannel } from "./hwlink-terminal-channel.js";
import { errorMessage, isFiniteNumber, normalizeSource, normalizeUrl } from "./hwlink-normalize.js";
function createHwlinkTerminal(options = {}) {
    const { url, source, username = 'root', WebSocketImpl = globalThis.WebSocket, protocol = 'devenv', cols, rows, onFrame, onData, onError, onClose, trace = false, } = options;
    const normalizedUrl = normalizeUrl(url);
    const normalizedSource = normalizeSource(source);
    const mux = new HwlinkWebSocketMultiplexer(normalizedUrl, normalizedSource, {
        WebSocketImpl,
        protocol,
        onFrame,
        trace,
    });
    const term = new HwlinkTerminalChannel(username);
    let closed = false;
    let readySettled = false;
    let readyResolve = () => { };
    let readyReject = () => { };
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    function settleReady(error) {
        if (readySettled)
            return;
        readySettled = true;
        if (error)
            readyReject(error);
        else
            readyResolve(handle);
    }
    function handleError(error, prefix) {
        const wrapped = new WebSocketExecError(`${prefix}: ${errorMessage(error)}`, 1, {
            cause: error,
            phase: readySettled ? 'open' : 'opening',
        });
        settleReady(wrapped);
        if (onError)
            onError(wrapped);
        close();
    }
    function handleClose() {
        settleReady(new WebSocketExecError('hwlink terminal closed before ready', 1, {
            phase: 'opening',
        }));
        if (closed)
            return;
        closed = true;
        if (onClose)
            onClose();
    }
    term.onReady(() => {
        if (isFiniteNumber(cols) && isFiniteNumber(rows)) {
            term.resize(cols, rows);
        }
        settleReady();
    });
    term.onData((data) => {
        if (onData)
            onData(data);
    });
    term.onError((error) => handleError(error, 'hwlink terminal error'));
    term.onClose(handleClose);
    mux.onError = (error) => handleError(error, 'hwlink websocket error');
    mux.onClose = handleClose;
    function close() {
        if (closed)
            return;
        closed = true;
        term.close();
        mux.close();
    }
    const handle = {
        url: normalizedUrl,
        source: normalizedSource,
        username,
        mux,
        term,
        ready,
        close,
        resize: (nextCols, nextRows) => term.resize(nextCols, nextRows),
        sendInput: (data) => term.sendInput(data),
        sendText: (text) => term.sendText(text),
    };
    term.attach(mux);
    return handle;
}
async function connectHwlinkInteractiveTerminal(options = {}) {
    const terminal = createHwlinkTerminal(options);
    await terminal.ready;
    return terminal;
}
export { connectHwlinkInteractiveTerminal, createHwlinkTerminal };
