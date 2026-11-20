#!/usr/bin/env node
/**
 * E2E 测试报告可视化渲染器
 *
 * 用法：
 *   node ~/.claude/skills/e2e-test-process/references/render-report.mjs <报告目录> [--strict]
 *
 * 读取目录下所有 *-test-report.json，生成同名 .html。
 * --strict：存在 blocker 级告警时以退出码 1 结束（可作为提交前门禁）。
 *
 * 项目差异通过报告 JSON 顶层 reportConfig 声明，渲染器本身不含任何项目词：
 *   "reportConfig": { "payloadLayers": ["<层名1>", "<层名2>"] }
 * payloadLayers：必须留 request/response 报文的层，层名由项目 skill 定义；未声明则不检查。
 *
 * 约束：
 * - Markdown 是事实源，JSON 与 HTML 都是派生物；HTML 不得手工编辑。
 * - 零第三方依赖，产物自包含（CSS/JS 内联，无 CDN）。
 * - 证据原文（command/result/raw/implementation）原样转义，不解析行内 Markdown。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const PLACEHOLDERS = new Set(['', '-', '—', 'n/a', 'todo', 'null', 'undefined', 'tbd']);

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 只放行相对路径、锚点与 http(s)；其余协议替换为 #。 */
function safeHref(h) {
  const s = String(h == null ? '' : h).trim();
  if (!s) return '#';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  return scheme && !/^https?$/i.test(scheme[1]) ? '#' : s;
}

/** 极简行内 Markdown：**粗体** / `code` / [label](href)。输入先转义。 */
function inlineMd(s) {
  if (s == null || s === '') return '';
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${safeHref(href)}">${label}</a>`);
}

function isBlankActual(v) {
  return PLACEHOLDERS.has(String(v == null ? '' : v).trim().toLowerCase());
}

/** 「未发生」类实测值：0 / false / 无行 / 不存在。这类断言本身不产生报文。 */
function isAbsentActual(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^(0|false|null)$/i.test(s)) return true;
  return /^0\s*[次条行个]/.test(s) || /无行|不存在|未发生/.test(s);
}

// ---------------------------------------------------------------- 完整性校验

