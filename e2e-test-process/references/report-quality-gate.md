# 测试报告质量门禁（通用）

> 目的：把「报告看起来完成、实际缺流程图/缺证据/夹具与配置不一致」这类问题挡在提交之前。
> 本文是通用规则；层名、字段要求由项目在报告 JSON 的 `reportConfig` 中声明（见 §3）。

## 1. 两个必跑命令（S6 出口）

```bash
# 1) 通用门禁（本文件配套脚本）
node ~/.claude/skills/e2e-test-process/references/check-report.mjs <报告目录> --strict

# 2) 渲染器（有 blocker 时 --strict 退出码 1）
node ~/.claude/skills/e2e-test-process/references/render-report.mjs <报告目录> --strict
```

两个命令都退出 0 才允许提交 `-test-report.md/.json/.html`。项目可再包一层脚本，但不得放宽这两条。

## 2. 流程图（flowTemplates / flowRef）

- 同一链路被多条用例复用时，顶层定义一次 `flowTemplates.<id>`，用例只写 `flowRef: {template, branch, evidenceRefs}`；禁止逐例复制节点。
- 每条用例必须有 `flow` 或 `flowRef`（`reportConfig.flowRequired=false` 才可关闭）。
- 当前分支的节点必须满足其一：
  - 挂 `evidenceRefs` 指向本用例真实证据；或
  - 标 `unverified: true` **且** `note` 写明为什么取不到/未取。
- **能取证的步骤默认取证**：查表、接口调用、消息发送都应留下原始证据；不要为了省事标 unverified。
- 不允许伪造 payload 来消 dashed 节点。

## 3. 证据字段（由项目声明）

报告顶层声明：

```json
"reportConfig": {
  "payloadLayers": ["接口层", "回调层"],
  "layerFields": { "日志层": ["raw"], "数据层": ["tables"] },
  "flowRequired": true
}
```

| 配置 | 含义 | 门禁行为 |
|---|---|---|
| `payloadLayers` | 必须留报文的层（接口/回调等） | 该层至少一条证据同时含 `request` 与 `response`，否则报错 |
| `layerFields` | 各层证据必须包含的字段（数组字段需非空） | 缺字段报错 |
| `flowRequired` | 是否强制每条用例有流程图 | 默认 true |

通用建议：接口层 `request`+`response`；日志层 `raw`（原文）+`highlight`；数据层 `tables`（列名+行值）+`keys`；所有证据给 `at`（时刻/时间窗）。

## 4. 断言

- 每条断言必须写「预期 + 实测」（`expected` / `actual`），并标明取证 `layer`；`matches` 为布尔。
- 不允许只写「通过/符合预期」。
- FAIL 必须给出失败层与关联缺陷。

## 5. 测试数据与配置的一致性

- 夹具的初始值必须与需求/配置**相关**（例如衰减策略表第 0 行 `20/40/40/40`），不能随手填。
- 有意偏离（如验证反向抬高）必须在数据台账 `-test-data.md` 登记原因。
- 数据证据里的「处理前 → 处理后」要能对上需求/配置的两行/两档。
- 造数后立即按同一组键检索一次；清理后回查影响行数。

## 6. 清理与结论

- `cleanup.checkedItems` 为正数、`cleanup.residual` 为数字；无删除权限时保留并登记。
- 结论三选一（可发布 / 有条件发布 / 不可发布）；有未覆盖项时必须列条件。

## 7. 自检清单

- [ ] `check-report.mjs --strict` 退出 0
- [ ] `render-report.mjs --strict` 退出 0（或仅有已评估的 warn）
- [ ] 每条用例有 flow/flowRef；active 节点有证据或 `unverified`+`note`
- [ ] `reportConfig.payloadLayers` / `layerFields` 已声明且证据满足
- [ ] 断言全部是「预期 + 实测」
- [ ] 夹具初始值与需求/配置一致，偏离已登记
- [ ] 清理回查数字齐全，保留数据已登记
- [ ] md 的「测试流程」与 JSON 的 flow/flowRef 一一对应
