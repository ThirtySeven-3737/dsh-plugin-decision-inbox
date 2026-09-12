# DSH Decision Inbox 真实模型端到端测试报告

- 测试日期：2026-09-11～2026-09-12
- 被测插件：`dsh-decision-inbox` 0.1.0 基线、0.2.0 修复复测
- DSH：`@deepseek-ai/dsh` 0.1.0-rc.5，本地源码 Web 模式
- 模型：DeepSeek-V4-Flash，High
- 平台：Windows，隔离的 `DSH_HOME`
- 凭据：从工作区外层的 `env.txt` 注入测试服务进程；测试和日志未输出 API key

## 结论

核心交互已经成立：Agent 可以创建待决问题后继续执行无依赖工作，用户能够在 Agent 仍运行时回答，答案会定向注入原会话。多待决乱序回答、过期、取消、会话隔离和重复答案保护均通过。

0.1.0 暴露的最高优先级缺陷——DSH 服务重启后 pending 决策丢失——已在 0.2.0 修复。新版采用原子 JSON 状态存储、稳定 UUID 和持久化投递 outbox；真实进程级复测中，重启前创建的 pending 决策在重启后仍可列出、回答并恢复原 Agent，重复提交相同答案也不会二次投递。

0.2.0 随后又完成了 8 个并发待决、10 个独立任务、跨 headless/Web 进程恢复、活跃轮次连续 steering、乱序回答、最终依赖门控、重复/冲突答案、过期、取消和正常控制组的压力测试。插件状态机及 DSH 集成均通过。当前仍应保留两项明确边界：同一状态文件只支持单 DSH 进程写入；`agent.steer` 只能提供至少一次投递基础，不能对模型产生的外部副作用承诺严格 exactly-once。

## 测试矩阵

| ID | 场景 | 预期 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| RM-01 | 一个阻塞决策 + 五个独立任务；Agent 运行中回答 | 独立任务先推进，答案在同一活跃执行中被消费，最后只生成所选格式 | `decision-1` 创建后，任务 2–5 先完成；执行中回答 `JSON` 后生成 JSON 清单和完成标记，未生成 YAML | 通过 |
| RM-02 | 同一会话两个并发待决，按相反顺序回答 | 第二项先回答不会串到第一项；只有两项均满足后才生成最终产物 | `decision-3=严格模式` 先到时，`decision-2` 仍 pending 且未生成最终文件；随后 `decision-2=中文`，生成中文发布说明与 strict 风险策略 | 通过 |
| RM-03 | 一个短时过期决策 + 一个可取消决策 | 过期和取消后均不可回答，也不得唤醒 Agent 或生成依赖产物 | `decision-4` 到期后返回 `expired, not pending`；`decision-5` 取消后返回 `cancelled, not pending`；依赖文件均不存在 | 通过 |
| RM-04 | 跨会话回答 | 非所属会话看不到、答不了其他会话的决策 | 第二会话回答 `decision-6` 得到 `decision not found`；原会话仍可用 `staging` 正常回答 | 通过 |
| RM-05 | 相同与冲突重复答案 | 相同答案不重复投递；不同答案不得覆盖 | 早期烟雾测试确认相同答案不产生新模型轮次；`decision-6` 再答 `production` 返回 `already answered differently`，保留 `staging` | 通过 |
| RM-06 | DSH 服务重启后恢复未回答决策 | 会话和 pending 决策都应恢复并仍可回答 | 0.1.0 中复现丢失；0.2.0 中同一 UUID 在重启后恢复，回答 `incremental` 后原 Agent 创建精确产物，状态最终为 `answered/delivered` | **0.2.0 修复后通过** |
| RM-07 | 自动化回归与构建 | 类型检查、单元/集成测试、构建全部成功 | `tsc --noEmit` 通过；5 个测试文件、49 个测试通过；`tsdown` 构建成功；完整 `pnpm verify` 通过 | 通过 |
| RM-08 | 8 个待决 + 10 个独立任务，跨 headless/Web 恢复并乱序回答 | 独立任务先完成；Web 恢复同一组 ID；第 8 个答案前无最终产物；连续 steering 不串线 | 8 个 UUID 全部恢复；10 个 2 字节文件正确；8 项最终均为 `answered/delivered`、revision 3；仅第 8 项到达后生成 `final.json` | 通过 |
| RM-09 | 完成后提交相同答案与冲突答案 | 相同答案不唤醒模型；冲突答案拒绝且不覆盖 | 相同 `incremental` 返回 `not delivered twice`，无模型轮次；随后 `full` 返回 `already answered differently`；持久层仍为 `incremental` | 通过 |
| RM-10 | 2 秒过期、主动取消、正常控制组三路并存 | 过期/取消项拒绝答案且无副作用；正常项仍可交付 | A 返回 `expired, not pending`；B 返回 `cancelled, not pending`；两条禁止文件不存在；C=`cyan` 正常创建精确 4 字节文件 | 通过 |

