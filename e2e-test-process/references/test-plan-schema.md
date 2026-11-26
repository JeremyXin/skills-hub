# 测试执行 Plan（DAG）规范 v1

> Plan-first：每个用例先声明一份可执行的 DAG，执行器按节点执行并记录证据，报告由 plan + run 记录生成。
> 本文是**公共规范**；项目通过「适配器」提供 sql-query / http / 日志检索等具体能力。

## 1. 文件

单文件 `-test-plan.json`（与 `-test-blueprint.md`、`-test-case.md` 同目录）：

```jsonc
{
  "schemaVersion": 1,
  "variables": { "base": "http://...", "baseline": "2026-11-26 02:00:00" },
  "cases": [ { /* 见 §3 */ } ]
}
```

- `variables`：全局变量；case 内 `vars` 覆盖同名变量。
- 模板替换：字符串中的 `${name}` 在执行前解析（SQL / URL / body / 断言值均可）。

## 2. 用例结构

```jsonc
{
  "id": "TC-001",
  "title": "私有有效号 25h → 1 天并回调",
  "priority": "P0",
  "requirements": ["REQ-03-A"],
  "requirementStatement": "25h 前买家消息应得到 inactiveDays=1 并写回 15 分",
  "vars": { "buyer": "8613800000961", "dist": 9900000061 },
  "fixtures": [ { "action": "sql.exec", "datasource": "...", "sql": "INSERT ..." } ],
  "nodes": [ { /* §3 */ } ],
  "edges": [ ["fixture", "scan"], ["scan", "active"] ],
  "cleanup": [ { "action": "sql.exec", "datasource": "...", "sql": "DELETE ..." } ],
  "notCovered": [ "说明本用例不验证什么" ]
}
```

`fixtures` 在节点前执行，`cleanup` 在用例结束（含失败）时执行。

## 3. 节点

```jsonc
{
  "id": "scan",
  "type": "sql",                 // start/end/http/sql/service/decision/callback/config/log/metric/mq/missing
  "label": "扫描待衰减行",
  "detail": "buyer_latent_buyer_label · timeScore != 0",
  "action": "sql.query",         // sql.exec / sql.query / http.post / log.fetch
  "datasource": "doris_wmt",
  "sql": "SELECT ... WHERE contactWa='${buyer}'",
  "expect": { "rowCount": 1, "firstRow.timeScore": 40 },
  "evidence": { "layer": "数据层", "capture": "tables" },
  "optional": true               // 可选：取不到证据时记 unverified，不判 FAIL
}
```

- `action`：
  - `sql.exec` → 执行写/删/改，断言通常用 `affected`
  - `sql.query` → 查询，结果为 `{columns, rows, rowCount}`
  - `http.post` → `{url, body, headers?}`，结果为 `{status, json, requestBody}`
  - `log.fetch` → `{source: console|doris, keyword, since?, until?, limit?}`，结果为 `{lines, raw, available}`
- `expect`（v1）：`rowCount` / `affected` / `firstRow.<列>` / `json.<点路径>` / `status` / `contains`。任一不满足 → 节点 FAIL；`optional` 节点取不到证据时记 UNVERIFIED。
- `evidence.capture`：`tables`（SQL）/ `request,response`（HTTP）/ `raw`（日志）。生成器据此产出报告证据，避免事后补。
- `edges`：拓扑排序；前驱 FAIL/BLOCKED 时后继记 BLOCKED。
- 每个非 `start/end/decision` 节点必须有 `evidence`；`optional` 节点必须有说明。

## 4. 执行记录 `-test-run.json`

执行器输出（供报告生成器消费）：

```jsonc
{
  "schemaVersion": 1,
  "plan": "path", "env": "test", "startedAt": "...", "finishedAt": "...",
  "cases": [{
    "id": "TC-001", "status": "PASS",
    "fixtures": [{ "status": "PASS", "command": "...", "affected": 2 }],
    "nodes": [{
      "id": "scan", "status": "PASS",
      "actual": { "rowCount": 1, "firstRow": { "timeScore": 40 } },
      "command": "sql-query ...", "at": "16:54:52",
      "checks": [{ "key": "rowCount", "expected": 1, "actual": 1, "ok": true }],
      "evidence": { "layer": "数据层", "tables": [...] }
    }],
    "cleanup": [{ "status": "PASS", "affected": 10 }],
    "notes": ["log 节点 unverified: 归档延迟"]
  }]
}
```

## 5. 执行器 / 适配器契约

公共执行器 `e2e-runner.mjs` 负责：变量解析、拓扑排序、节点调度、断言、证据组装、run 记录。
项目适配器（`--adapter <file>`）导出：

```js
export async function sqlExec(ctx, { datasource, sql }) // -> { ok, affected, command }
export async function sqlQuery(ctx, { datasource, sql }) // -> { columns, rows, rowCount, command }
export async function httpRequest(ctx, { method, url, body, headers }) // -> { status, json, requestBody, command }
export async function fetchLog(ctx, { source, keyword, since, until, limit }) // -> { lines, raw, available, command }
```

`ctx = { projectRoot, env, workspace }`。适配器只做「怎么连库/怎么发请求/怎么取日志」，不做断言与证据格式化。

## 6. 报告生成

`e2e-report.mjs` 读取 plan + run：
- `cases[].flow` 只包含该用例的节点与边（自动补 start/end）；
- `cases[].evidence` 来自 run 的节点证据；
- `cases[].assertions` 来自节点 checks（预期+实测+matches）；
- 失败节点生成 `failureAnalysis`；optional 未取证节点标 `unverified` + note；
- 生成 `-test-report.md/.json` 后调用 `render-report.mjs`。

共享模板（`flowTemplates`）仅可在**编写 plan 时**参考，不参与渲染。

## 7. 门禁

- plan 校验：节点 id 唯一、`edges` 引用存在、每个非 start/end/decision 节点有 `action`/`expect`/`evidence`、变量可解析。
- 报告仍过 `check-report.mjs --strict` 与 `render-report.mjs --strict`。
