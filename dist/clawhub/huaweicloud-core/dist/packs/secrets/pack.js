import { SECRETS_TOOLS } from "./tools.js";
export const secretsPack = {
    id: 'secrets',
    title: 'Secrets',
    description: 'Local encrypted secret vault: store, list, and delete secret:// refs. Values never cross the MCP face; consumption happens through the CLI (secret exec) or the credential resolver.',
    skills: [],
    tools: SECRETS_TOOLS.map((tool) => tool.name),
};