## 关键观察

### 1. 原始目标已被真实场景验证

RM-01 不是“上一轮结束后再回答”的简化测试。用户在 Agent 仍显示运行中、已执行约一半独立任务时发送 `/decision answer decision-1 JSON`。插件立即调用所属 Agent 的 `steer`，Agent 在同一活跃任务中接收答案并完成依赖分支。因此它确实解决了“无需停止长任务，也无需等整轮结束再补充关键选择”的问题。

### 2. 多任务不等于盲目并行

RM-02 证明依赖门控是按 decision ID 区分的。先回答风险策略时，Agent 没有假装语言选择也已完成；它继续保留语言决策 pending。第二个答案到达后，两个最终产物才分别采用正确选择，没有串线。

### 3. 会话隔离有效

决策归属由 Agent/session ID 限定。另一个真实 DSH 会话即使知道准确的 `decision-6`，仍得到 `not found`。这既避免误操作，也避免通过顺序 ID 枚举其他会话的待决内容。

### 4. 0.2.0 已修复重启恢复缺陷

0.1.0 的 `DecisionRuntime` 使用进程内 Map。重启后 DSH 的会话日志虽然仍显示旧消息和 `decision-7 pending`，插件状态却从空 Map 重建，导致同一个会话也无法回答；进程内计数器还可能重复生成旧 ID。

0.2.0 把状态持久化到 `$DSH_HOME/storages/decision-inbox.json`，使用 UUID，并把回答投递拆分为 `pending` 和 `delivered` 两个持久化阶段。修复复测使用决策 `decision-b97b4653-0fa8-48f8-8f2d-e93772259eff`：关闭并重新启动 DSH 后，`/decision list pending` 返回相同 ID；回答 `incremental` 后，sidecar 记录 `status=answered`、`deliveryStatus=delivered`、`revision=3`，原 Agent 创建的文件内容精确等于答案。再次提交相同答案时，命令返回“未重复投递”，且没有触发新模型轮次。

该 outbox 提供的是至少一次投递基础，而不是跨模型副作用的数学意义 exactly-once：如果进程恰好在 `agent.steer` 成功后、写入 `delivered` 前崩溃，恢复后允许重试。因此投递消息会携带 decision ID 作为幂等键，要求 Agent 不重复已经执行的副作用。

### 5. 多决策压力与活跃轮次注入通过

RM-08 先通过 headless profile 创建 8 个待决问题并完成 10 个独立文件，然后让该进程正常退出。随后启动共享同一隔离 `DSH_HOME` 的 Web profile：页面成功恢复该 headless 会话及全部 decision ID。答案按 `backup → release_channel → theme → database → retention_days → log_format → compression → region` 的顺序发送，其中后六项在连续活跃轮次中注入。

