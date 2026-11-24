import { peelGluedRedirect } from "./tokens.js";
import { stripExecutable } from "./unwrap.js";
// The hcloud argv shape: how a token stream projects onto service and
// operation slots, and which spellings are local metadata (never
// cloud-side).
export function commandOperation(args) {
    const stripped = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : [])
        .map(String)
        .filter(Boolean);
    const nonFlags = stripped.filter((arg) => !arg.startsWith('-')).map((arg) => peelGluedRedirect(arg));
    if (stripped[0]?.toLowerCase() === 'configure') {
        // nonFlags slot: a flag between `configure` and its subcommand
        // (`hcloud configure --cli-region=x show`) must not mask the
        // credential-gate operation.
        return { service: 'configure', operation: nonFlags[1] ?? nonFlags[0] ?? '', args: stripped };
    }
    return {
        service: nonFlags[0] || '',
        operation: nonFlags[1] || nonFlags[0] || '',
        args: stripped,
    };
}
export function isLocalMetadataCommand(args) {
    return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}