function verify(report) {
  const alarms = [];
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const reqs = Array.isArray(report.requirements) ? report.requirements : [];
  const add = (code, severity, message, caseIds = []) =>
    alarms.push({ code, severity, message, cases: caseIds });

  // 1. 用例级：断言完整性
  for (const c of cases) {
    const assertions = Array.isArray(c.assertions) ? c.assertions : [];
    if (c.verdict === 'PASS' && assertions.length === 0) {
      add('PASS_NO_ASSERTION', 'blocker', `${c.id} 判为 PASS，但没有任何断言`, [c.id]);
    }
    if (c.verdict === 'PASS') {
      const bad = assertions.filter((a) => a.matches !== true);
      if (bad.length) {
        add('PASS_ASSERTION_FAILED', 'blocker',
          `${c.id} 判为 PASS，但有 ${bad.length} 条断言未标记为匹配`, [c.id]);
      }
    }
    const blanks = assertions.filter((a) => isBlankActual(a.actual));
    if (blanks.length) {
      add('ASSERTION_NO_ACTUAL', 'blocker',
        `${c.id} 有 ${blanks.length} 条断言缺少实测值`, [c.id]);
    }
    if (c.verdict === 'FAIL' && !c.failureAnalysis) {
      add('FAIL_NO_ANALYSIS', 'warn', `${c.id} 判为 FAIL，但没有失败分析`, [c.id]);
    }

    // 2. 取证层覆盖
    const layers = Array.isArray(c.layers) ? c.layers : [];
    const seen = new Set();
    for (const a of assertions) if (a.layer) seen.add(a.layer);
    for (const e of c.evidence || []) if (e.layer) seen.add(e.layer);
    const missing = layers.filter((l) => !seen.has(l));
    if (missing.length) {
      add('LAYER_NO_EVIDENCE', 'warn',
        `${c.id} 声明了 ${missing.join('、')}，但没有对应断言或证据`, [c.id]);
    }

    // 3. 证据引用
    const evIds = new Set((c.evidence || []).map((e) => e.id));
    for (const a of assertions) {
      if (a.evidenceRef && !evIds.has(a.evidenceRef)) {
        add('EVIDENCE_ORPHAN', 'warn',
          `${c.id} 的断言引用了不存在的证据 ${a.evidenceRef}`, [c.id]);
      }
    }

    // 4. 多轮历史
    if (Array.isArray(c.history) && c.history.length) {
      const last = c.history[c.history.length - 1];
      if (last.verdict !== c.verdict) {
        add('HISTORY_FINAL_MISMATCH', 'blocker',
          `${c.id} 最后一轮为 ${last.verdict}，但用例结论是 ${c.verdict}`, [c.id]);
      }
    }
  }

  // 5. 项目声明的报文层必须留下报文原文（review 时唯一能核对「发了什么」的依据）
  //    reportConfig.payloadLayers 由项目 skill 声明（层名由项目定义）；未声明则不检查
  const payloadLayers = Array.isArray(report.reportConfig?.payloadLayers)
    ? report.reportConfig.payloadLayers
    : [];
  for (const layer of payloadLayers) {
    const lacking = cases.filter((c) => {
      if (!(c.layers || []).includes(layer)) return false;
      const layerAssertions = (c.assertions || []).filter((a) => a.layer === layer);
      // 「0 次回调」「无越权调用」这类未发生的断言本身没有报文可留
      if (layerAssertions.length && layerAssertions.every((a) => isAbsentActual(a.actual))) return false;
      const evs = (c.evidence || []).filter((e) => e.layer === layer);
      return !evs.some((e) => e.request != null || e.response != null);
    });
    if (lacking.length) {
      add('EVIDENCE_NO_PAYLOAD', 'warn',
        `${lacking.length} 条用例的${layer}证据未记录请求/响应报文：${lacking.map((c) => c.id).join('、')}`,
        lacking.map((c) => c.id));
    }
  }

  // 6. 统计表与实际用例计数
  const actual = new Map();
  for (const c of cases) {
    const key = c.priority || '未标';
    if (!actual.has(key)) actual.set(key, { total: 0, pass: 0, fail: 0, blocked: 0 });
    const row = actual.get(key);
    row.total += 1;
    if (c.verdict === 'PASS') row.pass += 1;
    else if (c.verdict === 'FAIL') row.fail += 1;
    else if (c.verdict === 'BLOCKED') row.blocked += 1;
  }
  const stated = new Map();
  for (const row of report.stats?.byPriority || []) stated.set(row.priority, row);

  for (const [priority, a] of actual) {
    const s = stated.get(priority);
    if (!s) {
      add('STAT_MISMATCH', 'blocker', `统计表缺少 ${priority} 优先级`, []);
      continue;
    }
    if (a.blocked > 0 && s.blocked === 0) {
      add('BLOCKED_COUNTED_AS_PASS', 'blocker',
        `${priority} 有 ${a.blocked} 条 BLOCKED，但统计表记为 0`, []);
    }
    const fields = ['total', 'pass', 'fail'];
    if (!(a.blocked > 0 && s.blocked === 0)) fields.push('blocked');
    const diff = fields.filter((f) => a[f] !== s[f]);
    if (diff.length) {
      add('STAT_MISMATCH', 'blocker',
        `${priority} 统计与实际不一致：${diff.map((f) => `${f} 记 ${s[f]} / 实 ${a[f]}`).join('，')}`, []);
    }
  }
  for (const [priority] of stated) {
    if (!actual.has(priority)) {
      add('STAT_MISMATCH', 'blocker', `统计表有 ${priority}，但没有对应用例`, []);
    }
  }

  // 6. 需求覆盖
  for (const r of reqs) {
    const linked = cases.filter((c) => (c.requirements || []).includes(r.id));
    if (!linked.length) {
      add('REQ_NO_CASE', 'warn', `${r.id} 没有任何用例`, []);
      continue;
    }
    if (!linked.some((c) => (c.assertions || []).length > 0)) {
      add('REQ_NO_ASSERTION', 'blocker', `${r.id} 关联的用例全部没有断言`, linked.map((c) => c.id));
    }
  }

  // 7. 清理与结论自洽
  const cleanup = report.cleanup || {};
  if (!Number.isFinite(cleanup.residual) || !(cleanup.checkedItems > 0)) {
    add('CLEANUP_UNVERIFIED', 'warn', '清理结果未给出回查项数或残留值', []);
  }
  const hasGaps = cases.some((c) => c.verdict === 'BLOCKED') || (report.notCovered || []).length > 0;
  if (report.verdict?.publishable === true && hasGaps) {
    add('PUBLISHABLE_WITH_GAPS', 'warn',
      '结论标记为可发布，但存在 BLOCKED 或未覆盖项', []);
  }

  return alarms;
}

// ---------------------------------------------------------------- 页面

