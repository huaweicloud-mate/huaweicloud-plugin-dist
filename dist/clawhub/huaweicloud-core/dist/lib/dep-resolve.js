import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
// Mirrors os.homedir()'s per-platform env var but reads the CALLER's env:
// USERPROFILE on win32, HOME on unix. Hermetic tests redirect home through
// the env they pass, and spawn-time resolution must agree with the home the
// child process would compute for itself — resolving the parent's real home
// while spawning into a redirected one splits the two.
export function platformHome(env) {
    return process.platform === 'win32' ? env.USERPROFILE || homedir() : env.HOME || homedir();
}
// Candidates are documented as places the binary itself lives, so the
// basename of the first platform candidate is the binary's name for the
// PATH lookup (minus the win32 .exe suffix — where.exe matches PATHEXT).
function pathLookupName(resolution) {
    const candidates = process.platform === 'win32' ? resolution.candidates.win32 : resolution.candidates.unix;
    if (candidates.length === 0)
        return null;
    // Length was just checked; index 0 is defined.
    const raw = basename(candidates[0]);
    return process.platform === 'win32' && raw.endsWith('.exe') ? raw.slice(0, -4) : raw;
}
export function lookupOnPath(name, env) {
    // POSIX `command -v` is a shell builtin, always present — an external
    // `which` binary is not (slim containers ship without it, silently
    // nulling the path tier). Names arrive from the DEPENDENCIES catalog
    // basenames and internal literals only, never user input; passing the
    // name positionally as $1 instead of interpolating it into the script
    // makes that safety a property of the call itself, not of every
    // caller's discipline.
    const lookup = process.platform === 'win32'
        ? spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 5000, env })
        : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8', timeout: 5000, env });
    const hit = lookup.status === 0 ? (lookup.stdout || '').trim().split('\n')[0] : '';
    return hit || null;
}
export function resolveDependencyCommand(resolution, env = process.env) {
    const envBin = env[resolution.envBin];
    if (envBin && existsSync(envBin))
        return { command: envBin, argsPrefix: [], tier: 'env' };
    const home = platformHome(env);
    const candidates = process.platform === 'win32' ? resolution.candidates.win32 : resolution.candidates.unix;
    for (const candidate of candidates) {
        const expanded = candidate.startsWith('~') ? join(home, candidate.slice(1)) : candidate;
        if (existsSync(expanded))
            return { command: expanded, argsPrefix: [], tier: 'candidate' };
    }
    const name = pathLookupName(resolution);
    const onPath = name === null ? null : lookupOnPath(name, env);
    if (onPath)
        return { command: onPath, argsPrefix: [], tier: 'path' };
    if (resolution.fallback) {
        const exeSuffix = process.platform === 'win32' ? '.exe' : '';
        const localCandidate = join(home, '.local', 'bin', `${resolution.fallback.command}${exeSuffix}`);
        const fallbackCommand = existsSync(localCandidate)
            ? localCandidate
            : lookupOnPath(resolution.fallback.command, env);
        if (fallbackCommand) {
            return { command: fallbackCommand, argsPrefix: resolution.fallback.argsPrefix, tier: 'fallback' };
        }
    }
    return null;
}