每个答案都关联到正确的 decision ID，没有串线；模型在进度 1/8 到 7/8 时都未创建 `final.json`，第 8 项 `region=CN` 到达后才生成。宿主侧读取 sidecar 验证 8 项均为 `answered/delivered`、revision 3，且答案分别为 `beta`、`PostgreSQL`、`JSON`、`30`、`CN`、`zstd`、`dark`、`incremental`。

### 6. 插件保留原始字符串，下游模型仍可能转换类型

`retention_days` 的命令答案是字符串 `"30"`，sidecar 也精确保留为字符串；模型生成 `final.json` 时自行写成 JSON 数字 `30`。这不是 decision inbox 丢失或篡改答案，但说明“投递原文”和“模型后续产物逐字保真”是两件事。需要严格类型时，应在任务提示或下游 schema 中明确字段类型并进行程序化校验。

## 文件级核验

模型完成后又从宿主终端独立检查了磁盘，不依赖模型自报：

- 场景 1：`deployment-manifest.json` 可解析且 `format=json`；`INDEPENDENT_COMPLETE.txt` 为 `FIVE_INDEPENDENT_TASKS_DONE`；不存在 YAML 版本。
- 场景 2：`risk-policy.json` 可解析且 `mode=strict`；`PREPARATION_DONE.txt` 为 `THREE_PREPARATION_TASKS_DONE`；发布说明文件存在。
- 场景 3：`INDEPENDENT_DONE.txt` 为 `OPERATIONS_PREP_DONE`；过期/取消分支对应的通知渠道和区域文件均不存在。
- 场景 4：所属会话标记精确为 `OWNER_READY`。
- 场景 5：重启恢复后的 `RECOVERED_BACKUP.txt` 内容为精确的 `incremental`，11 字节、无尾随换行；sidecar 中对应决策为 `answered/delivered`。
- 压力场景：8 个决策全部 `answered/delivered`、revision 3；`task-01.txt`～`task-10.txt` 均为精确的两位编号；`final.json` 有 9 个顶层键和 8 个 decision ID 映射，SHA-256 为 `1E2E9FC905A69D40F55064AFEE9B5B466A11F0F70A91814E559C5DE8C8DCC4BE`。
- 终态负向场景：`INDEPENDENT.txt` 为 `READY`，`CONTROL.txt` 为 `cyan`；过期与取消分支的两条禁止文件均不存在。
- sidecar 目录没有遗留 `decision-inbox.json.*.tmp` 临时文件。

真实模型测试产物位于 `tests/e2e-workspace/`，已被 `.gitignore` 排除。

## 环境噪声与非插件问题

- DSH 的 Windows PowerShell 沙箱在本机尝试设置工作区 ACL 时多次返回 Win32 error 5。测试中拒绝了 `danger-full-access` 升级，Agent 改用文件工具继续；这不影响 decision inbox 的状态机结论。
- DSH 服务仍加载插件时，沙箱内 `tsdown` 无法覆盖 `lib/index.d.ts`。停止服务后沙箱 ACL 仍限制构建器，但在正常宿主权限下完整 `pnpm verify` 成功。这是本机沙箱/ACL 行为，不是 TypeScript 或插件构建失败。
- 命令错误提示在 Web 消息流中会显示类似 `decision decision not found` 的重复前缀，属于轻微展示问题，不影响状态判定。

## 下一步建议

1. 把本次手工完成的“创建 pending → 关闭进程 → 重启 → list/answer → 恢复执行”固化为独立进程级自动化测试。
2. 明确并检测单写者约束，或改用带事务/锁的存储后端；当前不要让两个 DSH 进程同时写同一个 `decision-inbox.json`。
3. 增加可配置的历史保留与垃圾回收策略，避免 answered/cancelled/expired 决策无限增长。
4. 做 Web 原生决策收件箱和一键选项；UI 应直接读取持久层真实状态，而不是只投影聊天文本。
5. 如果未来开放跨设备回答，再增加经过鉴权的最小 HTTP/事件入口，并继续按 session 隔离决策。