function renderHtml(report, alarms, sourceName) {
  const payload = JSON.stringify({ report, alarms }).replace(/</g, '\\u003c');
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const title = `${report.requirement || '测试报告'} · 测试报告`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="generator" content="render-report.mjs" />
<meta name="report-source" content="${esc(sourceName)}" />
<meta name="generated-at" content="${generatedAt}" />
<style>
  :root {
    --bg: #f8fafc; --panel: #ffffff; --panel-2: #f1f5f9; --ink: #0f172a; --ink-2: #334155;
    --muted: #64748b; --dim: #94a3b8; --border: #e2e8f0; --border-strong: #cbd5e1;
    --ok: #16a34a; --ok-bg: #f0fdf4; --warn: #b45309; --warn-bg: #fffbeb;
    --bad: #dc2626; --bad-bg: #fef2f2; --info: #0369a1; --info-bg: #f0f9ff;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  }
  html[data-theme="dark"] {
    --bg: #020617; --panel: #0f172a; --panel-2: #111c33; --ink: #f8fafc; --ink-2: #cbd5e1;
    --muted: #94a3b8; --dim: #64748b; --border: #1e293b; --border-strong: #334155;
    --ok: #4ade80; --ok-bg: #052e16; --warn: #fbbf24; --warn-bg: #2a1f06;
    --bad: #f87171; --bad-bg: #2a0e0e; --info: #38bdf8; --info-bg: #082f49;
  }
  @media (prefers-color-scheme: dark) {
    html[data-theme="auto"] {
      --bg: #020617; --panel: #0f172a; --panel-2: #111c33; --ink: #f8fafc; --ink-2: #cbd5e1;
      --muted: #94a3b8; --dim: #64748b; --border: #1e293b; --border-strong: #334155;
      --ok: #4ade80; --ok-bg: #052e16; --warn: #fbbf24; --warn-bg: #2a1f06;
      --bad: #f87171; --bad-bg: #2a0e0e; --info: #38bdf8; --info-bg: #082f49;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 14px; line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  button { font-family: inherit; }
  code, .mono { font-family: var(--mono); font-size: 12px; }
  .wrap { max-width: 1320px; margin: 0 auto; padding: 20px 26px 90px; }

  /* header */
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .16em; color: var(--info); text-transform: uppercase; }
  h1 { font-size: 23px; margin: 6px 0 6px; letter-spacing: -.01em; }
  .meta { color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .meta b { color: var(--ink-2); font-weight: 600; }
  .verdict-line { display: flex; align-items: baseline; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
  .verdict-line .summary { color: var(--ink-2); font-size: 14px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--muted); }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-bg); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: var(--warn-bg); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: var(--bad-bg); }
  .pill.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 45%, transparent); background: var(--info-bg); }

  /* alert bar */
  .alerts { margin: 16px 0 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  .alert {
    display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 9px;
    font-size: 12.5px; cursor: pointer; border: 1px solid; background: transparent; text-align: left;
  }
  .alert.blocker { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: var(--bad-bg); }
  .alert.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: var(--warn-bg); }
  .alert:hover { filter: brightness(1.06); }
  .alert .n { font-family: var(--mono); font-size: 11px; opacity: .8; }
  .alerts-clear { color: var(--ok); background: var(--ok-bg); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); border-radius: 9px; padding: 6px 12px; font-size: 12.5px; }

  /* toolbar */
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .tabs button { border: 1px solid transparent; background: transparent; color: var(--muted); padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; }
  .tabs button:hover { color: var(--ink); background: var(--panel-2); }
  .tabs button.on { color: var(--ink); background: var(--panel); border-color: var(--border-strong); font-weight: 600; }
  .tabs button .c { font-family: var(--mono); font-size: 10.5px; color: var(--dim); margin-left: 5px; }
  .spacer { flex: 1; }
  .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 5px 10px; }
  .search input { border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 13px; width: 210px; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); cursor: pointer; user-select: none; }
  .icon-btn { border: 1px solid var(--border); background: var(--panel); color: var(--muted); border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12.5px; }
  .icon-btn:hover { color: var(--ink); }

  /* cases layout */
  .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 18px; margin-top: 16px; }
  .side { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 8px; max-height: calc(100vh - 210px); overflow: auto; position: sticky; top: 12px; align-self: start; }
  .req-group { margin-bottom: 8px; }
  .req-title { font-size: 10.5px; letter-spacing: .08em; color: var(--dim); padding: 6px 8px 4px; text-transform: uppercase; display: flex; gap: 6px; align-items: center; }
  .req-title .rid { font-family: var(--mono); color: var(--muted); }
  .nav-item { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
  .nav-item:hover { background: var(--panel-2); }
  .nav-item.on { background: var(--info-bg); outline: 1px solid color-mix(in srgb, var(--info) 35%, transparent); }
  .dot { width: 7px; height: 7px; border-radius: 99px; flex: none; background: var(--dim); }
  .dot.pass { background: var(--ok); } .dot.fail { background: var(--bad); } .dot.blocked { background: var(--muted); }
  .nav-item .tid { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); flex: none; }
  .nav-item .tt { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nav-item .pr { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--dim); flex: none; }
  .nav-item .warn-dot { color: var(--warn); font-size: 11px; flex: none; }
  .nav-item .bad-dot { color: var(--bad); font-size: 11px; flex: none; }

  .main { min-width: 0; }
  .card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
  .case-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  .case-head h2 { font-size: 18px; margin: 0; }
  .section-label { font-size: 11px; letter-spacing: .1em; color: var(--dim); text-transform: uppercase; margin-bottom: 6px; }
  .req-box { background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; color: var(--ink-2); font-size: 13px; }
  .req-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

  table.assert { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.assert th { text-align: left; font-size: 11px; letter-spacing: .06em; color: var(--dim); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; }
  table.assert td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.assert tr.bad { background: var(--bad-bg); }
  table.assert tr.bad td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
  .layer-tag { font-family: var(--mono); font-size: 10.5px; color: var(--muted); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
  .mark { font-family: var(--mono); font-size: 12px; }
  .mark.ok { color: var(--ok); } .mark.bad { color: var(--bad); }

  .gaps { list-style: none; padding: 0; margin: 0; }
  .gaps li { border-left: 3px solid var(--bad); background: var(--bad-bg); color: var(--bad); padding: 6px 10px; border-radius: 0 6px 6px 0; margin-bottom: 6px; font-size: 12.5px; }

  details.ev { border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; margin-bottom: 8px; background: var(--panel); }
  details.ev summary { cursor: pointer; font-size: 12.5px; color: var(--ink-2); }
  details.ev pre { background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px; padding: 9px 11px; overflow: auto; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }
  details.ev .payload-label { font-size: 10.5px; letter-spacing: .1em; color: var(--dim); margin-top: 10px; }

  .timeline { list-style: none; padding: 0; margin: 0; }
  .timeline li { display: grid; grid-template-columns: 54px 160px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
  .timeline li:last-child { border-bottom: 0; }
  .timeline .round { font-family: var(--mono); color: var(--muted); }
  .timeline .when { color: var(--dim); }
  .empty { color: var(--dim); font-size: 13px; padding: 10px 0; }
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; font-size: 13px; }
  .kv .k { color: var(--muted); }
  .table-simple { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table-simple th { text-align: left; font-size: 11px; color: var(--dim); padding: 6px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: .06em; }
  .table-simple td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .foot { margin-top: 26px; color: var(--dim); font-size: 11.5px; display: flex; gap: 14px; flex-wrap: wrap; }
  kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted); }
  @media (max-width: 920px) { .layout { grid-template-columns: 1fr; } .side { position: static; max-height: 320px; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">E2E · 测试报告核对</div>
  <h1 id="page-title"></h1>
  <div class="meta" id="page-meta"></div>
  <div class="verdict-line" id="page-verdict"></div>
  <div class="alerts" id="alerts"></div>

  <div class="toolbar">
    <div class="tabs" id="tabs"></div>
    <div class="spacer"></div>
    <label class="search"><span style="color:var(--dim)">⌕</span><input id="search" placeholder="搜索 TC / 标题 / 需求（/ 聚焦）" /></label>
    <label class="toggle"><input type="checkbox" id="alerts-only" /> 只看告警</label>
    <button class="icon-btn" id="theme">切换主题</button>
  </div>

  <div id="content"></div>

  <div class="foot">
    <span>由 <code>render-report.mjs</code> 生成，勿手工编辑 · schema v<span id="schema-v"></span></span>
    <span>短键：<kbd>j</kbd>/<kbd>k</kbd> 切换用例 · <kbd>/</kbd> 搜索 · <kbd>Esc</kbd> 清空</span>
    <span id="generated-at"></span>
  </div>
</div>

<script id="report-data" type="application/json">${payload}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('report-data').textContent);
  var REPORT = DATA.report, ALARMS = DATA.alarms;
  var CASES = REPORT.cases || [];
  var REQS = REPORT.requirements || [];
  var REQ_BY_ID = {};
  REQS.forEach(function (r) { REQ_BY_ID[r.id] = r; });

  var state = { view: 'cases', selected: CASES.length ? CASES[0].id : null, query: '', alertsOnly: false, theme: 'auto' };

  // ---------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function payloadText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (err) { return String(v); }
  }
  function inlineMd(s) {
    if (s == null || s === '') return '';
    return esc(s)
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
      .replace(/[\x60]([^\x60]+)[\x60]/g, '<code>$1</code>')
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (_m, label, href) {
        var ok = /^(https?:|#|\\/|\\.)/i.test(href.trim());
        return '<a href="' + (ok ? esc(href) : '#') + '">' + label + '</a>';
      });
  }
  function verdictPill(v) {
    var tone = v === 'PASS' ? 'ok' : v === 'FAIL' ? 'bad' : '';
    return '<span class="pill ' + tone + '">' + esc(v) + '</span>';
  }
  function dot(v) { return '<span class="dot ' + (v === 'PASS' ? 'pass' : v === 'FAIL' ? 'fail' : 'blocked') + '"></span>'; }

  function caseAlarms(id) {
    return ALARMS.filter(function (a) { return (a.cases || []).indexOf(id) >= 0; });
  }
  function hasBlocker(id) { return caseAlarms(id).some(function (a) { return a.severity === 'blocker'; }); }
  function hasWarn(id) { return caseAlarms(id).length > 0 && !hasBlocker(id); }

  function filteredCases() {
    var q = state.query.trim().toLowerCase();
    return CASES.filter(function (c) {
      if (state.alertsOnly && caseAlarms(c.id).length === 0) return false;
      if (!q) return true;
      var reqTitles = (c.requirements || []).map(function (r) { return (REQ_BY_ID[r] && REQ_BY_ID[r].title) || r; }).join(' ');
      return (c.id + ' ' + c.title + ' ' + reqTitles + ' ' + (c.requirementStatement || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  // ---------- header + alerts
  function renderHeader() {
    document.getElementById('page-title').textContent = REPORT.requirement + ' · ' + (REPORT.env || '') + ' 测试报告';
    var m = REPORT.meta || {};
    var bits = [];
    if (m.branch) bits.push('<span><b>分支</b> ' + esc(m.branch) + '</span>');
    if (m.commit) bits.push('<span><b>commit</b> ' + esc(m.commit) + '</span>');
    if (m.carrier) bits.push('<span><b>载体</b> ' + esc(m.carrier) + '</span>');
    if (m.executedAt) bits.push('<span><b>执行</b> ' + esc(m.executedAt) + '</span>');
    if (m.executor) bits.push('<span><b>执行人</b> ' + esc(m.executor) + '</span>');
    document.getElementById('page-meta').innerHTML = bits.join('');
    var v = REPORT.verdict || {};
    var counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
    CASES.forEach(function (c) { counts[c.verdict] = (counts[c.verdict] || 0) + 1; });
    document.getElementById('page-verdict').innerHTML =
      '<span class="pill ' + (v.publishable ? 'ok' : 'bad') + '">' + (v.publishable ? '可发布' : '不可发布') + '</span>' +
      '<span class="summary">' + inlineMd(v.summary || '') + '</span>' +
      '<span class="pill info">' + counts.PASS + ' PASS</span>' +
      (counts.FAIL ? '<span class="pill bad">' + counts.FAIL + ' FAIL</span>' : '') +
      (counts.BLOCKED ? '<span class="pill">' + counts.BLOCKED + ' BLOCKED</span>' : '') +
      (v.conditions && v.conditions.length ? '<span class="pill warn">' + v.conditions.length + ' 项前置条件</span>' : '');
  }

  function renderAlerts() {
    var host = document.getElementById('alerts');
    if (!ALARMS.length) {
      var assertions = CASES.reduce(function (n, c) { return n + (c.assertions || []).length; }, 0);
      host.innerHTML = '<div class="alerts-clear">✓ 完整性校验全部通过：' + CASES.length + ' 条用例 · ' + assertions + ' 条断言 · ' + REQS.length + ' 个 REQ</div>';
      return;
    }
    var blockers = ALARMS.filter(function (a) { return a.severity === 'blocker'; }).length;
    var warns = ALARMS.length - blockers;
    var html = '';
    if (blockers) html += '<span class="pill bad">' + blockers + ' blocker</span>';
    if (warns) html += '<span class="pill warn">' + warns + ' warn</span>';
    html += ALARMS.map(function (a, i) {
      return '<button class="alert ' + a.severity + '" data-alarm="' + i + '" title="' + esc(a.code) + '">' +
        (a.severity === 'blocker' ? '✕' : '⚠') + ' ' + esc(a.message) + '<span class="n">' + esc(a.code) + '</span></button>';
    }).join('');
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll('[data-alarm]'), function (btn) {
      btn.addEventListener('click', function () {
        var a = ALARMS[Number(btn.getAttribute('data-alarm'))];
        if (a.cases && a.cases.length) {
          state.view = 'cases'; state.selected = a.cases[0]; state.query = ''; state.alertsOnly = false;
          document.getElementById('search').value = '';
          document.getElementById('alerts-only').checked = false;
          render();
          var el = document.querySelector('.nav-item.on');
          if (el) el.scrollIntoView({ block: 'nearest' });
        }
      });
    });
  }

  // ---------- tabs
  var VIEWS = [
    { id: 'cases', label: '证据链', count: CASES.length },
    { id: 'defects', label: '缺陷', count: (REPORT.defects || []).length },
    { id: 'gaps', label: '未覆盖', count: (REPORT.notCovered || []).length },
    { id: 'cleanup', label: '清理', count: null },
    { id: 'history', label: '执行历史', count: (REPORT.executionHistory || []).length }
  ];
  function renderTabs() {
    document.getElementById('tabs').innerHTML = VIEWS.map(function (v) {
      return '<button data-view="' + v.id + '" class="' + (state.view === v.id ? 'on' : '') + '">' +
        v.label + (v.count != null ? '<span class="c">' + v.count + '</span>' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () { state.view = b.getAttribute('data-view'); syncHash(); render(); });
    });
  }

  // ---------- nav
  function renderNav() {
    var list = filteredCases();
    var groups = [];
    REQS.forEach(function (r) {
      var items = list.filter(function (c) { return (c.requirements || [])[0] === r.id; });
      if (items.length) groups.push({ req: r, items: items });
    });
    var orphans = list.filter(function (c) { return !REQ_BY_ID[(c.requirements || [])[0]]; });
    if (orphans.length) groups.push({ req: { id: '其他', title: '未关联需求' }, items: orphans });

    return '<div class="side" role="navigation">' + groups.map(function (g) {
      return '<div class="req-group"><div class="req-title"><span class="rid">' + esc(g.req.id) + '</span><span>' + inlineMd(g.req.title || '') + '</span></div>' +
        g.items.map(function (c) {
          var mark = hasBlocker(c.id) ? '<span class="bad-dot" title="有 blocker 告警">✕</span>'
            : hasWarn(c.id) ? '<span class="warn-dot" title="有告警">⚠</span>' : '';
          return '<div class="nav-item ' + (state.selected === c.id ? 'on' : '') + '" data-case="' + esc(c.id) + '">' +
            dot(c.verdict) + '<span class="tid">' + esc(c.id) + '</span>' +
            '<span class="tt">' + inlineMd(c.title) + '</span>' + mark +
            '<span class="pr">' + esc(c.priority || '') + '</span></div>';
        }).join('') + '</div>';
    }).join('') + (list.length ? '' : '<div class="empty">没有匹配的用例</div>') + '</div>';
  }

  // ---------- detail
  function renderDetail() {
    var c = CASES.filter(function (x) { return x.id === state.selected; })[0];
    if (!c) return '<div class="card"><div class="empty">请选择左侧用例</div></div>';
    var html = '<div class="card">';
    html += '<div class="case-head"><h2>' + esc(c.id) + '</h2>' + verdictPill(c.verdict) +
      (c.priority ? '<span class="pill">' + esc(c.priority) + '</span>' : '') +
      (c.history && c.history.length > 1 ? '<span class="pill warn">' + c.history.length + ' 轮</span>' : '') +
      '</div><div style="color:var(--muted);font-size:13px;margin-bottom:14px">' + inlineMd(c.title) + '</div>';

    if (c.requirementStatement) {
      html += '<div class="section-label">需求口径</div><div class="req-box">' + inlineMd(c.requirementStatement) +
        '<div class="req-chips">' + (c.requirements || []).map(function (r) {
          return '<span class="pill info">' + esc(r) + (REQ_BY_ID[r] ? ' · ' + inlineMd(REQ_BY_ID[r].title) : '') + '</span>';
        }).join('') + '</div></div>';
    }
    if (c.implementation) {
      html += '<div style="margin-top:10px;font-size:12px;color:var(--dim)">实现：<code>' + esc(c.implementation) + '</code></div>';
    }

    // assertions
    var as = c.assertions || [];
    html += '<div class="section-label" style="margin-top:16px">断言对照 · ' + as.length + ' 条</div>';
    if (!as.length) {
      html += '<div class="empty">没有断言——PASS 却无断言会被判为 blocker。</div>';
    } else {
      html += '<table class="assert"><thead><tr><th style="width:38%">预期断言</th><th style="width:34%">实测</th><th style="width:16%">取证层</th><th style="width:12%">匹配</th></tr></thead><tbody>' +
        as.map(function (a) {
          var bad = a.matches !== true || !String(a.actual || '').trim();
          return '<tr class="' + (bad ? 'bad' : '') + '"><td>' + inlineMd(a.expected) + '</td><td class="mono">' + inlineMd(a.actual) +
            '</td><td><span class="layer-tag">' + esc(a.layer || '—') + '</span></td><td class="mark ' + (bad ? 'bad' : 'ok') + '">' +
            (bad ? '✕ 不一致' : '✓ 一致') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    // gaps
    if (c.gaps && c.gaps.length) {
      html += '<div class="section-label" style="margin-top:16px">已知缺口</div><ul class="gaps">' +
        c.gaps.map(function (g) { return '<li>' + inlineMd(g) + '</li>'; }).join('') + '</ul>';
    }
    // failure analysis
    if (c.failureAnalysis) {
      var fa = c.failureAnalysis;
      html += '<div class="section-label" style="margin-top:16px">失败分析</div><div class="req-box">' + inlineMd(fa.analysis || '') +
        '<div class="kv" style="margin-top:6px"><span class="k">失败层</span><span>' + esc(fa.layer || '—') + '</span>' +
        '<span class="k">预期</span><span class="mono">' + esc(fa.expected || '') + '</span>' +
        '<span class="k">实际</span><span class="mono">' + esc(fa.actual || '') + '</span></div></div>';
    }

    // evidence
    var evs = c.evidence || [];
    if (evs.length) {
      var byLayer = {};
      evs.forEach(function (e) { (byLayer[e.layer || '其他'] = byLayer[e.layer || '其他'] || []).push(e); });
      html += '<div class="section-label" style="margin-top:18px">原始证据 · ' + evs.length + ' 项</div>';
      Object.keys(byLayer).forEach(function (layer) {
        html += '<details class="ev"><summary>' + esc(layer) + ' · ' + byLayer[layer].length + ' 项</summary>';
        html += byLayer[layer].map(function (e) {
          var body = '';
          var req = payloadText(e.request), res = payloadText(e.response);
          if (req) body += '<div class="payload-label">请求</div><pre>' + esc(req) + '</pre>';
          if (res) body += '<div class="payload-label">响应</div><pre>' + esc(res) + '</pre>';
          if (e.command) body += '<pre>' + esc(e.command) + '</pre>';
          if (e.result) body += '<pre>' + esc(e.result) + '</pre>';
          if (e.raw) body += '<pre>' + esc(e.raw) + '</pre>';
          return body;
        }).join('');
        html += '</details>';
      });
    }

    // history
    if (c.history && c.history.length) {
      html += '<div class="section-label" style="margin-top:16px">用例执行历史</div><ul class="timeline">' +
        c.history.map(function (h) {
          return '<li><span class="round">R' + esc(h.round) + '</span><span class="when">' + esc(h.time || '') + '</span><span>' +
            verdictPill(h.verdict) + ' ' + inlineMd(h.note || '') + '</span></li>';
        }).join('') + '</ul>';
    }
    html += '</div>';

    // case alarms
    var ca = caseAlarms(c.id);
    if (ca.length) {
      html += '<div class="card"><div class="section-label">本条用例的告警</div>' +
        ca.map(function (a) { return '<div class="alert ' + a.severity + '" style="margin-bottom:6px;cursor:default">' + esc(a.message) + '<span class="n">' + esc(a.code) + '</span></div>'; }).join('') + '</div>';
    }
    return html;
  }

  // ---------- other views
  function renderDefects() {
    var ds = REPORT.defects || [];
    if (!ds.length) return '<div class="card"><div class="empty">本轮无缺陷。</div></div>';
    return '<div class="card"><table class="table-simple"><thead><tr><th>ID</th><th>严重度</th><th>优先级</th><th>现象</th><th>影响</th><th>关联 TC</th><th>状态</th></tr></thead><tbody>' +
      ds.map(function (d) {
        return '<tr><td class="mono">' + esc(d.id) + '</td><td>' + esc(d.severity) + '</td><td>' + esc(d.priority) + '</td><td>' + inlineMd(d.phenomenon) +
          '</td><td>' + inlineMd(d.impact) + '</td><td class="mono">' + esc((d.cases || []).join(', ')) + '</td><td>' + esc(d.status) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function renderGaps() {
    var gs = REPORT.notCovered || [];
    var cond = (REPORT.verdict && REPORT.verdict.conditions) || [];
    var html = '<div class="card">';
    if (cond.length) {
      html += '<div class="section-label">发布前置条件</div><ul class="gaps" style="margin-bottom:14px">' +
        cond.map(function (c) { return '<li style="border-color:var(--warn);background:var(--warn-bg);color:var(--warn)">' + inlineMd(c) + '</li>'; }).join('') + '</ul>';
    }
    html += '<div class="section-label">未覆盖项 · ' + gs.length + '</div>';
    if (!gs.length) html += '<div class="empty">无未覆盖项。</div>';
    else html += '<table class="table-simple"><thead><tr><th>内容</th><th>理由</th><th>关联 REQ</th><th>风险</th><th>承接</th></tr></thead><tbody>' +
      gs.map(function (g) {
        return '<tr><td>' + inlineMd(g.item) + '</td><td>' + inlineMd(g.reason) + '</td><td class="mono">' + esc((g.requirements || []).join(', ')) +
          '</td><td>' + esc(g.risk || '—') + '</td><td>' + esc(g.owner || '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
    return html + '</div>';
  }
  function renderCleanup() {
    var c = REPORT.cleanup || {};
    var bad = Number(c.residual) > 0;
    return '<div class="card"><div class="section-label">数据清理与回查</div>' +
      '<div class="kv"><span class="k">清理方式</span><span>' + inlineMd(c.method || '—') + '</span>' +
      '<span class="k">回查项数</span><span>' + esc(c.checkedItems) + '</span>' +
      '<span class="k">残留总数</span><span class="' + (bad ? 'pill bad' : 'pill ok') + '" style="justify-self:start">' + esc(c.residual) + '</span>' +
      '<span class="k">明细</span><span>' + inlineMd(c.detail || '') + '</span></div></div>';
  }
  function renderHistory() {
    var hs = REPORT.executionHistory || [];
    var html = '<div class="card"><div class="section-label">执行轮次 · ' + hs.length + '</div>';
    if (!hs.length) html += '<div class="empty">未记录全局执行轮次。</div>';
    else html += '<ul class="timeline">' + hs.map(function (h) {
      return '<li><span class="round">R' + esc(h.round) + '</span><span class="when">' + esc(h.time || '') + '</span><span>' +
        verdictPill(h.verdict) + ' <span style="color:var(--muted)">' + esc(h.scope || '') + '</span> ' + inlineMd(h.note || '') + '</span></li>';
    }).join('') + '</ul>';
    html += '</div>';
    if (REPORT.conclusion && REPORT.conclusion.length) {
      html += '<div class="card"><div class="section-label">结论</div><ul style="margin:0;padding-left:20px;font-size:13px">' +
        REPORT.conclusion.map(function (x) { return '<li style="margin-bottom:6px">' + inlineMd(x) + '</li>'; }).join('') + '</ul></div>';
    }
    return html;
  }

  // ---------- render
  function render() {
    renderTabs();
    var host = document.getElementById('content');
    if (state.view === 'cases') {
      var list = filteredCases();
      if (!list.some(function (c) { return c.id === state.selected; })) {
        state.selected = list.length ? list[0].id : null;
        if (state.selected) syncHash();
      }
      host.innerHTML = '<div class="layout">' + renderNav() + '<div class="main">' + renderDetail() + '</div></div>';
      Array.prototype.forEach.call(document.querySelectorAll('[data-case]'), function (el) {
        el.addEventListener('click', function () {
          state.selected = el.getAttribute('data-case'); syncHash(); render();
        });
      });
    } else {
      host.innerHTML = state.view === 'defects' ? renderDefects()
        : state.view === 'gaps' ? renderGaps()
        : state.view === 'cleanup' ? renderCleanup()
        : renderHistory();
    }
  }

  // ---------- hash
  function syncHash() {
    var h = state.view === 'cases' ? '#/case/' + (state.selected || '') : '#/view/' + state.view;
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    var m = /^#\\/case\\/(.+)$/.exec(location.hash);
    if (m) { state.view = 'cases'; state.selected = decodeURIComponent(m[1]); return; }
    m = /^#\\/view\\/(.+)$/.exec(location.hash);
    if (m) state.view = m[1];
  }

  // ---------- interactions
  document.getElementById('search').addEventListener('input', function (e) {
    state.query = e.target.value; render();
  });
  document.getElementById('alerts-only').addEventListener('change', function (e) {
    state.alertsOnly = e.target.checked; render();
  });
  document.getElementById('theme').addEventListener('click', function () {
    var order = ['auto', 'light', 'dark'];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    document.documentElement.setAttribute('data-theme', state.theme);
    try { localStorage.setItem('report-theme', state.theme); } catch (_e) {}
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) {
      if (e.key === 'Escape') { e.target.value = ''; state.query = ''; e.target.blur(); render(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); document.getElementById('search').focus(); return; }
    if (state.view !== 'cases') return;
    var list = filteredCases();
    if (!list.length) return;
    var i = list.findIndex(function (c) { return c.id === state.selected; });
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.selected = list[Math.min(i + 1, list.length - 1)].id; syncHash(); render(); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.selected = list[Math.max(i - 1, 0)].id; syncHash(); render(); }
  });

  // ---------- boot
  try {
    var saved = localStorage.getItem('report-theme');
    if (saved) { state.theme = saved; document.documentElement.setAttribute('data-theme', saved); }
  } catch (_e) {}
  readHash();
  if (!CASES.some(function (c) { return c.id === state.selected; })) state.selected = CASES.length ? CASES[0].id : null;
  document.getElementById('schema-v').textContent = REPORT.schemaVersion || '?';
  document.getElementById('generated-at').textContent = '生成于 ' + document.querySelector('meta[name="generated-at"]').content;
  renderHeader(); renderAlerts(); render();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- main

function main(argv) {
  const args = argv.slice(2);
  const strict = args.includes('--strict');
  const dir = resolve(args.find((a) => !a.startsWith('--')) || '.');

  if (!statSync(dir).isDirectory()) {
    console.error(`不是目录：${dir}`);
    process.exit(2);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('-test-report.json'));
  if (!files.length) {
    console.error(`目录下没有 *-test-report.json：${dir}`);
    process.exit(2);
  }

  let totalBlockers = 0;
  for (const file of files) {
    const src = join(dir, file);
    let report;
    try {
      report = JSON.parse(readFileSync(src, 'utf8'));
    } catch (err) {
      console.error(`✕ ${file} JSON 解析失败：${err.message}`);
      process.exitCode = 2;
      continue;
    }
    const alarms = verify(report);
    const out = join(dir, basename(file, '.json') + '.html');
    writeFileSync(out, renderHtml(report, alarms, file), 'utf8');

    const blockers = alarms.filter((a) => a.severity === 'blocker').length;
    const warns = alarms.length - blockers;
    totalBlockers += blockers;
    console.log(`${blockers ? '✕' : warns ? '⚠' : '✓'} ${file} → ${basename(out)}  (${blockers} blocker, ${warns} warn)`);
    for (const a of alarms) {
      console.log(`    [${a.severity}] ${a.code}: ${a.message}`);
    }
  }

  if (strict && totalBlockers > 0) {
    console.error(`\n--strict：存在 ${totalBlockers} 条 blocker 告警`);
    process.exit(1);
  }
}

main(process.argv);
