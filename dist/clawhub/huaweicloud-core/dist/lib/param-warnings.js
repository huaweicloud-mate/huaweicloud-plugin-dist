// Unknown-parameter warnings for the MCP boundary. The #530 leniency keeps
// accepting keys a tool does not declare (model wire shapes are noisy and a
// rejection used to cost the whole call), but silently dropping a typo makes
// `pack` vs `pak` invisible — this module turns that into an additive
// `warnings` entry without changing the acceptance decision.
const MAX_WARNINGS = 5;
const SUGGESTION_DISTANCE = 2;
function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const previous = new Array(cols);
    const current = new Array(cols);
    for (let j = 0; j < cols; j++)
        previous[j] = j;
    for (let i = 1; i < rows; i++) {
        current[0] = i;
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        }
        for (let j = 0; j < cols; j++)
            previous[j] = current[j];
    }
    return previous[cols - 1];
}
export function suggestParam(key, knownKeys) {
    let best = null;
    let bestDistance = SUGGESTION_DISTANCE + 1;
    const lowerKey = key.toLowerCase();
    for (const candidate of knownKeys) {
        if (candidate === key)
            continue;
        const distance = levenshtein(lowerKey, candidate.toLowerCase());
        if (distance > SUGGESTION_DISTANCE)
            continue;
        if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}
export function unknownParamWarnings(args, knownKeys) {
    const unknown = Object.keys(args)
        .filter((key) => !knownKeys.has(key))
        .sort((a, b) => a.localeCompare(b));
    return unknown.slice(0, MAX_WARNINGS).map((key) => {
        const suggestion = suggestParam(key, knownKeys);
        return suggestion
            ? `Unknown parameter "${key}" was ignored. Did you mean "${suggestion}"?`
            : `Unknown parameter "${key}" was ignored (no matching parameter).`;
    });
}
// Additive by construction: a warnings array is merged, an absent field is
// created, and any other existing shape is left untouched under paramWarnings.
// Non-object results (there are none on the shipped surface) pass through.
export function attachParamWarnings(result, warnings) {
    if (warnings.length === 0)
        return result;
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        return result;
    const record = result;
    if (Array.isArray(record.warnings)) {
        return { ...record, warnings: [...record.warnings, ...warnings] };
    }
    if (record.warnings === undefined) {
        return { ...record, warnings };
    }
    return { ...record, paramWarnings: warnings };
}
