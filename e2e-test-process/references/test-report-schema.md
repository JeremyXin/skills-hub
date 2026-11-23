# 测试报告结构化产物（`-test-report.json`）

> 本文件是公共库的**可选能力**：项目 skill 声明使用渲染器时，S6 与 `-test-report.md` 同轮产出 JSON，
> 由 `references/render-report.mjs` 渲染为 `-test-report.html`。三者一起提交；HTML 永不手工编辑。
> 未声明的项目可忽略本文件。

## 1. 用法

```bash
node ~/.claude/skills/e2e-test-process/references/render-report.mjs <报告目录>
node ~/.claude/skills/e2e-test-process/references/render-report.mjs <报告目录> --strict   # 有 blocker 时退出码 1
```

脚本查找目录下所有 `*-test-report.json`，输出同名 `.html`，并打印告警摘要。Node 18+，零依赖。

## 2. 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 当前为 `1` |
| `reportConfig` | 否 | 项目差异声明，见 §3 |
| `requirement` / `env` / `reportDate` | 是 | 需求名、`dev`/`test`、`YYYY-MM-DD` |
| `meta` | 是 | `branch` / `commit` / `carrier` / `executedAt` / `executor` |
| `verdict` | 是 | `publishable`（bool）、`summary`；`conditions[]` 与 `publishable=true` 可并存 |
| `executionHistory[]` | 否 | 全局轮次：`{round, time, scope, verdict, note}` |
| `requirements[]` | 是 | `{id: "REQ-1", title}` |
| `cases[]` | 是 | 见下 |
| `stats.byPriority[]` | 是 | `{priority, total, pass, fail, blocked}`，**不存合计行** |
| `defects[]` | 否 | `{id, severity, priority, phenomenon, impact, cases[], status}` |
| `notCovered[]` | 否 | `{item, reason, requirements[], risk?, owner?}` |
| `cleanup` | 是 | `{method, checkedItems, residual, detail}` |
| `conclusion[]` | 是 | 一句话结论列表 |

### `cases[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `title` / `priority` | 是 | 如 `TC-DIST-001` / `P0` |
| `verdict` | 是 | `PASS` / `FAIL` / `BLOCKED` |
| `requirements[]` | 是 | 关联 REQ id |
| `implementation` | 否 | 类名:行号，证据原文，不解析 Markdown |
| `layers[]` | 是 | 声明的取证层；**层名由项目 skill 定义**（接口/日志/消息/数据/L0~L5 均可） |
| `requirementStatement` | 是 | 该用例证明的需求口径，一句话 |
| `assertions[]` | 是 | `{expected, actual, layer, matches, evidenceRef}`，**必须写实测值，不能只写「通过」** |
| `evidence[]` | 是 | `{id, layer, command, result, at?, keys?, request?, response?, raw?}`；`at` 为证据发生时刻（`HH:mm:ss`，区间用 `a–b`），`keys` 为业务 key 对象（`{contactWa, productId, clusterId, ...}`），`raw` 为原始输出全文 |
| `gaps[]` | 否 | 已知未被断言覆盖的点 |
| `flow` | 否 | 用例级测试流程图，见 §4 |
| `failureAnalysis` | FAIL 时必填 | `{layer, expected, actual, analysis, defectIds[]}` |
| `history[]` | 否 | 用例级多轮：`{round, time?, verdict, note}`，最后一轮必须等于 `verdict` |

## 3. 项目差异（`reportConfig`）

渲染器不含任何项目词，项目差异全部由报告自己声明：

```json
"reportConfig": {
  "payloadLayers": ["接口层", "回调层"]
}
```

| 字段 | 说明 |
|---|---|
| `payloadLayers` | 必须留 `request` / `response` 原文的层名数组；未声明时为空，不检查报文 |

服务端项目通常声明接口层与回调层；推理管线项目可声明 `L0 契约/进程`、`L2 IR` 等。
断言实测为「未发生」（0 次 / 无行 / 不存在）时该层豁免。

## 4. 测试流程（`cases[].flow`，可选）

把一条用例的执行链路画成流程图，并把原始证据按节点下钻。**不写 `flow` 的用例不受任何影响**：
既不渲染新区块，证据仍按「取证层」分组，告警输出与改造前逐行一致。排版与形状约定见
`report-flow-design.md`；本节的字段与规则是唯一契约。

