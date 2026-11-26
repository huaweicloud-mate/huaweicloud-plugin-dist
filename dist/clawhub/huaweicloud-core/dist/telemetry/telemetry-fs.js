// Stamp-file IO micro-helpers for the telemetry family: the
// create-on-write directory guard, best-effort text reads, the empty-file
// touch stamps, and the UTC-date readers the DAU/first-use stamps compare.
// Every function is parameterized — the path constants live in the face
// (telemetry.ts) and arrive via the context, never derived here.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function ensureDir(dirPath) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}
export function readTextFile(filePath) {
    try {
        return readFileSync(filePath, 'utf8').trim();
    }
    catch {
        return null;
    }
}
export function writeTextFile(filePath, content) {
    ensureDir(dirname(filePath));
    writeFileSync(filePath, content, 'utf8');
}
export function touchFile(filePath) {
    ensureDir(dirname(filePath));
    writeFileSync(filePath, '', 'utf8');
}
export function stampExists(filePath) {
    return existsSync(filePath);
}
export function getStampUTCDate(filePath) {
    try {
        return new Date(statSync(filePath).mtime).toISOString().slice(0, 10);
    }
    catch {
        return null;
    }
}
export function getUTCToday() {
    return new Date().toISOString().slice(0, 10);
}
