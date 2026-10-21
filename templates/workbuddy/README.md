# 华为云专家 (Huawei Cloud Expert)

华为云全栈运维专家，覆盖 20+ 华为云服务，以安全第一、稳健降级为核心准则。知识内容同步自 [huaweicloud-mate/huaweicloud-devkit](https://github.com/huaweicloud-mate/huaweicloud-devkit) v__VERSION__。

## 能力概览

- **全栈云资源管理**：ECS、OBS、VPC、RDS、GaussDB、CCE、FunctionGraph、APIG、ModelArts 等 20+ 服务
- **安全执行引擎**：所有写操作需用户批准，凭证自动脱敏，执行前 Hook 风险检查
- **区域感知与预检**：发现可用区域，检查服务可用性和配额
- **极速沙箱体验**：将 Web 应用快速部署到华为云沙箱（DevStation），获取公网预览 URL，无需购买资源；沙箱服务不可达时自动改用其他部署目标，不阻断回答
- **知识轨开箱可用**：零环境依赖即可完成服务选型、方案设计、成本估算、命令规划与只读排障
- **稳健降级**：检测不到本地工具、连接器或凭证时，自动回退为知识答复，不阻断对话
- **智能编排**：huawei-iac 统一编排多资源部署，成本余额门禁 + 批量审批 + 状态追踪
- **CLI 驱动**：通过 KooCLI 执行所有云资源操作
- **代金券领取**：查询并领取华为云激励代金券（一人一次）

## Skills（__SKILLS_COUNT__ 个）

| 类别 | Skills |
|------|--------|
| 核心 | huaweicloud-core, huaweicloud-safety, huaweicloud-cli-and-auth, huaweicloud-capability-discovery |
| 计算 | huawei-ecs, huawei-cce |
| 存储 | huawei-obs, huawei-cbr |
| 网络 | huawei-vpc |
| 数据库 | huawei-rds, huawei-cloud-dds-dcs-instance-management, huawei-cloud-gaussdb-instance-management |
| 无服务器 | huawei-functiongraph, huawei-cloud-apig-instance-management |
| AI/ML | huawei-modelarts |
| 消息 | huawei-cloud-smn-dms-message |
| 安全 | huawei-cloud-dew-key-management, huawei-cloud-waf-aad-rule-management |
| 监控 | huawei-cloud-eye, huawei-cloud-cts-trace-management |
| IAM | huawei-iam |
| 计费 | huawei-billing |
| 激励 | huawei-voucher |
| 部署 | huawei-cloud-deployment-task-management, huawei-sandbox |
| 编排 | huawei-iac |
| 通用 | huaweicloud-api-and-sdk, huaweicloud-troubleshooting, huawei-getting-started |

## 运行模式

| 模式 | 可用条件 | 能力 |
|------|---------|------|
| 知识轨（默认） | 始终可用，零环境依赖 | 服务选型、方案设计、成本估算、命令规划与讲解、只读排障、配置示例 |
| 执行轨（可选） | 已安装 MCP Server + KooCLI 且已配置凭证，且用户明确要求真实操作 | 真实查询、沙箱部署与预览、资源创建/变更（审批后执行）、验证交付 |

## MCP Server（可选增强）

专家包提供 Skills 和人设定义。**知识答复、方案设计、命令规划与只读排障开箱即可用，不依赖任何本地环境。**

如需让专家在你的机器上真实执行华为云操作（含沙箱部署），需另行安装 MCP Server + KooCLI 并在你自己的真实终端配置凭证（可选）：

```bash
npx huaweicloud-devkit auth init
```

> 安装与凭证配置属于**用户环境准备**，不是使用本专家的前置条件。完成后前往 连接器 → 自定义连接器，确认 `huaweicloud-devkit` 已添加信任并启用。未完成时专家自动运行在知识轨，不会阻断对话。

## License

Apache-2.0
