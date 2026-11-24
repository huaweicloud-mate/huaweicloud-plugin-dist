import { execOneShot } from "./hwlink-connection.js";
// Test seam: exposeTunnel is otherwise untestable end-to-end (execOneShot
// opens a real ws connection). Pure helpers stay seam-free.
let oneShotForTests = null;
export function _setOneShotForTests(fn) {
    oneShotForTests = fn;
}
export async function runOneShot(workspaceId, command, username, timeoutMs) {
    return (oneShotForTests ?? execOneShot)(workspaceId, command, username, timeoutMs);
}
