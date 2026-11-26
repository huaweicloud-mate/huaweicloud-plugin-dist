huaweicloud-devkit **v2.0.0** runtime compatibility check found incompatibilities.

| Agent | Bundled node | Verdict |
|-------|-------------|---------|
| workbuddy | 22.22.2 | ✅ |
| officeace | 22.22.2 | ✅ |
| codearts-ide | 22.21.1 | ✅ |
| codearts-desktop | 22.23.2 | ✅ |

Requirements: engines.node `>=22.19`, 13 python scripts (optional execution track).

Supply side is maintained in `runtimes.json`. If the agent has upgraded its bundled runtime, update the registry; otherwise the devkit engines requirement has outgrown the agent.