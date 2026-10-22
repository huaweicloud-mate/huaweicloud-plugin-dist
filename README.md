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

后续新增 agent（codex / claude / cursor / opencode ...）时，各加一套 `templates/<agent>/` + `scripts/build-<agent>.mjs` + workflow job 即可。

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
```

## 自动分发

workflow `.github/workflows/build.yml` 支持两种触发：

1. **手动**（`workflow_dispatch`）：指定源仓（默认上游 `huaweicloud/huaweicloud-devkit`）、ref（默认 `dev`）、版本号（默认从 npm registry 解析）。
2. **发包联动**（`repository_dispatch`，type `plugin-release`）：发包时发送

```bash
gh api repos/huaweicloud-mate/huaweicloud-plugin-dist/dispatches \
  -f event_type=plugin-release \
  -F 'client_payload[ref]=dev' \
  -F 'client_payload[version]=<版本号>'
```

流水线动作：构建 → 提交 `dist/` 变更 → 创建 Release（tag `workbuddy-v<版本>`，附 `huaweicloud-plugin.zip` 产物）。

**官方提交途径**：WorkBuddy 专家包目前为控制台人工上传 — 从 Release 下载 zip 后上传到 WorkBuddy 商店。当官方提供提交 API 时，在 workflow 中追加 `publish-*` job 即可接入。

## License

Apache-2.0
