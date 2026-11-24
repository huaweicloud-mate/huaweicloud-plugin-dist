// The doctor reporter contract: the interface every extracted doctor section
// emits through. The cmdDoctor shell owns the counters and the exact line
// formats (single source for the [PASS]/[FAIL]/[WARN]/[INFO]/[SKIP] escape
// shapes); the sections in src/doctor-payload.ts, src/doctor-native.ts, and
// the per-agent modules call these methods so a moved section prints exactly
// what it printed inline. A leaf module by design: no imports, so every
// section module can depend on it without cycles.
export {};