```jsonc
"flow": {
  "direction": "LR",                                  // LR(默认) | TB
  "nodes": [{
    "id": "deleteByWa",                               // 用例内唯一
    "type": "http",                                   // 见下方枚举
    "label": "deleteByWa(删除接口)",                   // 节点名，≤2 行
    "detail": "GET /product/deleteByWa",              // 可选副标题：接口路径/表名/JobKey
    "evidenceRefs": ["ev-TC-DIST-011-delete"],        // 该节点挂载的证据 id
    "unverified": true,                               // 可选：设计上无证据（日志等）
    "note": "G2：应用日志不可读"                        // 可选：未取证原因，展示在证据区
  }],
  "edges": [{ "from": "dec", "to": "cancel", "label": "不存在", "kind": "error" }]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `nodes[].id` | 是 | 用例内唯一，重复或为空触发 `FLOW_DUP_NODE_ID` |
| `nodes[].type` | 是 | `start`/`end`/`http`/`sql`/`schedule`/`service`/`decision`/`callback`/`config`/`log`/`metric`/`mq`/`missing`；未知值按 `service` 渲染并告警 |
| `nodes[].label` | 是 | 业务语义短语；`detail` 放技术标识，两者各自最多 2 行 |
| `nodes[].evidenceRefs` | 否 | 必须指向本用例 `evidence[]` 中存在的 id |
| `nodes[].unverified` | 否 | 标记为「未取证」：虚线描边 + 角标，不要求证据；**不得用伪造 payload 替代** |
| `edges[].from` / `to` | 是 | 必须指向存在的节点 id |
| `edges[].label` | 否 | 分支条件（是/否/存在/不存在/失败…），渲染为不透明胶囊 |
| `edges[].kind` | 否 | `normal`(默认)/`success`/`error`/`retry`/`async`，只影响线条颜色与虚实 |
| `direction` | 否 | `LR`（默认，横向蛇形折行）或 `TB`（纵向长链） |

约定：

- **证据只经 `nodes[].evidenceRefs` 挂载**，`evidence[]` 结构不变；一条证据可被多个节点引用。
  未被任何节点引用的证据单独归入「未挂载到流程节点的证据」，不会丢失。
- **重试画前向链**，不用回边：首次回调 → 判断 → 置失败态 → 排重试 → 重试触发 → 重试回调 → 成功。
  真回边虽可渲染，但会触发 `FLOW_CYCLE_BACKEDGE` 并绕过行间通道视觉语义。
- `start`/`end`/`decision`/`missing` 天然不产生证据，不参与 `FLOW_NODE_NO_EVIDENCE` 判定。

### 证据展示（有 `flow` 时）

- 节点内证据**按 `at` 升序排列**，无 `at` 的排在最后；同一节点内的多条证据因此可按时序阅读。
- 证据卡头展示 `id` + 取证层 + `at` 时刻，其下是 `keys` 业务 key 胶囊。
- `raw` 超过 3 行时折叠为「原始输出 · N 行」，点击展开；≤3 行直接展示。
- 断言表多一列「证据」：`evidenceRef` 可解析时渲染为可点击链接，点击会展开该证据所在折叠块并高亮。
- 无 `flow` 的报告不产生上述任何 DOM 变化。

## 5. 报文原文

`request` / `response` 用于 `payloadLayers` 中的层，存字符串或对象（页面按 JSON 缩进展示）：

- 接口层：`request` 写请求体（本地进程内取测试构造的入参；真实环境取实际发出报文），`response` 写响应体；
- 回调层 / 消息层：`request` 写传给下游的完整入参或消息体，`response` 写下游返回。

只写「HTTP 200」「回调 1 次」不算取证，会触发 `EVIDENCE_NO_PAYLOAD`。

## 6. 完整性校验（渲染器自动执行）

| code | 规则 | 级别 |
|---|---|---|
| `PASS_NO_ASSERTION` | PASS 但无断言 | blocker |
| `PASS_ASSERTION_FAILED` | PASS 但存在 `matches !== true` | blocker |
| `ASSERTION_NO_ACTUAL` | `actual` 为空或占位符（`-`/`—`/`N/A`/`TODO`/`null`） | blocker |
| `LAYER_NO_EVIDENCE` | 声明的层在断言与证据中都没出现 | warn |
| `STAT_MISMATCH` | `stats.byPriority` 与 `cases` 实际计数不一致 | blocker |
| `BLOCKED_COUNTED_AS_PASS` | 有 BLOCKED 用例但统计记 0 | blocker |
| `PUBLISHABLE_WITH_GAPS` | `publishable=true` 且存在 BLOCKED 或 `notCovered` | warn |
| `REQ_NO_CASE` | 某 REQ 没有用例 | warn |
| `REQ_NO_ASSERTION` | 某 REQ 关联用例全无断言 | blocker |
| `FAIL_NO_ANALYSIS` | FAIL 缺 `failureAnalysis` | warn |
| `HISTORY_FINAL_MISMATCH` | `history` 最后一轮与 `verdict` 不一致 | blocker |
| `EVIDENCE_ORPHAN` | `evidenceRef` 指向不存在的证据 | warn |
| `EVIDENCE_NO_PAYLOAD` | `payloadLayers` 中的层缺 `request`/`response` 报文 | warn |
| `CLEANUP_UNVERIFIED` | `cleanup.residual` 缺失或 `checkedItems=0` | warn |

流程相关告警**仅在用例声明了 `flow` 时触发**，全部为 warn，按「用例 + 规则」聚合成一条：

| code | 规则 |
|---|---|
| `FLOW_EMPTY` | 声明了 `flow` 但 `nodes` 为空 |
| `FLOW_BAD_DIRECTION` | `direction` 不是 `LR`/`TB`（按 LR 渲染） |
| `FLOW_DUP_NODE_ID` | 节点 `id` 重复或为空 |
| `FLOW_NODE_UNKNOWN_TYPE` | 节点类型不在枚举内（按 `service` 渲染） |
| `FLOW_NODE_NO_EVIDENCE` | 可取证类型的节点既无 `evidenceRefs` 也未标 `unverified` |
| `FLOW_EDGE_ORPHAN` | 边指向不存在的节点 |
| `FLOW_EVIDENCE_ORPHAN` | `evidenceRefs` 指向不存在的证据 id |
| `FLOW_EVIDENCE_UNBOUND` | 证据存在但未被任何节点引用（仍会展示为「未挂载」组） |
| `FLOW_IN_EDGE_MISSING` | 非 `start` 节点没有入边 |
| `FLOW_CYCLE_BACKEDGE` | 存在回边（重试应建模为前向链） |

只有 blocker 会阻断发布；warn 需要在结论或 `conditions` 中说明。

## 7. 最小示例

```json
{
  "schemaVersion": 1,
  "reportConfig": { "payloadLayers": ["接口层"] },
  "requirement": "示例需求",
  "env": "dev",
  "reportDate": "2026-11-19",
  "meta": { "branch": "feat-x", "commit": "工作区未提交", "carrier": "XxxE2ETest", "executedAt": "2026-11-19 14:26 ~ 14:34", "executor": "自动化" },
  "verdict": { "publishable": true, "summary": "1/1 PASS", "conditions": [] },
  "requirements": [{ "id": "REQ-1", "title": "保存后立即分发" }],
  "cases": [
    {
      "id": "TC-001",
      "title": "A 档立即分发",
      "priority": "P0",
      "verdict": "PASS",
      "requirements": ["REQ-1"],
      "implementation": "XxxServiceImpl.save:102",
      "layers": ["接口层", "数据层"],
      "requirementStatement": "保存后立即分发并回调一次",
      "assertions": [
        { "expected": "claimStatus=1", "actual": "1", "layer": "数据层", "matches": true, "evidenceRef": "ev-claim" }
      ],
      "evidence": [
        { "id": "ev-claim", "layer": "数据层", "command": "SELECT claimStatus FROM t WHERE contactWa='8613800000901'", "result": "1", "raw": null },
        { "id": "ev-http", "layer": "接口层", "command": "POST /product/save", "result": "HTTP 200", "request": { "contactWa": "8613800000901" }, "response": { "success": true }, "raw": null }
      ],
      "gaps": []
    }
  ],
  "stats": { "byPriority": [{ "priority": "P0", "total": 1, "pass": 1, "fail": 0, "blocked": 0 }] },
  "defects": [],
  "notCovered": [],
  "cleanup": { "method": "cleanupTestData()", "checkedItems": 3, "residual": 0, "detail": "3 项均为 0" },
  "conclusion": ["REQ-1 已验证"]
}
```
