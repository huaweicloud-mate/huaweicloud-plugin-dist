// The hwlink connection layer, extracted from session-manager: the workspace-id
// state (HW_WORKSPACE_ID), the terminal-session cache (the sessions Map with
// its dead-transport eviction and the _setSessionConnectorForTests seam), the
// signed-connection prologue, the exec surfaces (one-shot and cached), the
// tunnel-session multiplexer, and the close family. Siblings import the exec
// surfaces from here; session-manager.ts re-exports them as the stable public
// face. The module-level singletons (currentWorkspaceId, sessions,
// sessionConnector) live ONLY here — every consumer goes through this module
// or its re-export face, so the cache stays process-wide single-instance.
import { createConnection, getCredentials } from "../lib/hdkit/hwlink-api.js";
import { getWebSocketImpl } from "../proxy/proxy-agent.js";
import { trackSandboxConnect, trackSandboxDisconnect } from "../telemetry/telemetry.js";
import { loadWsExec, } from "./ws-exec-loader.js";
let currentWorkspaceId = process.env.HW_WORKSPACE_ID || null;
export function getCurrentWorkspaceId() {
    return currentWorkspaceId;
}
export function setWorkspaceId(id) {
    if (id && id !== currentWorkspaceId) {
        trackSandboxConnect();
    }
    currentWorkspaceId = id;
    // Node coerces env assignments to strings (`null` -> "null"); String() keeps
    // that behavior while satisfying the typed ProcessEnv setter.
    process.env.HW_WORKSPACE_ID = String(id);
}
const sessions = new Map();
// The signed-connection prologue every hwlink session flavor shares:
// credentials, the hdkit connection request, the proxy-aware WebSocket
// implementation, and the ws-exec runtime.
async function openHwlinkConnection(workspaceId) {
    const { ak, sk, securitytoken } = getCredentials();
    const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);
    const WebSocketImpl = await getWebSocketImpl(wsUrl);
    const wsExec = await loadWsExec();
    return { wsUrl, source, WebSocketImpl, wsExec };
}
// The side-effecting half of getSession: credentials, the hdkit connection
// request, and the ws-exec spawn. Split out so the cache orchestration in
// getSession is the only logic that reads and writes the sessions Map.
async function connectTerminalSession(workspaceId, username, timeoutMs) {
    const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
    return await wsExec.connectHwlinkTerminalSession({
        url: wsUrl,
        source,
        username,
        timeoutMs,
        WebSocketImpl,
    });
}
let sessionConnector = connectTerminalSession;
// Test seam for the session cache: tests drive execWithSession (the real
// interface) with only the side-effecting connector replaced.
export function _setSessionConnectorForTests(connector) {
    sessionConnector = connector ?? connectTerminalSession;
}
async function getSession(workspaceId, username, timeoutMs) {
    const key = `${workspaceId}:${username}`;
    const existing = sessions.get(key);
    // A cached session whose transport died (state 'closed') would fail every
    // exec with the closed-before-marker error until an explicit
    // close_session; evict it and reconnect instead.
    if (existing) {
        if (existing.state !== 'closed')
            return existing;
        sessions.delete(key);
    }
    const session = await sessionConnector(workspaceId, username, timeoutMs);
    sessions.set(key, session);
    return session;
}
export async function createTunnelSession(workspaceId, username, timeoutMs = 30000) {
    const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
    const mux = new wsExec.HwlinkWebSocketMultiplexer(wsUrl, source, { WebSocketImpl, protocol: 'devenv' });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            clearInterval(interval);
            reject(new Error('tunnel session WebSocket open timeout'));
        }, timeoutMs);
        const interval = setInterval(() => {
            if (mux.readyState === 1) {
                clearTimeout(timer);
                clearInterval(interval);
                resolve();
            }
            else if (mux.readyState === 3) {
                clearTimeout(timer);
                clearInterval(interval);
                reject(new Error('tunnel session WebSocket closed'));
            }
        }, 100);
        mux.onClose = () => {
            clearTimeout(timer);
            clearInterval(interval);
            reject(new Error('tunnel session WebSocket closed'));
        };
        mux.onError = (err) => {
            clearTimeout(timer);
            clearInterval(interval);
            reject(err instanceof Error ? err : new Error(String(err)));
        };
    });
    return { mux, close: () => mux.close() };
}
export async function execOneShot(workspaceId, command, username, timeoutMs) {
    const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
    return await wsExec.executeHwlinkCommand({
        url: wsUrl,
        source,
        username,
        command,
        timeoutMs,
        WebSocketImpl,
    });
}
export async function execWithSession(workspaceId, command, username, timeoutMs) {
    const session = await getSession(workspaceId, username, timeoutMs);
    return await session.exec(command, { timeoutMs });
}
export async function closeSession(workspaceId, username) {
    const key = `${workspaceId}:${username}`;
    const session = sessions.get(key);
    if (!session)
        return false;
    sessions.delete(key);
    try {
        session.close();
    }
    catch {
        // best-effort: the session is already deregistered; a failed close must not fail disconnect tracking
    }
    trackSandboxDisconnect();
    return true;
}
export async function closeAllSessions() {
    for (const [key, session] of sessions) {
        sessions.delete(key);
        try {
            session.close();
        }
        catch {
            // best-effort: one stuck session must not block closing the rest
        }
    }
}
