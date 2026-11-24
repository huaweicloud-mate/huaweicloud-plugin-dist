/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */
// The hwlink exec request/response correlation, extracted from
// hwlink-exec-client in the ws-exec family split: the PendingExec record,
// the exec result shape, and the arm/complete/settle operations over the
// session fields the correlation reads (the narrowed PendingExecHost shape
// the exec-session class satisfies structurally).
import { buildMarkers, buildShellCommands, cleanCommandOutput } from "./ws-exec-client.js";
// Arms one exec: builds the marker pair, records the pending exec with its
// timeout, and sends the command + done-marker lines (all synchronously,
// inside the promise executor, exactly as the session class once did).
export function armPendingExec(host, shellCommand, timeoutMs, onTimeout) {
    const markers = buildMarkers();
    const { doneCommand } = buildShellCommands(markers);
    return new Promise((resolve, reject) => {
        host.pending = {
            buffer: '',
            command: shellCommand,
            doneCommand,
            markers,
            reject,
            resolve,
            timeout: setTimeout(() => onTimeout(host.pending), timeoutMs),
        };
        host.sendLine(shellCommand);
        host.sendLine(doneCommand);
    });
}
// Scans the pending buffer for the done marker + exit code and resolves the
// exec when both are present; returns without effect otherwise.
export function completePendingExec(host) {
    const pending = host.pending;
    if (!pending)
        return;
    const doneMarker = pending.markers.doneMarker;
    const markerIndex = pending.buffer.lastIndexOf(doneMarker);
    if (markerIndex === -1)
        return;
    const afterMarker = pending.buffer.slice(markerIndex + doneMarker.length);
    const exitMatch = afterMarker.match(/^(\d+)/);
    if (!exitMatch)
        return;
    const rawOutput = pending.buffer.slice(0, markerIndex);
    const stdout = cleanCommandOutput(rawOutput, {
        inputEchoed: host.inputEchoed,
        command: pending.command,
        doneCommand: pending.doneCommand,
    });
    clearTimeout(pending.timeout);
    host.pending = null;
    pending.resolve({
        stdout,
        exitCode: Number(exitMatch[1]),
        url: host.url,
        source: host.source,
        username: host.username,
        command: pending.command,
    });
}
// Settles a pending exec on session teardown: disarms the timeout and
// rejects with the teardown error.
export function settlePendingExec(pending, error) {
    clearTimeout(pending.timeout);
    pending.reject(error);
}
