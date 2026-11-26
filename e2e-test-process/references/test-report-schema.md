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
| `flowTemplates` | 否 | 报告级流程模板（模板 + 分支），见 §4；与 `cases[].flowRef` 配合 |
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
| `evidence[]` | 是 | `{id, layer, command, result, at?, keys?, request?, response?, raw?, tables?, highlight?}`；`at` 为证据发生时刻（`HH:mm:ss`，区间用 `a–b`），`keys` 为业务 key 对象（`{contactWa, productId, clusterId, ...}`），`raw` 为原始输出全文，`tables` 为结构化查询结果（可多条，见 §3.1），`highlight` 为该证据的关键行补充匹配串（见 §3.2） |
| `gaps[]` | 否 | 已知未被断言覆盖的点 |
| `flow` | 否 | 用例级测试流程图（单次链路），见 §4 |
| `flowRef` | 否 | 引用报告级 `flowTemplates` 的模板 + 分支并挂证据，见 §4 |
| `failureAnalysis` | FAIL 时必填 | `{layer, expected, actual, analysis, defectIds[]}` |
| `history[]` | 否 | 用例级多轮：`{round, time?, verdict, note}`，最后一轮必须等于 `verdict` |

## 3. 项目差异（`reportConfig`）

渲染器不含任何项目词，项目差异全部由报告自己声明：

```json
"reportConfig": {
  "payloadLayers": ["接口层", "回调层"],
  "columnSemantics": {
    "claimStatus": { "label": "状态", "values": { "0": ["dim", "在途"], "1": ["ok", "成功"], "2": ["bad", "失败"] } }
  },
  "logHighlight": ["[XXX][SKIP]", "[XXX][FAIL]", "reason="]
}
```

| 字段 | 说明 |
|---|---|
| `payloadLayers` | 必须留 `request` / `response` 原文的层名数组；未声明时为空，不检查报文 |
| `layerFields` | 各层证据必须包含的字段，如 `{"日志层":["raw"],"数据层":["tables"]}`；缺字段由 `check-report.mjs` 报错 |
| `flowRequired` | 是否强制每条用例有 `flow`/`flowRef`，默认 `true`；设 `false` 才允许无流程图 |
| `columnSemantics` | `evidence[].tables[]` 的列语义：`label` 为表头中文名（缺省用列名），`values` 为枚举值 → `[tone, 标签]`（`tone` ∈ `ok/bad/warn/info/dim`）；未声明则原样展示 |
| `logHighlight` | 日志证据的**全局关键行匹配串**（字面子串，非正则）；命中行加粗 + 左侧色条 + 淡背景，日志过长折叠时还会提到折叠块外预览。未声明则只按日志级别着色 |

服务端项目通常声明接口层与回调层；推理管线项目可声明 `L0 契约/进程`、`L2 IR` 等。
断言实测为「未发生」（0 次 / 无行 / 不存在）时该层豁免。

### 3.1 结构化证据表格（`evidence[].tables[]`，可选）

数据库/接口返回的二维结果默认只有值、没有列名，读起来只能靠位置猜。声明 `tables` 后按表格渲染，一条证据可挂多张表：

```json
{
  "id": "ev-TC-001-db",
  "layer": "数据层",
  "command": "sql-query doris_wmt: 查询 claim 与 record",
  "result": "claim 1 行（成功）、record 1 行（成功）",
  "tables": [
    {
      "name": "cf_product_delay_distribution_claim",
      "where": "contactWa='8613800000901'",
      "sql": "SELECT id, contactWa, claimStatus, ... FROM cf_claim WHERE contactWa='8613800000901'",
      "columns": ["id", "contactWa", "claimStatus", "failReason", "updateTime"],
      "rows": [[32, "8613800000901", 1, null, "2026-11-22T17:40:06"]]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 表名（caption 显示），`rows` 为空时仍显示「0 行」 |
| `columns[]` | 是 | 列名，顺序与行值一致；命中 `columnSemantics` 时表头显示 `label` |
| `rows[][]` | 是 | 每个数组长度必须等于 `columns.length`，否则告警 `EVIDENCE_TABLE_INVALID` |
| `where` | 否 | 查询条件摘要（caption 显示） |
| `sql` | 否 | 该表的完整 SQL，收进「查看 SQL」折叠块；缺省回退到 `evidence.command` |

渲染约定：`null` 显示为灰色 `∅`（与字符串 `"null"` 区分）、数字右对齐、超过 28 字符截断并把全文放进 `title`、命中 `columnSemantics.values` 的值显示为彩色标签（`title` 保留原值）。
声明 `tables` 后 `command` 不再平铺显示，`result` 只作为表格下方的结论行——原始数组不要放 `result`。取证后表可能被后续操作改写（如重试把失败态覆盖为成功态）时，`tables` 必须用**取证时刻的快照值**并在 `raw` 保留原文，不能用事后重查的结果顶替。

> **默认自动表格（2026-11-24）**：未声明 `tables` 时，渲染器会尝试把 `raw` 解析为 JSON 数组（对象数组，或 `{columns, rows}`）并自动渲染为表格；显式 `tables` 始终优先。可用 `reportConfig.autoTables: false` 关闭自动识别，退回原文本渲染。

### 3.2 日志证据的关键行（`reportConfig.logHighlight` + `evidence[].highlight`）

用于「日志层」这类原文很长的证据：一边按日志级别着色，一边把与用例结论直接相关的行挑出来。

- **级别着色**：`raw` 中能解析出 `<时间> <LEVEL>` 头（Spring 等常见格式）的行会渲染成带级别徽章的独立行，DEBUG 灰化、INFO 正常、WARN 黄、ERROR/FATAL 红；解析不出的行原样展示。整段没有一行能解析成日志时，保持原来的 `<pre>` 渲染。该渲染对**所有**含日志头的 `raw` 生效（含未声明 `logHighlight`、未写 `flow` 的报告）；只有不含日志头的旧报告 DOM 不变。
- **关键行**：全局 `reportConfig.logHighlight` 与证据级 `evidence.highlight` 里的**字面子串**任一命中即算关键行。命中行加粗、带左侧色条与淡背景；若原文超过 3 行被折叠，命中的行会**提到折叠块外预览**，折叠标题显示「原始输出 · N 行 · 关键 M 行」。
- 全局列表放跨用例通用的判定/异常标签（如 `[XXX][SKIP]`、`[XXX][FAIL]`）；只对个别用例成立的规则（如某接口特有的成功标记）写在证据上，避免全局匹配面过宽让高亮失去区分度。

```jsonc
// reportConfig
"logHighlight": ["[延迟分发][SKIP]", "[延迟分发][FAIL]", "[延迟分发][DECIDE]"]

