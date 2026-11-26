// Stable public face of the safety subsystem. The internals live in the
// src/safety/ family (policy loading and pattern appliers, the redaction
// walk, the secret vocabulary, the shell text model, the unwrap engine,
// the segment scanner and its xargs feeder, the hcloud and text
// classifiers); this module is the re-export seam every consumer imports —
// same exported names, same import path, same behavior.
export { loadPolicy } from "./safety/default-policy.js";
export { deriveSecretOperationAlternation } from "./safety/vocabulary.js";
export { redactSecrets } from "./safety/redact.js";
export { splitShellSegments } from "./safety/shell-text.js";
export { isCredentialFilePath } from "./safety/credential-path.js";
export { classifyHcloudArgs, assertAllowed } from "./safety/classify-hcloud.js";
export { classifyTextCommand } from "./safety/classify-text.js";
export { stripExecutable } from "./safety/unwrap.js";
