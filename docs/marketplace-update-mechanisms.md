# DevKit 各 Agent 市场更新机制总表

> 各 agent 插件市场的安装与更新机制汇总。npm 包（huaweicloud-devkit）是大多数渠道的更新源——npm 发版 = 所有"装最新"渠道自动同步，这也是本仓 auto-build 轮询盯 npm registry 的原因。

| Agent | 市场/渠道 | 插件形态 | 安装机制 | 更新机制 |
|-------|----------|---------|---------|---------|
| **WorkBuddy** | 官方专家市场 | 专家包（.codebuddy-plugin + 人设 + skills） | 市场下载安装 | **手动打包 + 手动上传**；包内置版本戳防漂移规则（用户级 vs 插件包按版本号定权威） |
| **DSH** | 第三方插件市场 + 官方社区插件 | 插件（integrations/dsh） | **pnpm 安装，默认装最新** | npm 发新版本即随市场同步，无需人工分发 |
| **OfficeAce** | OfficeAce 平台 | MCP 连接器 + skill 包 | MCP 默认装最新 | MCP 随最新版；**skill 打包交付随版本发布** |
| **码道 IDE**（CodeArts IDE） | CodeArts 插件市场 | 插件 | **默认装最新** | npm 发新版本即随市场同步 |
| **码道 Work**（CodeArts Work） | CodeArts 插件市场 | 插件 | **默认装最新** | npm 发新版本即随市场同步 |
| **码道 Web**（CodeArts Web） | 团队内部交付 | 插件 | 团队分发 | **手动打包交付团队** |
| **OpenClaw / ClawHub** | ClawHub 公共注册表 | bundle-plugin（openclaw.plugin.json + skills + src） | `openclaw plugins install clawhub:huaweicloud-devkit` | **全自动**：构建 → clawhub CLI 官方发布 |
| **Coze** | 未上架 | — | — | — |
| **Claude Code** | 未上架 | — | — | — |
| **Cursor** | 未上架 | — | — | — |
| **Codex** | 未上架 | — | — | — |
| **OpenCode** | 无独立市场 | 本地集成（integrations/opencode） | devkit 安装器分发 | 随 devkit 安装/更新 |

## 关键结论

1. **npm 包是大多数渠道的更新源**：DSH、码道 IDE/Work 这些"默认装最新"的市场，本质都跟 npm 版本走——npm 发版即全渠道同步，无需人工分发。
2. **需要人工分发的只有三类**：WorkBuddy 专家市场（手动上传）、码道 Web（手动交付团队）、OfficeAce skill 交付——本仓已自动打好包和 Release，人工只做"取包上传"一步。
3. **未上架的四个**（Coze / Claude Code / Cursor / Codex）manifest 都已就绪，上架时在本仓加对应 `templates/<agent>/` + `scripts/build-<agent>.mjs` + workflow job 即可接入同一套流水线。
