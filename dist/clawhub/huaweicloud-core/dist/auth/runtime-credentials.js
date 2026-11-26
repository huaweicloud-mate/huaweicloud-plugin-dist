// The session-scoped runtime credential override, extracted from the
// credentials monolith's resolver family (the stable
// src/auth/credentials.ts face re-exports this module): the in-memory tier
// that shadows every store until cleared.
import { asText } from "../lib/as-text.js";
import { resolveCredentials } from "./credential-resolver.js";
let runtimeCredentials = null;
export function setRuntimeCredentials(ak, sk, securityToken, region) {
    runtimeCredentials = {
        ak: asText(ak ?? ''),
        sk: asText(sk ?? ''),
        securityToken: asText(securityToken || ''),
        region: asText(region || ''),
    };
}
export function clearRuntimeCredentials() {
    runtimeCredentials = null;
}
export function hasRuntimeCredentials() {
    return runtimeCredentials !== null;
}
export function resolveCredentialsWithRuntime(options = {}) {
    if (runtimeCredentials) {
        return {
            ak: runtimeCredentials.ak,
            sk: runtimeCredentials.sk,
            securityToken: runtimeCredentials.securityToken,
            region: runtimeCredentials.region,
        };
    }
    return resolveCredentials(options);
}