// 个别证据补充
{ "id": "ev-TC-011-log", "layer": "日志层", "highlight": ["removed=true"], "raw": "..." }
```

匹配是字面包含，不走正则；传非字符串数组时配置被忽略并告警 `LOG_HIGHLIGHT_INVALID`。

## 4. 测试流程（`cases[].flow` 或 `flowTemplates` + `flowRef`，可选）

把一条用例的执行链路画成流程图，并把原始证据按节点下钻。**不写 `flow` 也不写 `flowRef` 的用例不受任何影响**：
既不渲染新区块，证据仍按「取证层」分组，告警输出与改造前逐行一致。排版与形状约定见
`report-flow-design.md`；本节的字段与规则是唯一契约。

### 4.1 内联 `flow`（单次链路）

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

### 4.2 模板复用（`flowTemplates` + `cases[].flowRef`，推荐）

同一条业务链路被多条用例覆盖时，不要在每条用例里复制 `nodes` / `edges`。把链路定义一次放在报告顶层
`flowTemplates`，用例只用 `flowRef` 选择分支并挂证据。渲染器会画出**完整模板**，高亮当前分支、淡化其余路径，
让 reviewer 始终看到同一条标准链路。

```jsonc
"flowTemplates": {
  "takeover-30min": {
    "title": "30 分钟接管扫描",
    "direction": "LR",
    "nodes": [
      { "id": "start", "type": "start", "label": "调度触发" },
      { "id": "scan", "type": "service", "label": "扫描候选" },
      { "id": "db", "type": "sql", "label": "写信号", "detail": "cf_buyer_takeover_signal" },
      { "id": "end", "type": "end", "label": "已发送" }
    ],
    "edges": [
      { "from": "start", "to": "scan" },
      { "from": "scan", "to": "db" },
      { "from": "db", "to": "end" }
    ],
    "branches": {
      "p0d30-d3": {
        "label": "P0D30 · D 级 + 消息≥3",
        "nodes": ["start", "scan", "db", "end"],
        "edges": [["start", "scan"], ["scan", "db"], ["db", "end"]]
      }
    }
  }
},
"cases": [{
  "id": "TC-02",
  "flowRef": {
    "template": "takeover-30min",
    "branch": "p0d30-d3",
    "evidenceRefs": { "scan": ["ev-tc02-log"], "db": ["ev-tc02-db"] }
  }
}]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `flowTemplates.<id>.nodes` / `edges` | 是 | 与内联 `flow` 的节点/边结构相同；模板通常不挂 `evidenceRefs`，由用例挂 |
| `flowTemplates.<id>.title` / `direction` | 否 | 模板默认标题/方向 |
| `flowTemplates.<id>.branches.<id>.label` | 否 | 分支显示名，渲染在图例与标题中 |
| `flowTemplates.<id>.branches.<id>.nodes` | 否 | 当前用例经过的节点 id；与 `edges` 至少填一个 |
| `flowTemplates.<id>.branches.<id>.edges` | 否 | 当前用例经过的边；支持 `["from","to"]` 或 `{from,to}`。只填 `nodes` 时，激活两端都在 `nodes` 内的边 |
| `cases[].flowRef.template` | 是 | 模板 id；不存在触发 `FLOW_TEMPLATE_MISSING` |
| `cases[].flowRef.branch` | 否 | 分支 id；不存在触发 `FLOW_BRANCH_MISSING`，按全量模板渲染 |
| `cases[].flowRef.evidenceRefs` | 否 | `{节点 id: [证据 id...]}`；覆盖模板该节点的 `evidenceRefs`，只挂当前分支的节点 |
| `cases[].flowRef.nodeOverrides` | 否 | `{节点 id: {label?, detail?, unverified?, note?}}`；仅覆盖展示字段，不改拓扑 |
| `cases[].flowRef.title` / `direction` | 否 | 用例级标题/方向覆盖 |

