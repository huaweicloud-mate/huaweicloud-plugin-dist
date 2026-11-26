// Shared vocabulary of the telemetry family (the telemetry.ts face split).
// Types only — no runtime code, so siblings import freely without cycles.
//
// The STATE and PATHS records described here are constructed by the face
// (src/telemetry/telemetry.ts) at module scope and threaded through every
// family function as one context. That placement is load-bearing:
// test/telemetry.test.ts isolates module state by re-importing the FACE
// with a query string under a fresh HUAWEICLOUD_DEVKIT_HOME — only the face
// re-evaluates; sibling specifiers resolve to their already-cached module
// instances. Siblings must therefore stay stateless: no module-level
// mutable state and no load-time env/layout-derived constants (per-call
// env reads like the opt-out gate are fine). Everything layout- or
// home-derived lives in the face and rides in on the context.
export {};
