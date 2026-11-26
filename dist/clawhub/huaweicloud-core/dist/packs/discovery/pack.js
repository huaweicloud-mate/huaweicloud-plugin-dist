import { DISCOVERY_TOOLS } from "./tools.js";
// The discovery pack manifest. registry.ts references this from PACKS; the
// tool list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const discoveryPack = {
    id: 'discovery',
    title: 'Discovery',
    description: 'Marketplace skill search, official Huawei Cloud service icon lookup, and local web framework detection.',
    skills: [],
    tools: DISCOVERY_TOOLS.map((tool) => tool.name),
};
