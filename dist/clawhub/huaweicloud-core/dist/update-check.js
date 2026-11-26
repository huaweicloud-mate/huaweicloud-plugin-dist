// Version-update detection & auto-upgrade for huaweicloud-devkit (session-level).
// Spec: docs/superpowers/specs/2026-09-07-version-upgrade-design.md (internal, not committed).
//
// Stable public face of the update-check subsystem. The internals live in the
// src/update-* family (the semver channel logic, the installed-version reader,
// the skip-state persistence, the four-state verdict, the registry IO, the
// single-flight cache, and the upgrade act); this module is the re-export seam
// every consumer imports — same exported names, same import path, same
// behavior (the safety-policy.ts precedent).
// The semver channel logic family (parsing, prerelease precedence, target election).
export { semverParse, semverCompare, hasPrerelease, determineTarget, } from "./update-semver.js";
// The installed-version reader (package.json candidates + plugin-manifest fallbacks, #576).
export { readInstalledVersion } from "./update-installed.js";
// The skip-state (dismiss) persistence family: paths, session suffixing, read/write.
export { skipFilePath, fallbackSkipFilePath, resolveSkipFilePath, readSkipState, writeSkipState, } from "./update-skip.js";
// The four-state verdict (cooldown matrix) and the UpdateHint payload shape.
export { judgeUpdate } from "./update-hint.js";
// The dist-tags registry IO family (npm view sync/async, the undici fetch override).
export { queryDistTagsFetch, queryDistTagsSync, queryDistTags, parseDistTagsOutput } from "./update-registry.js";
// The single-flight cache family (TTL, failure throttling, the hint memo).
export { invalidateUpdateCache, getCachedUpdateInfo, peekCachedUpdateInfo, getUpdateDistTags, applyUpdateHint, } from "./update-cache.js";
// The upgrade act (tag election, the npx spawn, restart/manual guidance).
export { upgradePackage } from "./update-upgrade.js";