解析顺序：`cases[].flow`（内联）优先；没有内联 `flow` 时才解析 `flowRef`。两者都没有的用例不受影响。
模板全量渲染，`branch` 只决定哪些节点/边高亮（`active`），非当前分支降透明度；
`FLOW_NODE_NO_EVIDENCE` 只检查当前分支的节点，`FLOW_EVIDENCE_UNBOUND` 仍按解析后的整图统计。

约定：

- **证据只经 `nodes[].evidenceRefs` 挂载**，`evidence[]` 结构不变；一条证据可被多个节点引用。
  未被任何节点引用的证据单独归入「未挂载到流程节点的证据」，不会丢失。
- **重试画前向链**，不用回边：首次回调 → 判断 → 置失败态 → 排重试 → 重试触发 → 重试回调 → 成功。
  真回边虽可渲染，但会触发 `FLOW_CYCLE_BACKEDGE` 并绕过行间通道视觉语义。
- `start`/`end`/`decision`/`missing` 天然不产生证据，不参与 `FLOW_NODE_NO_EVIDENCE` 判定。

### 证据展示（有 `flow` / `flowRef` 时）

- 节点内证据**按 `at` 升序排列**，无 `at` 的排在最后；同一节点内的多条证据因此可按时序阅读。
- 证据卡头展示 `id` + 取证层 + `at` 时刻，其下是 `keys` 业务 key 胶囊。
- `raw` 超过 3 行时折叠为「原始输出 · N 行」，点击展开；≤3 行直接展示。
- 断言表多一列「证据」：`evidenceRef` 可解析时渲染为可点击链接，点击会展开该证据所在折叠块并高亮。
- 无 `flow` / `flowRef` 的报告不产生上述任何 DOM 变化。

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
| `EVIDENCE_TABLE_INVALID` | `evidence[].tables` 不是数组，或其 `columns`/`rows` 缺失，或某行值数与列数不一致 | warn |
| `LOG_HIGHLIGHT_INVALID` | `reportConfig.logHighlight` 或 `evidence[].highlight` 不是非空字符串数组（配置被忽略） | warn |
| `CLEANUP_UNVERIFIED` | `cleanup.residual` 缺失或 `checkedItems=0` | warn |

流程相关告警**仅在用例声明了 `flow` 或 `flowRef` 时触发**，全部为 warn，按「用例 + 规则」聚合成一条：

| code | 规则 |
|---|---|
| `FLOW_EMPTY` | 声明/解析后的 `flow` 中 `nodes` 为空 |
| `FLOW_BAD_DIRECTION` | `direction` 不是 `LR`/`TB`（按 LR 渲染） |
| `FLOW_DUP_NODE_ID` | 节点 `id` 重复或为空 |
| `FLOW_NODE_UNKNOWN_TYPE` | 节点类型不在枚举内（按 `service` 渲染） |
| `FLOW_NODE_NO_EVIDENCE` | 当前分支（active）可取证类型的节点既无 `evidenceRefs` 也未标 `unverified` |
| `FLOW_EDGE_ORPHAN` | 边指向不存在的节点 |
| `FLOW_EVIDENCE_ORPHAN` | `evidenceRefs` 指向不存在的证据 id |
| `FLOW_EVIDENCE_UNBOUND` | 证据存在但未被任何节点引用（仍会展示为「未挂载」组） |
| `FLOW_IN_EDGE_MISSING` | 非 `start` 节点没有入边 |
| `FLOW_CYCLE_BACKEDGE` | 存在回边（重试应建模为前向链） |
| `FLOW_TEMPLATE_MISSING` | `flowRef.template` 指向的模板不存在 |
| `FLOW_BRANCH_MISSING` | `flowRef.branch` 指向的分支不存在（按全量模板渲染） |
| `FLOW_BRANCH_EMPTY` | 分支未声明 `nodes`/`edges`（按全量模板渲染） |
| `FLOW_BRANCH_NODE_ORPHAN` | 分支 `nodes` 引用了模板中不存在的节点 |
| `FLOW_BRANCH_EDGE_ORPHAN` | 分支 `edges` 指向模板中不存在的节点 |
| `FLOW_REF_NODE_UNKNOWN` | `flowRef.evidenceRefs` / `nodeOverrides` 的 key 不是模板节点 id |

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
