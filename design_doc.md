
## 文档 2：设计方案文档

```markdown
# Subagent Launcher — 设计方案文档

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Main Agent (强模型)                    │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Skill: delegation-manager                         │  │
│  │  指导主模型在模糊场景下判断是否下放                   │  │
│  └────────────────────────────────────────────────────┘  │
│                         │                                │
│            delegate_task 工具调用                         │
│                         │                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Plugin: delegation-lifecycle                       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │ 拦截逻辑  │ │ 结果过滤  │ │ 事件监控          │  │  │
│  │  │ patterns  │ │ filter   │ │ monitor           │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
                前台模式（阻塞等待）
                         │
┌─────────────────────────────────────────────────────────┐
│               Worker Agent (低级模型 / small_model)       │
│  - 独立会话，隔离上下文                                    │
│  - 只接收任务所需的局部信息                                 │
│  - 执行、观察、过滤、检测异常                               │
│  - 结果通过工具返回                                        │
└─────────────────────────────────────────────────────────┘
```

> MVP 只实现前台阻塞链路：主模型下放后等待 worker 一次性返回结果。
> 后台模式、补偿回收和事件注入仅作为后续扩展，不进入默认路径。

## 2. 组件设计

### 2.1 Plugin: delegation-lifecycle

**入口**: `src/plugin.ts`

**注册的 Hooks**:

| Hook | 用途 |
|------|------|
| `tool.execute.before` | 拦截 bash 命令，判断是否自动下放 |
| `tool.execute.after` | 过滤 subagent 返回的长输出 |
| `event` | 可选：记录 session 错误事件，默认不参与主流程 |
| `tool` | 注册 `delegate_task` 自定义工具 |

**自动下放触发逻辑** (`tool.execute.before`):

```
输入: bash 工具的 command 参数

步骤:
1. 解析命令形态
   - 尽量按 shell argv 解析，区分 executable、args、flags、redirections
   - 解析失败时回退到保守正则匹配

2. 规则匹配
   - 命中永不拦截规则 → 不拦截
   - 命中自动下放规则 → 直接触发
   - 未命中 → 进入估算

3. 风险估算
   - output_risk: low | medium | high | extreme
   - estimated_duration_ms
   - estimated_output_lines

4. 决策
   - duration > 30s 或 output_lines > 500 → 触发下放
   - output_risk === "extreme" → 直接触发
   - 否则 → 不拦截，正常执行

5. 转换
   - 将 bash 调用包装为 delegate_task 调用
   - 注入 task_type、timeout、执行约束
```

**结果过滤逻辑** (`tool.execute.after`):

```
输入: delegate_task 返回结果

按 task_type 分支:
- run_and_observe → 提取退出码、截断输出、标记异常
- wait_and_monitor → 提取异常事件、时间线摘要
- filter_and_summarize → 提取关键信息、截断详情
- process_batch → 提取成功/失败计数、保留失败详情

通用规则:
- 输出超过 200 行 → 截断，保留摘要
- 含 stderr → 提取并标记
- 非零退出码 → 标记为 failure
```

### 2.2 Tool: delegate_task

**定义**: `src/tools/delegate-task.ts`

**输入 Schema**:

```typescript
{
  task_type: "run_and_observe" | "wait_and_monitor" | "filter_and_summarize" | "process_batch",
  command?: string,           // bash 命令（run_and_observe 时使用）
  prompt: string,             // 任务描述
  mode?: "foreground" | "background",  // MVP 固定 foreground，background 仅作扩展
  timeout?: number,           // 超时 ms
  on_failure: "report" | "retry" | "abort",  // 默认 "report"
  max_retries?: number,       // retry 次数
  output_filter?: string      // 输出过滤正则
}
```

**输出 Schema**:

```typescript
{
  status: "success" | "failure" | "timeout" | "anomaly",
  summary: string,
  details?: string,
  anomalies: string[],
  duration: number
}
```

说明：`anomalies` 只表示 worker 观察到的事实信号，不直接代表主模型的最终诊断结论。

**内部流程**:

1. 根据 task_type 构造 worker prompt 模板
2. 注入执行约束：
   - 最大 200 行输出
   - 超时检测
   - 异常检测规则
   - 结果格式要求
3. 选择模型：默认 `small_model`，可通过 agent 配置覆盖
4. 调用 OpenCode 原生 `task` 工具：
   - `subagent_type: "worker"`
   - `prompt: 构造后的完整 prompt`
   - `background: false`
5. 收到结果后调用 filter.ts 过滤
6. 返回结构化结果

### 2.3 Agent: worker

**定义**: `agent/worker.md`

