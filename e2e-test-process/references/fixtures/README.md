# 渲染器回归夹具

每份 `*-test-report.json` 是一份最小可渲染报告。改动 `render-report.mjs` 后跑一次回归：

```bash
node ~/.claude/skills/e2e-test-process/references/fixtures/run.mjs
```

该脚本对 fixtures 目录跑一遍渲染器，断言每份夹具产生的告警码集合（`FLOW_*`、`EVIDENCE_TABLE_INVALID` 等全部告警）与 `expected.json` 一致（退出码非 0 即回归失败）。新增夹具时同时登记到 `expected.json`。

| 夹具 | 覆盖 | 期望 |
|---|---|---|
| `flow-linear-test-report.json` | 线性链、接口/数据表/调度节点 | 无 `FLOW_*` |
| `flow-branch-test-report.json` | decision 双分支、分支标签 | 无 `FLOW_*` |
| `flow-retry-test-report.json` | 失败 → 置失败态 → retry → 成功前向链 | 无 `FLOW_*` |
| `flow-missing-test-report.json` | `missing` 节点（设计上不执行的分支，自动虚线） | 无 `FLOW_*` |
| `flow-longlabel-test-report.json` | 长 URL / 长英文词标签的换行边界（不越出节点） | 无 `FLOW_*` |
| `flow-backedge-test-report.json` | 真回边兜底渲染 | `FLOW_CYCLE_BACKEDGE` |
| `flow-invalid-test-report.json` | 未知类型、重复 id、孤儿边、证据孤儿、未绑定证据、无入边、非法 direction | 8 个 `FLOW_*` 告警 |
| `flow-empty-test-report.json` | 空 nodes 回退到按层分组 | `FLOW_EMPTY` |
| `table-test-report.json` | 证据 `tables[]`：列语义标签、`∅`、长值截断、空表；非法结构（缺 columns / 行值数与列数不一致 / tables 非数组） | `EVIDENCE_TABLE_INVALID` |
| `log-test-report.json` | 日志证据：级别着色、关键行提到折叠外预览、证据级 `highlight` 补充、非日志 raw 回退 `<pre>` | 无告警 |
| `log-invalid-test-report.json` | `reportConfig.logHighlight` 与 `evidence.highlight` 非字符串数组 | `LOG_HIGHLIGHT_INVALID` |

生成的 `.html` 是临时产物，已被本目录 `.gitignore` 忽略。
