# Runtime compatibility matrix

Checked at 2026-11-21T01:59:30.082Z for huaweicloud-devkit **v1.1.15**.

## Requirements (extracted from the package)

- engines.node: `^22.19.0 || >=23.4.0`
- python scripts: 17 (optional execution track)
- shell scripts: 10 (optional execution track)

## Compatibility matrix

| Agent | Bundled node | engines.node | Node compat | Bundled python | Last verified |
|-------|-------------|--------------|-------------|----------------|---------------|
| workbuddy | 22.22.2 | ^22.19.0 || >=23.4.0 | insufficient | 未登记 | 2026-10-22 |
| officeace | 22.22.2 | ^22.19.0 || >=23.4.0 | insufficient | 未登记 | 2026-10-25 |
| codearts-ide | 22.21.1 | ^22.19.0 || >=23.4.0 | insufficient | 未登记 | 2026-10-25 |
| codearts-desktop | 22.23.2 | ^22.19.0 || >=23.4.0 | insufficient | 未登记 | 2026-10-25 |

## ❌ Incompatible

- workbuddy: bundled node 22.22.2 does not satisfy engines.node "^22.19.0 || >=23.4.0"
- officeace: bundled node 22.22.2 does not satisfy engines.node "^22.19.0 || >=23.4.0"
- codearts-ide: bundled node 22.21.1 does not satisfy engines.node "^22.19.0 || >=23.4.0"
- codearts-desktop: bundled node 22.23.2 does not satisfy engines.node "^22.19.0 || >=23.4.0"

## ⚠️ Warnings

- workbuddy: package ships 17 python scripts but no bundled python is registered
- officeace: package ships 17 python scripts but no bundled python is registered
- codearts-ide: package ships 17 python scripts but no bundled python is registered
- codearts-desktop: package ships 17 python scripts but no bundled python is registered

> Supply side (bundled runtimes) is maintained manually in `runtimes.json` — agent-bundled runtimes cannot be observed from GitHub. Update it on agent upgrades and refresh `lastVerified`.