**配置**:
- `mode: subagent`
- `model: small_model`（默认，可覆盖）
- `steps: 20`（限制最大迭代）
- `permission.bash: allow`
- `permission.read: allow`
- `permission.glob: allow`
- `permission.grep: allow`
- `permission.edit: deny`
- `permission.task: deny`（禁止再派发）

**权限边界**:
- 可以做：搜索、读取、提取、归纳、列证据（grep/glob/read）
- 不可以做：架构决策、异常根因判断、修复方案选择、和用户确认（edit/task/question）
- 原则：worker 可以在任务约束内探索代码库，但只服务于搜索/筛选/摘要这类低认知任务

**系统提示要点**:
- 执行命令，观察输出
- 检测异常（错误、警告、非零退出码）
- 输出超过 200 行时自动摘要
- 不做编辑，不派发子任务
- 可在任务约束内使用 grep/glob 搜索代码
- 结果格式：RESULT / SUMMARY / DETAILS / ANOMALIES

### 2.4 Skill: delegation-manager

**定义**: `skill/delegation-manager/SKILL.md`

**指导主模型的判断框架**:

**何时主动下放**:
- 任务涉及执行命令并等待结果（非明显的测试/构建）
- 任务涉及处理大量文本或数据
- 任务涉及重复性操作
- 任务涉及等待某个条件满足

**何时不下放**:
- 需要理解业务语义
- 需要与用户交互
- 需要架构级分析
- 异常诊断和修复策略
- 快速一行命令

**下放方式**:
- 使用 `delegate_task` 工具
- prompt 只包含任务所需的局部信息
- 默认 foreground 模式

**结果处理**:
- success → 继续下一步
- anomaly → 分析异常信号，决定重试或调整
- failure → 诊断原因，制定修复方案

### 2.5 结果过滤模块

**定义**: `src/lifecycle/filter.ts`

**按任务类型过滤**:

| 类型 | 提取 | 保留 | 截断 | 标记 |
|------|------|------|------|------|
| 测试 | 总数/通过/失败/跳过 | 前 5 个失败用例 | 通过用例详情 | 意外失败、超时 |
| 构建 | 成功/失败状态 | 第一个错误 + 位置 | 成功步骤日志 | deprecation |
| 监控 | 异常事件 | 时间戳 + 上下文 | 正常周期输出 | 异常模式 |
| 通用 | 退出码 | stderr 内容 | 超过 200 行 | 非零退出 |

### 2.6 事件监控模块

**定义**: `src/lifecycle/monitor.ts`

**监听的事件**:
- `session.error` → 记录 subagent 异常，供调试和遥测使用
- `session.updated` → 后台模式扩展点，MVP 不依赖该事件回传结果

## 3. 命令匹配规则

### 3.1 自动下放（硬规则）

```typescript
const AUTO_DELEGATE_PATTERNS = {
  test: [
    /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
    /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bpytest\b/,
    /\bgo\s+test\b/, /\bcargo\s+test\b/, /\bphpunit\b/,
  ],
  build: [
    /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
    /\bmake\b/, /\bcmake\b/, /\bgradle\b/, /\bmvn\b/,
    /\bcargo\s+build\b/, /\bwebpack\b/, /\bvite\s+build\b/,
    /\btsc\b/, /\besbuild\b/,
  ],
  monitor: [
    /\btail\s+.*-f\b/, /\bwatch\b/, /\blogcat\b/,
    /\bdocker\s+logs\s+.*-f\b/, /\bjournalctl\s+.*-f\b/,
    /\bkubectl\s+logs\s+.*-f\b/,
  ],
  longRunning: [
    /\b(npm|yarn|pnpm)\s+run\s+dev\b/,
    /\bwebpack-dev-server\b/, /\bvite\b(?!.*build)/,
    /\bnodemon\b/, /\btsx\s+watch\b/,
  ],
  heavySearch: [
    /\bgrep\s+.*-r\b/, /\brg\b/, /\bfind\s+.*-exec\b/,
    /\bxargs\b/,
  ],
};
```

### 3.2 永不拦截

```typescript
const NEVER_INTERCEPT_PATTERNS = [
  /\bgit\s+(status|diff|show|log|branch)\b/,  // 快速查看类命令
  /\b(cd|ls|pwd|cat|head)\b/,  // 快速导航/查看
  /\b(cp|mv|rm|mkdir|touch|ln)\b/,  // 文件操作
  /\b(vim|nano|code|emacs)\b/,      // 编辑器
  /\bnpm\s+install\b/,              // 依赖安装（通常快速）
];
```

说明：`tail` 不进入永不拦截列表，因为 `tail -f` 是日志监控场景，应由自动下放规则处理。
`git` 只排除快速查看类子命令，避免误伤 `git grep`、`git clean -n` 等可能产生大量输出或需要观察的命令。

### 3.3 风险估算

