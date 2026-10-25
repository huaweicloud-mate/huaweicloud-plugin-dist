# huaweicloud-plugin-dist

HuaweiCloud DevKit 插件分发包代码仓：上游主仓 [huaweicloud/huaweicloud-devkit](https://github.com/huaweicloud/huaweicloud-devkit)（npm 包发布源）每次发包，本仓按各 agent 的插件结构打出对应的包，并通过 GitHub workflow 自动发布。**版本号以 npm registry 为准（`npm view huaweicloud-devkit version`），与 npm 包保持一致。**

## 目录结构（按 agent 分目录）

```
templates/<agent>/        各 agent 插件包的静态模板（人设、manifest、头像等源仓不存在的文件）
scripts/build-<agent>.mjs 从主仓源码 + 模板构建对应 agent 的包（自动注入版本号与 skills 列表）
dist/<agent>/             构建产物（解包形态，提交入库便于 review 与追溯）
.github/workflows/        构建与分发流水线
```

当前支持的 agent：

| Agent | 模板 | 构建脚本 | 产物 |
|-------|------|---------|------|
| WorkBuddy（专家包） | `templates/workbuddy/` | `scripts/build-workbuddy.mjs` | `dist/workbuddy/huaweicloud-plugin/` |
| ClawHub（OpenClaw） | 无需模板（包即 `plugins/huaweicloud-core` 原样） | `scripts/build-clawhub.mjs` | `dist/clawhub/huaweicloud-core/` |

后续新增 agent（codex / claude / cursor / opencode ...）时，各加一套 `templates/<agent>/` + `scripts/build-<agent>.mjs` + workflow job 即可。

## ClawHub 包结构

```text
huaweicloud-core/                # npm tarball 里的 plugins/huaweicloud-core 目录原样
  openclaw.plugin.json           # 版本由主仓 sync-version 维护，与 npm 严格一致（构建时校验）
  skills/  src/  hooks/  safety/  assets/  .mcp.json  ...
```

从 npm registry tarball 构建（`npm pack huaweicloud-devkit@<版本>`），内容与 npm 版本严格一致。官方提交**可全自动**：workflow 里的 `publish-clawhub` job 通过 clawhub CLI 发布（`--family bundle-plugin --bundle-format codex`），需配置仓库 variable `CLAWHUB_ENABLED=true` + secret `CLAWHUB_TOKEN` 后激活；未配置时自动跳过，构建与 Release 照常。安装方式：`openclaw plugins install clawhub:huaweicloud-devkit`。

## WorkBuddy 专家包结构

```text
huaweicloud-plugin/
  .codebuddy-plugin/plugin.json   # 专家 manifest（version + skills 列表由构建脚本注入）
  agents/huaweicloud-plugin.md    # 人设 + skill 加载优先级规则（版本号自动戳记）
  avatars/expert.png              # 专家头像
  skills/                         # 主仓 plugins/huaweicloud-core/skills 全量拷贝
  README.md                       # 包说明（版本号、skill 数自动戳记）
```

## 本地构建

```bash
node scripts/build-workbuddy.mjs --source <主仓 checkout 路径> --version <版本号>
# 版本号用 npm 包版本：node scripts/build-workbuddy.mjs --source <路径> --version "$(npm view huaweicloud-devkit version)"
# 产物：dist/workbuddy/huaweicloud-plugin/

node scripts/build-clawhub.mjs --version "$(npm view huaweicloud-devkit version)"
# 产物：dist/clawhub/huaweicloud-core/（从 npm registry tarball 构建）
```

## 自动分发

workflow `.github/workflows/build.yml` 支持三种触发：

1. **npm 发包自动联动**（`.github/workflows/auto-build.yml`，每 30 分钟轮询）：检测到 npm registry 上 `huaweicloud-devkit` 有新版本（对比 `.state/last-built-npm-version`）即自动触发打包。**上游代码仓无需做任何事情，npm publish 即触发。**
2. **手动**（`workflow_dispatch`）：指定源仓（默认上游 `huaweicloud/huaweicloud-devkit`）、ref（默认 `dev`）、版本号（默认从 npm registry 解析）。
3. **外部联动**（`repository_dispatch`，type `plugin-release`）：其他自动化发送

```bash
gh api repos/huaweicloud-mate/huaweicloud-plugin-dist/dispatches \
  -f event_type=plugin-release \
  -F 'client_payload[ref]=dev' \
  -F 'client_payload[version]=<版本号>'
```

流水线动作：构建（workbuddy + clawhub 两个 job）→ 提交 `dist/` 变更 → 创建 Release（tag `workbuddy-v<版本>` / `clawhub-v<版本>`，附 `huaweicloud-plugin.zip` / `huaweicloud-devkit.zip` 产物）→ 记录已构建版本（`.state/last-built-npm-version`，供轮询判重）。ClawHub 官方提交 job 在构建后自动运行（门控激活时）。

**官方提交途径**：WorkBuddy 专家包目前为控制台人工上传 — 从 Release 下载 zip 后上传到 WorkBuddy 商店。当官方提供提交 API 时，在 workflow 中追加 `publish-*` job 即可接入。

## 运行时兼容监控

DevKit 对各 agent 环境的运行时需求（当前：`engines.node: ">=22"` 硬依赖 + 包内 python/shell 脚本的可选执行轨）可能与各 agent 内置的运行时版本冲突。监控机制：**需求侧自动提取 + 供给侧手工登记 + 每次构建自动对账 + 不兼容自动开 issue**。

```
runtimes.json                        供给侧登记表：各 agent 内置运行时版本（手工维护，带 lastVerified 与探测提示）
scripts/check-runtime-compat.mjs     需求侧自动提取（npm 包 engines + 第二运行时扫描）+ semver 对账 + 矩阵输出
dist/runtime-compat/                 兼容矩阵（compat.md 人读 + compat.json 机器读），每次构建提交
```

- **需求侧**每次构建从 npm tarball 自动提取（engines.node、包内 .py/.sh 脚本数）
- **供给侧**无法从 GitHub 自动感知（agent 内置 Node 在 agent 自己的发布物里），手工维护 `runtimes.json`——agent 升级后更新并刷新 `lastVerified`
- 每次 build（含 30 分钟 npm 轮询联动）自动对账：兼容 → 矩阵更新入库；**不兼容 → 自动开/更新 `runtime-compat` 标签的 GitHub issue 告警**
- 当前四个 agent（workbuddy 22.22.2 / officeace 22.22.2 / codearts-ide 22.21.1 / codearts-desktop 22.23.2）均满足 `>=22`

## License

Apache-2.0
