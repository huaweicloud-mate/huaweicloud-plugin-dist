/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */
// Input shaping for the hwlink clients, extracted from hwlink-exec-client in
// the ws-exec family split: the option normalizers both clients share and
// the two value helpers their error paths use.
import { WebSocketExecError } from "./ws-exec-client.js";
import { asText } from "../lib/as-text.js";
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return String(error);
}
// Number.isFinite returns true only for primitive numbers, so adding the
// typeof check is a pure narrowing with identical results.
export function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
export function normalizeCommand(command) {
    const text = asText(command);
    if (!command || !text.trim()) {
        throw new WebSocketExecError('missing command', 2);
    }
    return text.trim();
}
export function normalizeTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new WebSocketExecError('timeoutMs must be a positive number of milliseconds', 2);
    }
    return timeoutMs;
}
export function normalizeSource(source) {
    const numericSource = Number(source);
    if (!Number.isInteger(numericSource) || numericSource < -0x80000000 || numericSource > 0xffffffff) {
        throw new WebSocketExecError('hwlink source must be an int32 or uint32 number', 2);
    }
    return numericSource;
}
export function normalizeUrl(url) {
    const text = asText(url);
    if (!url || !text.trim()) {
        throw new WebSocketExecError('hwlink url is required', 2);
    }
    return text;
}
