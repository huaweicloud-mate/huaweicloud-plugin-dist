import { createHash, createHmac } from 'node:crypto';
// Huawei Cloud SDK-HMAC-SHA256 request signing, shared by the IAM credential
// validator (auth/credential-validator.ts) and the hwlink API client
// (lib/hdkit/hwlink-api.ts). One implementation of the signing algorithm;
// the callers own endpoint resolution and the request itself.
function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest('hex');
}
function urlEncode(str) {
    const hex = (c) => '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
    const noEscape = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~'.split(''));
    let out = '';
    for (const ch of str) {
        const c = ch.codePointAt(0) ?? 0;
        out += noEscape.has(ch) && c < 0x80 ? ch : c < 0x80 ? hex(c) : encodeURIComponent(ch);
    }
    return out;
}
function sdkTimestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + 'Z';
}
export function signSdkHmacRequest({ method = 'GET', path, query = {}, body, ak, sk, securityToken, baseUrl, timestamp, }) {
    const ts = timestamp ?? sdkTimestamp();
    const host = new URL(baseUrl).host;
    const cqs = Object.entries(query)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${urlEncode(k)}=${urlEncode(String(v))}`)
        .join('&');
    const curi = '/' +
        path
            .split('/')
            .filter(Boolean)
            .map((s) => urlEncode(s))
            .join('/') +
        '/';
    const signedHeaders = securityToken ? 'host;x-sdk-date;x-security-token' : 'host;x-sdk-date';
    const canonicalHeaders = securityToken
        ? `host:${host}\nx-sdk-date:${ts}\nx-security-token:${securityToken}\n`
        : `host:${host}\nx-sdk-date:${ts}\n`;
    const bodyStr = body ? JSON.stringify(body) : '';
    const payloadHash = sha256Hex(bodyStr);
    const canonicalRequest = [method, curi, cqs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSign = `SDK-HMAC-SHA256\n${ts}\n${sha256Hex(canonicalRequest)}`;
    const signature = hmacSha256(sk, stringToSign);
    const headers = {
        host,
        'x-sdk-date': ts,
        Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    if (securityToken) {
        headers['x-security-token'] = securityToken;
    }
    return headers;
}
