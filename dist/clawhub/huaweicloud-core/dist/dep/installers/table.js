import { HCLOUD_ESCAPE_HATCH, installKooCli, printKooCliManualInstructions, uninstallHcloud } from "./hcloud.js";
import { GATEWAY_ESCAPE_HATCH, installGatewayTool, uninstallGateway } from "./gateway.js";
import { probeHcloud } from "../../hcloud-probe.js";
import { DEPENDENCIES } from "../../lib/dependency-model.js";
export const DEP_INSTALLERS = {
    hcloud: {
        kind: 'cli',
        probe: () => probeHcloud(),
        install: installKooCli,
        manualInstructions: printKooCliManualInstructions,
        escapeHatch: HCLOUD_ESCAPE_HATCH,
        uninstall: uninstallHcloud,
    },
    'open-mcp-gateway': {
        kind: 'managed-child',
        install: installGatewayTool,
        confirmPromptSuffix: '(uv tool install / pipx / pip)',
        escapeHatch: GATEWAY_ESCAPE_HATCH,
        uninstall: uninstallGateway,
    },
    devbridge: null,
};
// The one lookup every dispatch site shares. Null exactly for
// sandbox-resident ids — the same fact the catalog's kind records, read
// through the table so callers never compare ids by hand.
export function installerFor(id) {
    return DEP_INSTALLERS[id];
}