```typescript
type CommandShape = {
  executable: string,
  args: string[],
  flags: Set<string>,
  redirections: string[],
  raw: string,
};

function parseCommandShape(command: string): CommandShape {
  // 实现时优先使用 shell-quote 这类成熟解析器；这里仅表达设计意图。
  const tokens = shellParse(command);
  const executable = tokens[0] ?? "";
  const args = tokens.slice(1);
  const flags = new Set<string>();
  const redirections: string[] = [];

  for (const arg of args) {
    if (arg === "-v" || arg === "--verbose") { flags.add("verbose"); }
    if (arg === "-f" || arg === "--follow") { flags.add("follow"); }
    if (arg.includes("/dev/null")) { redirections.push("/dev/null"); }
  }

  return { executable, args, flags, redirections, raw: command };
}

function estimateRisk(command: string): {
  outputRisk: "low" | "medium" | "high" | "extreme",
  estimatedDurationMs: number,
  estimatedOutputLines: number
} {
  const shape = parseCommandShape(command);
  let risk: "low" | "medium" | "high" | "extreme" = "low";
  let duration = 5000;    // 默认 5s
  let lines = 50;         // 默认 50 行

  // 修正因子
  if (shape.flags.has("verbose")) { lines *= 4; }
  if (shape.redirections.includes("/dev/null")) { lines = 0; risk = "low"; }
  if (shape.raw.includes("2>&1")) { lines *= 1.5; }
  if (shape.executable === "test" || shape.executable.endsWith("test")) {
    duration = 120000;
    lines = 500;
    risk = "high";
  }
  if (shape.executable === "build" || shape.executable.endsWith("build")) {
    duration = 300000;
    lines = 300;
    risk = "high";
  }
  if (shape.flags.has("follow")) {
    duration = Infinity;
    lines = Infinity;
    risk = "extreme";
  }

  return { outputRisk: risk, estimatedDurationMs: duration, estimatedOutputLines: lines };
}
```

## 4. 项目结构

```
opencode-delegation/
├── src/
│   ├── plugin.ts                 # 主 Plugin 入口
│   ├── detection/
│   │   ├── patterns.ts           # 命令模式匹配
│   │   └── estimator.ts          # 输出/耗时估算
│   ├── tools/
│   │   └── delegate-task.ts      # delegate_task 工具定义
│   └── lifecycle/
│       ├── filter.ts             # 结果过滤/摘要
│       └── monitor.ts            # 事件监控
├── skill/
│   └── delegation-manager/
│       └── SKILL.md              # 主模型判断框架
├── agent/
│   └── worker.md                 # Worker Agent 定义
├── opencode.json                 # 参考配置
├── package.json
└── tsconfig.json

# 同时提供 .opencode 目录参考实现：
.opencode/
├── skills/
│   └── delegation-manager/
│       └── SKILL.md
├── agents/
│   └── worker.md
├── plugins/
│   └── delegation-lifecycle.ts
└── opencode.json
```

## 5. 配置参考

### opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "small_model": "anthropic/claude-haiku-3.5",
  "agent": {
    "worker": {
      "description": "执行低认知密度任务的 worker agent",
      "mode": "subagent",
      "model": "small_model",
      "steps": 20,
      "permission": {
        "bash": "allow",
        "read": "allow",
        "edit": "deny",
        "task": "deny"
      }
    }
  },
  "plugin": [
    "./opencode-delegation"
  ]
}
```

### 包配置 (package.json)

```json
{
  "name": "opencode-delegation",
  "version": "0.1.0",
  "type": "module",
  "main": "src/plugin.ts",
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  }
}
```

## 6. 实现阶段

### Phase 1: 核心骨架
- plugin.ts 基础结构 + hook 注册
- patterns.ts 命令匹配规则
- worker.md agent 定义

### Phase 2: 拦截与下放
- estimator.ts 风险估算
- tool.execute.before 拦截逻辑
- delegate-task.ts 工具定义

### Phase 3: 结果处理
- filter.ts 结果过滤
- tool.execute.after 结果处理
- monitor.ts 事件监控

### Phase 4: 集成与打包
- SKILL.md 编写
- opencode.json 配置
- npm 包结构 + .opencode 目录

## 7. 限制与风险

| 风险 | 缓解措施 |
|------|----------|
| 命令模式匹配误判 | 白名单 + 黑名单 + 阈值估算三层过滤 |
| Worker 模型能力不足 | 限制任务范围，复杂任务不下发 |
| 前台模式阻塞时间过长 | 设置合理 timeout，超时自动终止 |
| 后台模式结果丢失 | 合成消息注入机制保证结果可达 |
| 插件 hook 错误影响主流程 | try-catch 包裹，错误静默降级 |
```
