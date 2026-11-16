huaweicloud-devkit **v1.1.14** runtime compatibility check found incompatibilities.

| Agent | Bundled node | Verdict |
|-------|-------------|---------|
| workbuddy | 22.22.2 | ❌ 22.22.2 不满足 ^22.19.0 || >=23.4.0 |
| officeace | 22.22.2 | ❌ 22.22.2 不满足 ^22.19.0 || >=23.4.0 |
| codearts-ide | 22.21.1 | ❌ 22.21.1 不满足 ^22.19.0 || >=23.4.0 |
| codearts-desktop | 22.23.2 | ❌ 22.23.2 不满足 ^22.19.0 || >=23.4.0 |

Requirements: engines.node `^22.19.0 || >=23.4.0`, 17 python scripts (optional execution track).

Supply side is maintained in `runtimes.json`. If the agent has upgraded its bundled runtime, update the registry; otherwise the devkit engines requirement has outgrown the agent.