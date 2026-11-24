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
 *   "reportConfig": {
 *     "payloadLayers": ["<层名1>", "<层名2>"],
 *     "columnSemantics": { "<列名>": { "label": "<中文表头>", "values": { "<原值>": ["<tone>", "<标签>"] } } }
 *   }
 * payloadLayers：必须留 request/response 报文的层，层名由项目 skill 定义；未声明则不检查。
 * columnSemantics：证据 tables 的列语义（表头中文名、枚举值着色标签，tone ∈ ok/bad/warn/info/dim）；未声明则显示原值。
 *
 * 约束：
 * - Markdown 是事实源，JSON 与 HTML 都是派生物；HTML 不得手工编辑。
 * - 零第三方依赖，产物自包含（CSS/JS 内联，无 CDN）。
 * - 证据原文（command/result/raw/implementation）原样转义，不解析行内 Markdown。
 * - 用例流程图支持内联 cases[].flow，或顶层 flowTemplates + cases[].flowRef（模板 + 分支）；
 *   flowRef 只声明分支与证据，模板渲染全图并淡化非本用例路径。排版约定见同目录 report-flow-design.md。
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

// ---------------------------------------------------------------- 测试流程（cases[].flow）

/** 节点类型 → 中文标签（渲染器与页面共用同一份词表）。 */
const FLOW_TYPE_LABELS = {
  start: '开始', end: '结束', http: '接口', sql: '数据库', schedule: '调度',
  service: '服务', decision: '判断', callback: '回调', config: '配置',
  log: '日志', metric: '指标', mq: '消息', missing: '未取证',
};
const FLOW_EDGE_KINDS = new Set(['normal', 'success', 'error', 'retry', 'async']);
/** 这些类型天然不需要证据：起止、分支判定、以及显式的未取证占位。 */
const FLOW_CANNOT_PROVE = new Set(['start', 'end', 'decision', 'missing']);

const FLOW = {
  // 横向蛇形折行：一行放不下就折到下一行并反转方向，行尾用短连接线续接
  MIN_W: 92, MAX_W: 168, DEC_W: 168, PAD: 22, GAP: 34, GAP_DEC: 64, GAP_Y: 12,
  // 行越窄，SVG 按容器宽度放大时倍数越大、文字越清楚
  ROW_MAX: 660, ROW_GAP: 50, NODE_GAP_Y: 12,
  LINE_H: 16, FONT: 13, DETAIL_FONT: 10.5, LABEL_FONT: 10.5, MAX_LINES: 2,
  TITLE_H: 13, SUB_H: 10.5, SUB_GAP: 3.5, NODE_PAD: 6,
};

const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const CJK_PUNCT = /[　-〿＀-￯]/;

function charEm(ch) {
  if (ch === ' ') return 0.32;
  return WIDE_CHAR.test(ch) ? 1 : 0.56;
}
function textWidth(s, px) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) w += charEm(ch) * px;
  return w;
}
function trimToWidth(s, maxW, px) {
  let out = '';
  for (const ch of String(s)) {
    if (textWidth(out + ch + '…', px) > maxW) break;
    out += ch;
  }
  return out + '…';
}
/** 按 CJK 单字 / 拉丁词切分后贪心换行；超出行数截断并以 … 结尾（全文由 <title> 保留）。 */
function wrapText(s, maxW, px, maxLines) {
  const text = String(s == null ? '' : s).trim();
  if (!text) return [''];
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (ch === ' ') {
      if (buf) tokens.push(buf);
      buf = '';
      tokens.push(' ');
    } else if (WIDE_CHAR.test(ch) && !CJK_PUNCT.test(ch)) {
      if (buf) tokens.push(buf);
      buf = '';
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  // 单个 token 本身超宽（长标识符 / URL）时按字符硬切，否则会越出节点形状
  const flat = [];
  for (const t of tokens) {
    if (textWidth(t, px) <= maxW) { flat.push(t); continue; }
    let piece = '';
    for (const ch of t) {
      if (piece && textWidth(piece + ch, px) > maxW) { flat.push(piece); piece = ch; }
      else piece += ch;
    }
    if (piece) flat.push(piece);
  }

  const lines = [];
  let cur = '';
  for (const t of flat) {
    // 前瞻判宽：追加后若超宽就先收行，避免一行多吞一个 token 而越出节点
    if (cur && textWidth((cur + t).trimEnd(), px) > maxW) {
      lines.push(cur.trimEnd());
      cur = t === ' ' ? '' : t;
    } else {
      cur += t;
    }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = trimToWidth(lines[maxLines - 1], maxW, px);
  }
  return lines;
}

function flowNodeSize(n) {
  const type = FLOW_TYPE_LABELS[n.type] ? n.type : 'service';
  const label = String(n.label || '');
  const detail = n.detail ? String(n.detail) : '';
  if (type === 'start' || type === 'end') {
    const w = Math.max(56, Math.min(FLOW.MAX_W, Math.ceil(textWidth(label, FLOW.FONT) + 30)));
    return { w, h: 30, lines: [trimText(label, w - 18, FLOW.FONT)], detail: '' };
  }
  if (type === 'decision') {
    const inner = FLOW.DEC_W * 0.62;
    const lines = wrapText(label, inner, FLOW.FONT, FLOW.MAX_LINES);
    const h = Math.max(54, Math.round(26 + lines.length * FLOW.LINE_H * 1.15 + (detail ? 9 : 0)));
    return { w: FLOW.DEC_W, h, lines, detail: detail ? trimText(detail, FLOW.DEC_W * 0.6, FLOW.DETAIL_FONT) : '' };
  }
  // 斜边/折叠形状（六边形、圆柱、文档、平行四边形）左右留白更大，内部可用宽度更窄
  const pad = type === 'schedule' ? 40 : type === 'sql' || type === 'log' || type === 'mq' ? 30 : type === 'callback' ? 32 : 24;
  // 宽度要同时容纳标题与副标题，否则副标题会越出形状
  const wantW = Math.max(textWidth(label, FLOW.FONT), detail ? textWidth(detail, FLOW.DETAIL_FONT) : 0) + pad;
  const w = Math.min(FLOW.MAX_W, Math.max(FLOW.MIN_W, Math.ceil(wantW)));
  const inner = w - pad;
  const lines = wrapText(label, inner, FLOW.FONT, FLOW.MAX_LINES);
  let h = 12 + lines.length * FLOW.LINE_H + (detail ? 14 : 0);
  if (type === 'sql') h += 10;
  return { w, h: Math.round(h), lines, detail: detail ? trimText(detail, inner, FLOW.DETAIL_FONT) : '' };
}

/** 超出宽度时截断；全文仍由 <title> 保留。留 0.5px 容差，避免浮点累加误差导致的误截断。 */
function trimText(s, maxW, px) {
  return textWidth(s, px) > maxW + 0.5 ? trimToWidth(s, maxW, px) : s;
}

/** 拓扑排序 + 最长路径分层；返回每个节点的层号与回边集合。 */
function flowLayers(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  const pending = new Map(indeg);
  while (queue.length) {
    const u = queue.shift();
    order.push(u);
    for (const v of out.get(u)) {
      pending.set(v, pending.get(v) - 1);
      if (pending.get(v) === 0) queue.push(v);
    }
  }
  const reached = new Set(order);
  for (const n of nodes) if (!reached.has(n.id)) order.push(n.id); // 环内节点兜底，避免丢图

  const pos = new Map(order.map((id, i) => [id, i]));
  const dag = [];
  const back = new Set();
  for (const e of edges) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    if (pos.get(e.to) <= pos.get(e.from)) back.add(e);
    else dag.push(e);
  }

  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const dagOut = new Map(nodes.map((n) => [n.id, []]));
  for (const e of dag) dagOut.get(e.from).push(e.to);
  for (const id of order) {
    for (const v of dagOut.get(id)) layer.set(v, Math.max(layer.get(v), layer.get(id) + 1));
  }
  return { layer, back };
}

/** 折线倒圆角；只对真正的拐点倒角，共线点直接连线。 */
function roundedPath(pts, r) {
  const n1 = (v) => Math.round(v * 10) / 10;
  let d = `M ${n1(pts[0][0])} ${n1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], prev = pts[i - 1];
    if (i < pts.length - 1) {
      const next = pts[i + 1];
      const v1 = [p[0] - prev[0], p[1] - prev[1]];
      const v2 = [next[0] - p[0], next[1] - p[1]];
      const l1 = Math.hypot(v1[0], v1[1]) || 1;
      const l2 = Math.hypot(v2[0], v2[1]) || 1;
      if (Math.abs((v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2)) > 0.01) {
        const rr = Math.min(r, l1 / 2, l2 / 2);
        const p1 = [p[0] - (v1[0] / l1) * rr, p[1] - (v1[1] / l1) * rr];
        const p2 = [p[0] + (v2[0] / l2) * rr, p[1] + (v2[1] / l2) * rr];
        d += ` L ${n1(p1[0])} ${n1(p1[1])} Q ${n1(p[0])} ${n1(p[1])} ${n1(p2[0])} ${n1(p2[1])}`;
        continue;
      }
    }
    d += ` L ${n1(p[0])} ${n1(p[1])}`;
  }
  return d;
}

/** 取折线最长一段的中点作为标签中心；横线在线上方，竖线在右侧。 */
function pathLabelPos(pts) {
  let best = 1, bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  const [x1, y1] = pts[best - 1], [x2, y2] = pts[best];
  if (Math.abs(y1 - y2) < 1) return { lx: Math.round((x1 + x2) / 2), ly: Math.round(y1) - 10, vertical: false };
  return { lx: Math.round((x1 + x2) / 2), ly: Math.round((y1 + y2) / 2), vertical: true };
}

/** 纵向布局的边路径（仅 direction=TB 时使用）。 */
function flowEdgePathTB(a, b, isBack) {
  const mid = (v1, v2) => Math.round((v1 + v2) / 2);
  if (isBack) {
    const x = a.x + a.w / 2, y = a.y;
    const tx = b.x + b.w / 2, ty = b.y + b.h;
    return { d: `M ${x} ${y} C ${x + 34} ${y} ${tx + 34} ${ty} ${tx} ${ty}`, lx: Math.round((x + tx) / 2) + 18, ly: mid(y, ty) };
  }
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y;
  const dy = Math.max(18, Math.min(46, Math.abs(y2 - y1) / 2));
  return { d: `M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`, lx: mid(x1, x2), ly: mid(y1, y2) - 5 };
}

/** 蛇形折行布局的边路径：同行走水平线/贝塞尔，跨行走上下的行间通道。 */
function flowEdgePathSnake(a, b, rowTop, rowBottom) {
  const cy = (n) => n.y + n.h / 2;
  if (a.row === b.row) {
    if (b.x >= a.x + a.w || a.x >= b.x + b.w) {
      const toLeft = a.x >= b.x + b.w; // 目标在左侧（奇数行反向）
      const x1 = toLeft ? a.x : a.x + a.w;
      const x2 = toLeft ? b.x + b.w : b.x;
      const y1 = cy(a), y2 = cy(b);
      if (Math.abs(y1 - y2) < 1) {
        const pts = [[x1, y1], [x2, y2]];
        return { d: roundedPath(pts, 6), ...pathLabelPos(pts) };
      }
      const dx = Math.max(12, Math.min(36, Math.abs(x2 - x1) / 2)) * (x2 > x1 ? 1 : -1);
      return {
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`,
        lx: Math.round((x1 + x2) / 2), ly: Math.round((y1 + y2) / 2) - 9,
      };
    }
    // 同列上下相邻
    const down = b.y > a.y;
    const pts = down
      ? [[a.x + a.w / 2, a.y + a.h], [b.x + b.w / 2, b.y]]
      : [[a.x + a.w / 2, a.y], [b.x + b.w / 2, b.y + b.h]];
    return { d: roundedPath(pts, 6), ...pathLabelPos(pts) };
  }
  // 跨行：从节点下/上边缘出发，走行间通道再折到目标节点
  const down = b.row > a.row;
  const sy = down ? a.y + a.h : a.y;
  const ty = down ? b.y : b.y + b.h;
  const band = down ? rowTop[b.row] - rowBottom[a.row] : rowTop[a.row] - rowBottom[b.row];
  const gapY = down
    ? rowBottom[a.row] + Math.max(10, band / 2)
    : rowTop[a.row] - Math.max(10, band / 2);
  const sx = a.x + a.w / 2, tx = b.x + b.w / 2;
  const pts = Math.abs(sx - tx) < 1
    ? [[sx, sy], [tx, ty]]
    : [[sx, sy], [sx, gapY], [tx, gapY], [tx, ty]];
  return { d: roundedPath(pts, 10), ...pathLabelPos(pts) };
}

/** 单条用例的流程图布局；返回 null 表示没有可渲染的流程。 */
function layoutFlow(flow) {
  const nodes = (Array.isArray(flow.nodes) ? flow.nodes : []).filter((n) => n && n.id);
  if (!nodes.length) return null;
  const edges = (Array.isArray(flow.edges) ? flow.edges : [])
    .filter((e) => e && e.from && e.to && e.from !== e.to);
  const dir = flow.direction === 'TB' ? 'TB' : 'LR';

  const { layer, back } = flowLayers(nodes, edges);
  const byLayer = [];
  for (const n of nodes) {
    const L = layer.get(n.id);
    (byLayer[L] = byLayer[L] || []).push(n);
  }
  const sizes = new Map(nodes.map((n) => [n.id, flowNodeSize(n)]));

  const makeNode = (n) => {
    const s = sizes.get(n.id);
    return {
      id: n.id,
      type: FLOW_TYPE_LABELS[n.type] ? n.type : 'service',
      label: String(n.label || ''),
      detail: s.detail || '',
      note: n.note ? String(n.note) : '',
      lines: s.lines,
      w: s.w,
      h: s.h,
      evCount: Array.isArray(n.evidenceRefs) ? n.evidenceRefs.length : 0,
      active: n.active !== false,
      // missing 表示「设计上就无此节点」，与未取证同义，统一虚线标注
      unverified: n.unverified === true || n.type === 'missing',
      layer: layer.get(n.id),
      row: 0,
    };
  };

  const outNodes = [];

  if (dir === 'TB') {
    const maxLayer = byLayer.length - 1;
    const thickness = [];
    const breadth = [];
    for (let L = 0; L <= maxLayer; L++) {
      const list = byLayer[L] || [];
      const t = list.map((n) => sizes.get(n.id).h);
      const b = list.map((n) => sizes.get(n.id).w);
      thickness[L] = t.length ? Math.max(...t) : 0;
      breadth[L] = b.reduce((s, v) => s + v, 0) + Math.max(0, b.length - 1) * FLOW.GAP_Y;
    }
    const breadthMax = Math.max(0, ...breadth);
    const mainPos = [FLOW.PAD];
    for (let L = 1; L <= maxLayer; L++) {
      const prevDecision = (byLayer[L - 1] || []).some((n) => n.type === 'decision');
      mainPos[L] = mainPos[L - 1] + thickness[L - 1] + (prevDecision ? FLOW.GAP_DEC : FLOW.GAP);
    }
    for (let L = 0; L <= maxLayer; L++) {
      let c = FLOW.PAD + (breadthMax - breadth[L]) / 2;
      for (const n of byLayer[L] || []) {
        const s = sizes.get(n.id);
        const node = makeNode(n);
        node.y = Math.round(mainPos[L] + (thickness[L] - s.h) / 2);
        node.x = Math.round(c);
        outNodes.push(node);
        c += s.w + FLOW.GAP_Y;
      }
    }
    const byId = new Map(outNodes.map((n) => [n.id, n]));
    const outEdges = [];
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const kind = FLOW_EDGE_KINDS.has(e.kind) ? e.kind : 'normal';
      const label = e.label ? String(e.label) : '';
      const p = flowEdgePathTB(a, b, back.has(e));
      outEdges.push({
        from: e.from, to: e.to, kind, label, back: back.has(e), active: e.active !== false,
        labelW: label ? Math.ceil(textWidth(label, FLOW.LABEL_FONT)) + 16 : 0, ...p,
      });
    }
    const width = Math.max(...outNodes.map((n) => n.x + n.w)) + FLOW.PAD;
    const height = Math.max(...outNodes.map((n) => n.y + n.h)) + FLOW.PAD + (back.size ? 30 : 0);
    return {
      dir, width: Math.round(width), height: Math.round(height), nodes: outNodes, edges: outEdges,
      template: flow.template, branch: flow.branch, branchLabel: flow.branchLabel, title: flow.title,
    };
  }

  // ── 横向蛇形折行：列 = 层，按 ROW_MAX 贪心打包成行，奇数行反向 ──
  const cols = byLayer.map((list) => list || []);
  const colW = cols.map((list) => (list.length ? Math.max(...list.map((n) => sizes.get(n.id).w)) : 0));
  const colH = cols.map((list) =>
    list.reduce((s, n) => s + sizes.get(n.id).h, 0) + Math.max(0, list.length - 1) * FLOW.NODE_GAP_Y);

  const rows = [];
  const gapBefore = cols.map((list, L) =>
    L > 0 && cols[L - 1].some((n) => n.type === 'decision') ? FLOW.GAP_DEC : FLOW.GAP);
  let band = { cols: [], w: 0, h: 0 };
  for (let L = 0; L < cols.length; L++) {
    if (band.cols.length && band.w + gapBefore[L] + colW[L] > FLOW.ROW_MAX) {
      rows.push(band);
      band = { cols: [], w: 0, h: 0 };
    }
    // 换行后行首不再需要层间 gap
    band.w += colW[L] + (band.cols.length ? gapBefore[L] : 0);
    band.cols.push(L);
    band.h = Math.max(band.h, colH[L]);
  }
  if (band.cols.length) rows.push(band);

  const maxRowW = Math.max(0, ...rows.map((r) => r.w));
  const width = maxRowW + FLOW.PAD * 2;
  const rowTop = [];
  const rowBottom = [];
  let y = FLOW.PAD;
  rows.forEach((r, ri) => {
    const ltr = ri % 2 === 0;
    rowTop[ri] = y;
    rowBottom[ri] = y + r.h;
    // 偶数行左→右；奇数行右→左：层号仍递增，只是从右向左摆放，保证行尾落在同侧
    const offs = [];
    let off = 0;
    r.cols.forEach((L, i) => {
      if (i) off += gapBefore[L];
      offs.push(off);
      off += colW[L];
    });
    r.cols.forEach((L, i) => {
      const colX = ltr ? FLOW.PAD + offs[i] : FLOW.PAD + maxRowW - offs[i] - colW[L];
      let cy = y + (r.h - colH[L]) / 2;
      for (const n of cols[L]) {
        const s = sizes.get(n.id);
        const node = makeNode(n);
        node.x = Math.round(colX + (colW[L] - s.w) / 2);
        node.y = Math.round(cy);
        node.row = ri;
        outNodes.push(node);
        cy += s.h + FLOW.NODE_GAP_Y;
      }
    });
    y += r.h + FLOW.ROW_GAP;
  });
  const height = y - FLOW.ROW_GAP + FLOW.PAD;

  const byId = new Map(outNodes.map((n) => [n.id, n]));
  const outEdges = [];
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const kind = FLOW_EDGE_KINDS.has(e.kind) ? e.kind : 'normal';
    const label = e.label ? String(e.label) : '';
    const p = flowEdgePathSnake(a, b, rowTop, rowBottom);
    outEdges.push({
      from: e.from, to: e.to, kind, label, back: back.has(e), active: e.active !== false,
      labelW: label ? Math.ceil(textWidth(label, FLOW.LABEL_FONT)) + 16 : 0, ...p,
    });
  }
  return {
    dir, width: Math.round(width), height: Math.round(height), nodes: outNodes, edges: outEdges,
    template: flow.template, branch: flow.branch, branchLabel: flow.branchLabel, title: flow.title,
  };
}

/** 将 branch.edges 统一成 {from,to}；支持 ["a","b"] 与 {from,to} 两种写法。 */
function normalizeBranchEdges(branch) {
  const out = [];
  if (!branch || !Array.isArray(branch.edges)) return out;
  for (const e of branch.edges) {
    if (Array.isArray(e) && e.length >= 2) out.push({ from: String(e[0]), to: String(e[1]) });
    else if (e && typeof e === 'object' && e.from != null && e.to != null) {
      out.push({ from: String(e.from), to: String(e.to) });
    }
  }
  return out;
}

/**
 * 解析 cases[].flowRef + report.flowTemplates；内联 c.flow 优先。
 * 返回 { flow, issues }：issues 由 verifyFlow 转成 warn，不在此处打断流程。
 */
function resolveCaseFlow(report, c) {
  if (c && c.flow && typeof c.flow === 'object') return { flow: c.flow, issues: [] };
  const ref = c && c.flowRef;
  if (!ref || typeof ref !== 'object') return { flow: null, issues: [] };

  const issues = [];
  const templates = report && report.flowTemplates && typeof report.flowTemplates === 'object'
    ? report.flowTemplates : {};
  const tplId = ref.template == null ? '' : String(ref.template);
  const tpl = tplId ? templates[tplId] : null;
  if (!tpl || typeof tpl !== 'object') {
    issues.push({
      code: 'FLOW_TEMPLATE_MISSING',
      message: `${c.id} 的 flowRef 引用了不存在的模板 ${tplId || '(空)'}`,
    });
    return { flow: null, issues };
  }

  const branches = tpl.branches && typeof tpl.branches === 'object' ? tpl.branches : {};
  const branchId = ref.branch == null ? null : String(ref.branch);
  const branch = branchId == null ? null : branches[branchId];
  if (branchId != null && !branch) {
    issues.push({
      code: 'FLOW_BRANCH_MISSING',
      message: `${c.id} 的 flowRef 引用了模板 ${tplId} 中不存在的分支 ${branchId}，按全量模板渲染`,
    });
  }

  const tplNodes = (Array.isArray(tpl.nodes) ? tpl.nodes : []).filter((n) => n && n.id);
  const tplEdges = (Array.isArray(tpl.edges) ? tpl.edges : []).filter((e) => e && e.from && e.to);
  const tplNodeIds = new Set(tplNodes.map((n) => n.id));

  let activeNodeIds = null;
  let activeEdgeKeys = null;
  if (branch) {
    const bEdges = normalizeBranchEdges(branch);
    const bNodeList = Array.isArray(branch.nodes) ? branch.nodes.map((x) => String(x)) : [];
    if (!bNodeList.length && !bEdges.length) {
      issues.push({
        code: 'FLOW_BRANCH_EMPTY',
        message: `${c.id} 的分支 ${branchId} 未声明 nodes/edges，按全量模板渲染`,
      });
    } else {
      activeNodeIds = new Set(bNodeList);
      for (const e of bEdges) { activeNodeIds.add(e.from); activeNodeIds.add(e.to); }
      for (const id of activeNodeIds) {
        if (!tplNodeIds.has(id)) {
          issues.push({
            code: 'FLOW_BRANCH_NODE_ORPHAN',
            message: `${c.id} 的分支 ${branchId} 引用了不存在的节点 ${id}`,
          });
        }
      }
      for (const e of bEdges) {
        if (!tplNodeIds.has(e.from) || !tplNodeIds.has(e.to)) {
          issues.push({
            code: 'FLOW_BRANCH_EDGE_ORPHAN',
            message: `${c.id} 的分支 ${branchId} 的边 ${e.from} → ${e.to} 指向不存在的节点`,
          });
        }
      }
      const keys = bEdges.length
        ? bEdges.map((e) => `${e.from}->${e.to}`)
        : tplEdges.filter((e) => activeNodeIds.has(e.from) && activeNodeIds.has(e.to))
          .map((e) => `${e.from}->${e.to}`);
      activeEdgeKeys = new Set(keys);
    }
  }

  const evidenceMap = ref.evidenceRefs && typeof ref.evidenceRefs === 'object' ? ref.evidenceRefs : {};
  const overrides = ref.nodeOverrides && typeof ref.nodeOverrides === 'object' ? ref.nodeOverrides : {};
  for (const nodeId of Object.keys(evidenceMap)) {
    if (!tplNodeIds.has(nodeId)) {
      issues.push({
        code: 'FLOW_REF_NODE_UNKNOWN',
        message: `${c.id} 的 flowRef.evidenceRefs 引用了模板 ${tplId} 中不存在的节点 ${nodeId}`,
      });
    }
  }
  for (const nodeId of Object.keys(overrides)) {
    if (!tplNodeIds.has(nodeId)) {
      issues.push({
        code: 'FLOW_REF_NODE_UNKNOWN',
        message: `${c.id} 的 flowRef.nodeOverrides 引用了模板 ${tplId} 中不存在的节点 ${nodeId}`,
      });
    }
  }

  const nodes = tplNodes.map((n) => {
    const o = overrides[n.id] && typeof overrides[n.id] === 'object' ? overrides[n.id] : {};
    const override = {};
    for (const k of ['label', 'detail', 'unverified', 'note']) {
      if (o[k] !== undefined) override[k] = o[k];
    }
    const evidenceRefs = Array.isArray(evidenceMap[n.id])
      ? evidenceMap[n.id]
      : (Array.isArray(n.evidenceRefs) ? n.evidenceRefs : []);
    return {
      ...n,
      ...override,
      evidenceRefs,
      active: activeNodeIds ? activeNodeIds.has(n.id) : true,
    };
  });
  const edges = tplEdges.map((e) => ({
    ...e,
    active: activeEdgeKeys ? activeEdgeKeys.has(`${e.from}->${e.to}`) : true,
  }));

  return {
    flow: {
      title: ref.title || (branch && (branch.title || branch.label)) || tpl.title || '',
      direction: ref.direction || tpl.direction || 'LR',
      template: tplId,
      branch: branchId,
      branchLabel: (branch && (branch.label || branch.title)) || '',
      nodes,
      edges,
    },
    issues,
  };
}

function computeFlowLayouts(report) {
  const layouts = {};
  for (const c of Array.isArray(report.cases) ? report.cases : []) {
    if (c && !c.flow && c.flowRef) {
      const { flow } = resolveCaseFlow(report, c);
      if (flow) c.flow = flow;
    }
    if (c && c.flow && typeof c.flow === 'object') {
      const lay = layoutFlow(c.flow);
      if (lay) layouts[c.id] = lay;
    }
  }
  return layouts;
}

function verifyFlow(report, c, add, evIds) {
  const resolved = resolveCaseFlow(report, c);
  if (resolved.flow) c.flow = resolved.flow;
  for (const issue of resolved.issues) add(issue.code, 'warn', issue.message, [c.id]);
  const f = c.flow;
  if (!f || typeof f !== 'object') return;
  const nodes = Array.isArray(f.nodes) ? f.nodes : [];
  if (!nodes.length) {
    add('FLOW_EMPTY', 'warn', `${c.id} 声明了 flow${f.template ? `（模板 ${f.template}）` : ''}，但 nodes 为空`, [c.id]);
    return;
  }
  if (f.direction != null && f.direction !== 'LR' && f.direction !== 'TB') {
    add('FLOW_BAD_DIRECTION', 'warn', `${c.id} 的 flow.direction「${f.direction}」非法，按 LR 渲染`, [c.id]);
  }

  const ids = new Set();
  const dups = [];
  const unknown = [];
  const noEvidence = [];
  for (const n of nodes) {
    if (!n || !n.id || ids.has(n.id)) { dups.push(n && n.id ? n.id : '(空)'); if (n && n.id) ids.add(n.id); }
    else ids.add(n.id);
    if (n && !FLOW_TYPE_LABELS[n.type]) unknown.push(`${n.id}:${n.type}`);
    if (n && n.active === false) continue;
    const refs = n && Array.isArray(n.evidenceRefs) ? n.evidenceRefs : [];
    const type = n && FLOW_TYPE_LABELS[n.type] ? n.type : 'service';
    if (!FLOW_CANNOT_PROVE.has(type) && n && n.unverified !== true && !refs.length) {
      noEvidence.push(String(n.label || n.id));
    }
  }
  if (dups.length) add('FLOW_DUP_NODE_ID', 'warn', `${c.id} 的 flow 节点 id 重复或为空：${dups.join('、')}`, [c.id]);
  if (unknown.length) add('FLOW_NODE_UNKNOWN_TYPE', 'warn', `${c.id} 的 flow 节点类型未知：${unknown.join('、')}（按 service 渲染）`, [c.id]);
  if (noEvidence.length) {
    add('FLOW_NODE_NO_EVIDENCE', 'warn',
      `${c.id} 有 ${noEvidence.length} 个节点未挂证据且未标 unverified：${noEvidence.slice(0, 3).join('、')}${noEvidence.length > 3 ? ' 等' : ''}`,
      [c.id]);
  }

  const edges = Array.isArray(f.edges) ? f.edges : [];
  const edgeOrphans = edges.filter((e) => !e || !ids.has(e.from) || !ids.has(e.to));
  if (edgeOrphans.length) {
    add('FLOW_EDGE_ORPHAN', 'warn',
      `${c.id} 有 ${edgeOrphans.length} 条边指向不存在的节点：${edgeOrphans.map((e) => `${e && e.from} → ${e && e.to}`).join('、')}`,
      [c.id]);
  }

  const refOrphans = [];
  const boundIds = new Set();
  for (const n of nodes) {
    for (const id of Array.isArray(n && n.evidenceRefs) ? n.evidenceRefs : []) {
      if (evIds.has(id)) boundIds.add(id);
      else refOrphans.push(id);
    }
  }
  if (refOrphans.length) {
    add('FLOW_EVIDENCE_ORPHAN', 'warn', `${c.id} 的流程节点引用了不存在的证据：${refOrphans.join('、')}`, [c.id]);
  }
  const unbound = [...evIds].filter((id) => !boundIds.has(id));
  if (unbound.length) {
    add('FLOW_EVIDENCE_UNBOUND', 'warn',
      `${c.id} 有 ${unbound.length} 条证据未挂到流程节点：${unbound.slice(0, 3).join('、')}${unbound.length > 3 ? ' 等' : ''}`,
      [c.id]);
  }

  if (nodes.length > 1) {
    const hasIn = new Set(edges.filter((e) => e && e.to).map((e) => e.to));
    const lonely = nodes.filter((n) => n && n.id && n.type !== 'start' && !hasIn.has(n.id));
    if (lonely.length) {
      add('FLOW_IN_EDGE_MISSING', 'warn',
        `${c.id} 有节点没有入边（疑似断链）：${lonely.map((n) => n.id).join('、')}`, [c.id]);
    }
  }

  const { back } = flowLayers(nodes.filter((n) => n && n.id), edges);
  if (back.size) {
    add('FLOW_CYCLE_BACKEDGE', 'warn',
      `${c.id} 的流程图存在回边：${[...back].map((e) => `${e.from} → ${e.to}`).join('、')}（建议改写为前向时序链）`,
      [c.id]);
  }
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

    // 3b. 测试流程（可选；无 flow/flowRef 的旧报告不产生任何新告警）
    verifyFlow(report, c, add, evIds);

    // 3c. 结构化表格（可选）：tables 必须是数组，每张表 columns/rows 必须齐备且等长
    for (const e of c.evidence || []) {
      // 证据级关键行补充规则同样是字符串数组
      if (e.highlight !== undefined) {
        const ok = Array.isArray(e.highlight)
          && e.highlight.every((s) => typeof s === 'string' && s.length > 0);
        if (!ok) {
          add('LOG_HIGHLIGHT_INVALID', 'warn',
            `${c.id} 的证据 ${e.id} 的 highlight 必须是非空字符串数组，当前配置已忽略`, [c.id]);
        }
      }
      if (e.tables === undefined || e.tables === null) continue;
      if (!Array.isArray(e.tables)) {
        add('EVIDENCE_TABLE_INVALID', 'warn',
          `${c.id} 的证据 ${e.id} 的 tables 不是数组`, [c.id]);
        continue;
      }
      for (const t of e.tables) {
        const cols = t && t.columns, rows = t && t.rows;
        if (!Array.isArray(cols) || cols.length === 0 || !Array.isArray(rows)) {
          add('EVIDENCE_TABLE_INVALID', 'warn',
            `${c.id} 的证据 ${e.id} 有 table 缺 columns/rows 结构`, [c.id]);
          continue;
        }
        const badRow = rows.findIndex((r) => !Array.isArray(r) || r.length !== cols.length);
        if (badRow >= 0) {
          add('EVIDENCE_TABLE_INVALID', 'warn',
            `${c.id} 的证据 ${e.id} 表 ${t.name || '?'} 第 ${badRow + 1} 行值数与 columns（${cols.length}）不一致`, [c.id]);
        }
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

  // 5b. 日志关键行声明必须是字符串数组（非数组按无配置处理，但要提示）
  if (report.reportConfig && report.reportConfig.logHighlight !== undefined) {
    const lh = report.reportConfig.logHighlight;
    const ok = Array.isArray(lh) && lh.every((s) => typeof s === 'string' && s.length > 0);
    if (!ok) {
      add('LOG_HIGHLIGHT_INVALID', 'warn',
        'reportConfig.logHighlight 必须是非空字符串数组，当前配置已忽略');
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
  const flowLayouts = computeFlowLayouts(report);
  const payload = JSON.stringify({
    report, alarms, flowLayouts, flowTypeLabels: FLOW_TYPE_LABELS,
    // 文本排版参数随数据下发，避免客户端再抄一份常量
    flowMetrics: { lineH: FLOW.LINE_H, titleH: FLOW.TITLE_H, subH: FLOW.SUB_H, subGap: FLOW.SUB_GAP },
  }).replace(/</g, '\\u003c');
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
  :root {
    --flow-http: #0369a1; --flow-sql: #0e7490; --flow-schedule: #0f766e; --flow-service: #475569;
    --flow-decision: #b45309; --flow-callback: #7c3aed; --flow-config: #4d7c0f; --flow-log: #64748b;
    --flow-metric: #be123c; --flow-mq: #a21caf; --flow-neutral: #64748b;
    --flow-dot: rgba(15, 23, 42, 0.075); --flow-panel: #fbfdff;
  }
  html[data-theme="dark"] {
    --flow-http: #38bdf8; --flow-sql: #22d3ee; --flow-schedule: #2dd4bf; --flow-service: #cbd5e1;
    --flow-decision: #fbbf24; --flow-callback: #a78bfa; --flow-config: #a3e635; --flow-log: #94a3b8;
    --flow-metric: #fb7185; --flow-mq: #e879f9; --flow-neutral: #94a3b8;
    --flow-dot: rgba(148, 163, 184, 0.16); --flow-panel: #0b1324;
  }
  @media (prefers-color-scheme: dark) {
    html[data-theme="auto"] {
      --flow-http: #38bdf8; --flow-sql: #22d3ee; --flow-schedule: #2dd4bf; --flow-service: #cbd5e1;
      --flow-decision: #fbbf24; --flow-callback: #a78bfa; --flow-config: #a3e635; --flow-log: #94a3b8;
      --flow-metric: #fb7185; --flow-mq: #e879f9; --flow-neutral: #94a3b8;
      --flow-dot: rgba(148, 163, 184, 0.16); --flow-panel: #0b1324;
    }
  }
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
  /* ---- 测试流程图 ---- */
  .flow-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 8px; font-size: 11.5px; color: var(--muted); align-items: center; }
  .fl-legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .fl-swatch { width: 22px; height: 12px; display: inline-block; border-radius: 3px; border: 1.5px solid var(--border-strong); }
  .fl-swatch-http { background: color-mix(in srgb, var(--flow-http) 14%, var(--panel)); border-color: var(--flow-http); }
  .fl-swatch-sql { background: color-mix(in srgb, var(--flow-sql) 14%, var(--panel)); border-color: var(--flow-sql); border-radius: 5px/7px; }
  .fl-swatch-schedule { background: color-mix(in srgb, var(--flow-schedule) 14%, var(--panel)); border-color: var(--flow-schedule); border-radius: 6px 2px; }
  .fl-swatch-service { background: color-mix(in srgb, var(--flow-service) 14%, var(--panel)); border-color: var(--flow-service); }
  .fl-swatch-decision { background: color-mix(in srgb, var(--flow-decision) 14%, var(--panel)); border-color: var(--flow-decision); transform: rotate(45deg); width: 12px; height: 12px; border-radius: 2px; }
  .fl-swatch-callback { background: color-mix(in srgb, var(--flow-callback) 14%, var(--panel)); border-color: var(--flow-callback); transform: skewX(-14deg); }
  .fl-swatch-config { background: color-mix(in srgb, var(--flow-config) 14%, var(--panel)); border-color: var(--flow-config); }
  .fl-swatch-log { background: color-mix(in srgb, var(--flow-log) 14%, var(--panel)); border-color: var(--flow-log); border-bottom-style: double; }
  .fl-swatch-metric { background: color-mix(in srgb, var(--flow-metric) 14%, var(--panel)); border-color: var(--flow-metric); }
  .fl-swatch-mq { background: color-mix(in srgb, var(--flow-mq) 14%, var(--panel)); border-color: var(--flow-mq); border-radius: 0 8px 8px 0; }
  .fl-swatch-neutral { background: var(--panel-2); border-color: var(--flow-neutral); border-radius: 8px; }
  .fl-swatch-missing { background: var(--panel-2); border: 1.5px dashed var(--flow-neutral); border-radius: 8px; }
  .fl-swatch-unverified { background: var(--warn-bg); border: 1.5px dashed var(--warn); }
  .fl-swatch-inactive { background: var(--panel-2); border-color: var(--dim); opacity: .4; }

  .flow-wrap {
    border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px 10px;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
    background:
      radial-gradient(circle at 1px 1px, var(--flow-dot) 1px, transparent 1.3px) 0 0 / 18px 18px,
      var(--flow-panel);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -16px rgba(15, 23, 42, 0.18);
  }
  .flow-hint { font-size: 11px; color: var(--dim); margin-top: 4px; }
  /* 铺满容器宽度：行越窄放大越多、字越大；容器过窄时保底 520px，宁可内部横向滚动也不缩到看不清 */
  .flow-svg { display: block; font-family: var(--sans); width: 100%; min-width: 520px; max-width: 1080px; height: auto; }
  .flow-svg text { fill: var(--ink); font-size: 13px; }
  .fl-node { cursor: pointer; }
  .fl-node .fl-shape { stroke-width: 1.25; stroke-linejoin: round; }
  .fl-node:hover .fl-shape { filter: brightness(1.06); }
  .fl-node.hl .fl-shape { stroke-width: 2.4; }
  .fl-node:focus { outline: none; }
  .fl-node:focus-visible .fl-shape { stroke-width: 2.4; }
  .fl-node .fl-title { font-weight: 600; }
  .fl-node .fl-sub { font-size: 10.5px; fill: var(--muted); font-weight: 400; }
  .fl-node.unverified .fl-shape { stroke-dasharray: 5 4; }
  .fl-node.inactive { opacity: .3; }
  .fl-edge.inactive { opacity: .25; }
  .fl-edge-label.inactive, .fl-edge-label-bg.inactive { opacity: .35; }
  .fl-http .fl-shape { fill: color-mix(in srgb, var(--flow-http) 13%, var(--flow-panel)); stroke: var(--flow-http); }
  .fl-sql .fl-shape { fill: color-mix(in srgb, var(--flow-sql) 13%, var(--flow-panel)); stroke: var(--flow-sql); }
  .fl-sql .fl-shape-top { fill: color-mix(in srgb, var(--flow-sql) 20%, var(--flow-panel)); stroke: var(--flow-sql); stroke-width: 1.25; }
  .fl-schedule .fl-shape { fill: color-mix(in srgb, var(--flow-schedule) 13%, var(--flow-panel)); stroke: var(--flow-schedule); }
  .fl-service .fl-shape { fill: color-mix(in srgb, var(--flow-service) 11%, var(--flow-panel)); stroke: var(--flow-service); }
  .fl-decision .fl-shape { fill: color-mix(in srgb, var(--flow-decision) 13%, var(--flow-panel)); stroke: var(--flow-decision); }
  .fl-callback .fl-shape { fill: color-mix(in srgb, var(--flow-callback) 13%, var(--flow-panel)); stroke: var(--flow-callback); }
  .fl-config .fl-shape { fill: color-mix(in srgb, var(--flow-config) 13%, var(--flow-panel)); stroke: var(--flow-config); }
  .fl-log .fl-shape { fill: color-mix(in srgb, var(--flow-log) 13%, var(--flow-panel)); stroke: var(--flow-log); }
  .fl-metric .fl-shape { fill: color-mix(in srgb, var(--flow-metric) 13%, var(--flow-panel)); stroke: var(--flow-metric); }
  .fl-mq .fl-shape { fill: color-mix(in srgb, var(--flow-mq) 13%, var(--flow-panel)); stroke: var(--flow-mq); }
  .fl-start .fl-shape, .fl-end .fl-shape { fill: var(--panel-2); stroke: var(--flow-neutral); }
  .fl-missing .fl-shape { fill: var(--panel-2); stroke: var(--flow-neutral); stroke-dasharray: 5 4; }
  .fl-badge circle { stroke: var(--flow-panel); stroke-width: 1.5; }
  .fl-badge.ok circle { fill: var(--info); }
  .fl-badge.bad circle { fill: var(--warn); }
  .fl-badge text { fill: #fff; font-size: 10px; font-weight: 700; font-family: var(--mono); }
  .fl-edge { fill: none; stroke: var(--border-strong); stroke-width: 1.5; }
  .fl-edge.success { stroke: var(--ok); }
  .fl-edge.error { stroke: var(--bad); }
  .fl-edge.retry { stroke: var(--warn); stroke-dasharray: 5 4; }
  .fl-edge.async { stroke-dasharray: 3 4; }
  .fl-edge-label-bg { fill: var(--flow-panel); stroke: var(--border); stroke-width: 0.75; }
  .fl-edge-label { font-size: 10.5px; fill: var(--muted); }
  .fl-edge-label.success { fill: var(--ok); }
  .fl-edge-label.error { fill: var(--bad); }
  .fl-edge-label.retry { fill: var(--warn); }
  .fl-head { fill: var(--border-strong); }
  #fl-arrow-ok .fl-head { fill: var(--ok); }
  #fl-arrow-bad .fl-head { fill: var(--bad); }
  #fl-arrow-warn .fl-head { fill: var(--warn); }
  .fl-type { font-family: var(--sans); font-size: 10.5px; border-radius: 4px; padding: 0 5px; margin-right: 6px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .ev-head { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
  .ev-head code { color: var(--muted); }
  .ev-item:first-child .ev-head, .ev-head:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
  .ev-ref { font-size: 11.5px; color: var(--dim); margin-top: 6px; }
  .ev-at { font-family: var(--mono); font-size: 11px; color: var(--info); background: var(--info-bg); border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
  .ev-keys { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 2px; }
  .ev-key { font-family: var(--mono); font-size: 10.5px; color: var(--dim); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
  .ev-key b { color: var(--ink); font-weight: 600; margin-left: 3px; }
  .ev-table { margin: 6px 0; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .ev-table-cap { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 5px 9px; background: var(--panel-2); border-bottom: 1px solid var(--border); font-size: 11.5px; }
  .ev-table-cap code { color: var(--ink-2); font-weight: 600; }
  .ev-table-cap .ev-where { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
  .ev-table-cap .ev-rows { margin-left: auto; color: var(--muted); white-space: nowrap; }
  .ev-table-wrap { overflow-x: auto; }
  .ev-table table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 11px; }
  .ev-table th { text-align: left; font-weight: 600; color: var(--muted); padding: 5px 9px; border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
  .ev-table td { padding: 4px 9px; border-bottom: 1px solid var(--border); color: var(--ink-2); white-space: nowrap; }
  .ev-table tr:last-child td { border-bottom: 0; }
  .ev-table td.ev-num { text-align: right; }
  .ev-table td.ev-null { color: var(--dim); text-align: center; }
  .ev-st { font-family: var(--sans); font-size: 11px; border-radius: 5px; padding: 0 6px; white-space: nowrap; border: 1px solid var(--border); color: var(--muted); }
  .ev-st.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-bg); }
  .ev-st.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: var(--bad-bg); }
  .ev-st.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: var(--warn-bg); }
  .ev-st.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 45%, transparent); background: var(--info-bg); }
  .ev-st.dim { color: var(--dim); }
  .ev-concl { font-size: 12px; color: var(--ink-2); margin: 6px 0 2px; }
  details.ev-sql { margin: 4px 0 0; }
  details.ev-sql > summary { font-size: 11.5px; color: var(--muted); cursor: pointer; padding: 2px 0; }
  details.ev-sql > pre { margin-top: 4px; }
  details.ev-raw { margin: 4px 0; }
  details.ev-raw > summary { font-size: 11.5px; color: var(--muted); cursor: pointer; padding: 2px 0; }
  details.ev-raw > pre { margin-top: 4px; }
  /* 日志证据：按级别着色；logHighlight 命中的行加粗并带左侧色条 */
  .ev-log { background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; overflow: auto; font-family: var(--mono); font-size: 11.5px; line-height: 1.6; margin: 8px 0 0; }
  .lg-line { white-space: pre-wrap; word-break: break-word; padding: 1px 5px; border-left: 2px solid transparent; border-radius: 3px; }
  .lg-ts { color: var(--dim); }
  .lg-lv { display: inline-block; min-width: 42px; margin: 0 7px 0 5px; padding: 0 5px; border-radius: 4px; font-size: 10px; font-weight: 700; text-align: center; letter-spacing: .04em; }
  .lg-lv.debug { color: var(--muted); background: color-mix(in srgb, var(--dim) 16%, transparent); }
  .lg-lv.info { color: var(--info); background: var(--info-bg); }
  .lg-lv.warn { color: var(--warn); background: var(--warn-bg); }
  .lg-lv.error, .lg-lv.fatal { color: var(--bad); background: var(--bad-bg); }
  .lg-pre { color: var(--muted); }
  .lg-msg { color: var(--ink); }
  .lg-line.lv-debug .lg-msg { color: var(--muted); }
  .lg-line.lv-warn .lg-msg { color: var(--warn); }
  .lg-line.lv-error .lg-msg, .lg-line.lv-fatal .lg-msg { color: var(--bad); }
  .lg-line.lg-hit { background: var(--info-bg); border-left-color: var(--info); }
  .lg-line.lg-hit .lg-msg { color: var(--ink); font-weight: 700; }
  .lg-line.lg-hit.lv-warn { background: var(--warn-bg); border-left-color: var(--warn); }
  .lg-line.lg-hit.lv-error, .lg-line.lg-hit.lv-fatal { background: var(--bad-bg); border-left-color: var(--bad); }
  .lg-key { margin: 8px 0 0; border: 1px solid color-mix(in srgb, var(--info) 35%, var(--border)); border-radius: 7px; background: var(--panel-2); overflow: hidden; }
  .lg-key-cap { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; color: var(--info); background: var(--info-bg); padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, var(--info) 25%, var(--border)); }
  .lg-key > .lg-line { margin: 4px 8px; }
  .lg-key > .lg-line:last-child { margin-bottom: 7px; }
  .ev-jump { font-family: var(--mono); font-size: 11px; color: var(--info); cursor: pointer; text-decoration: underline dotted; display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .ev-jump:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
  .ev-item.flash { animation: ev-flash 1.5s ease-out; border-radius: 6px; }
  @keyframes ev-flash { 0% { background: var(--info-bg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 30%, transparent); } 100% { background: transparent; box-shadow: none; } }
  .ev-missing { font-size: 12px; color: var(--muted); margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .ev-chip { border: 1px dashed color-mix(in srgb, var(--warn) 55%, transparent); background: var(--warn-bg); color: var(--warn); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; cursor: pointer; }
  .ev-chip.hl { box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 40%, transparent); }
  @media print { .flow-wrap { overflow: visible; background: var(--flow-panel); } }

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

  <svg width="0" height="0" aria-hidden="true" style="position:absolute">
    <defs>
      <marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="fl-head" d="M0,0 L10,5 L0,10 Z" /></marker>
      <marker id="fl-arrow-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="fl-head" d="M0,0 L10,5 L0,10 Z" /></marker>
      <marker id="fl-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="fl-head" d="M0,0 L10,5 L0,10 Z" /></marker>
      <marker id="fl-arrow-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="fl-head" d="M0,0 L10,5 L0,10 Z" /></marker>
    </defs>
  </svg>

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
  var FLOW_LAYOUTS = DATA.flowLayouts || {};
  var FLOW_LABELS = DATA.flowTypeLabels || {};
  var FM = DATA.flowMetrics || { lineH: 16, titleH: 13, subH: 10.5, subGap: 3.5 };
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

  // ---------- flow diagram
  function flowShape(n) {
    var x = n.x, y = n.y, w = n.w, h = n.h, c = 'class="fl-shape"';
    if (n.type === 'start' || n.type === 'end') {
      return '<rect ' + c + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" />';
    }
    if (n.type === 'decision') {
      return '<polygon ' + c + ' points="' + [x + w / 2 + ',' + y, x + w + ',' + (y + h / 2), x + w / 2 + ',' + (y + h), x + ',' + (y + h / 2)].join(' ') + '" />';
    }
    if (n.type === 'sql') {
      var ry = 8;
      return '<path ' + c + ' d="M ' + x + ' ' + (y + ry) + ' L ' + (x + w) + ' ' + (y + ry) + ' L ' + (x + w) + ' ' + (y + h - ry) +
        ' A ' + (w / 2) + ' ' + ry + ' 0 0 0 ' + x + ' ' + (y + h - ry) + ' Z" />' +
        '<ellipse class="fl-shape-top" cx="' + (x + w / 2) + '" cy="' + (y + ry) + '" rx="' + (w / 2) + '" ry="' + ry + '" />';
    }
    if (n.type === 'schedule') {
      var k = Math.min(14, w / 4);
      return '<polygon ' + c + ' points="' + [x + k + ',' + y, x + w - k + ',' + y, x + w + ',' + (y + h / 2), x + w - k + ',' + (y + h), x + k + ',' + (y + h), x + ',' + (y + h / 2)].join(' ') + '" />';
    }
    if (n.type === 'callback') {
      var s = Math.min(11, w / 5);
      return '<polygon ' + c + ' points="' + [x + s + ',' + y, x + w + ',' + y, x + w - s + ',' + (y + h), x + ',' + (y + h)].join(' ') + '" />';
    }
    if (n.type === 'config') {
      var f = 13;
      return '<path ' + c + ' d="M ' + x + ' ' + y + ' L ' + (x + w - f) + ' ' + y + ' L ' + (x + w) + ' ' + (y + f) + ' L ' + (x + w) + ' ' + (y + h) + ' L ' + x + ' ' + (y + h) + ' Z" />';
    }
    if (n.type === 'log') {
      return '<path ' + c + ' d="M ' + x + ' ' + y + ' L ' + (x + w) + ' ' + y + ' L ' + (x + w) + ' ' + (y + h - 9) +
        ' C ' + (x + w * 0.68) + ' ' + (y + h + 5) + ', ' + (x + w * 0.32) + ' ' + (y + h - 23) + ', ' + x + ' ' + (y + h - 9) + ' Z" />';
    }
    if (n.type === 'metric') {
      return '<polygon ' + c + ' points="' + [x + ',' + y, x + w - 11 + ',' + y, x + w + ',' + (y + h / 2), x + w - 11 + ',' + (y + h), x + ',' + (y + h)].join(' ') + '" />';
    }
    if (n.type === 'mq') {
      return '<path ' + c + ' d="M ' + x + ' ' + y + ' H ' + (x + w - 10) + ' A 10 10 0 0 1 ' + (x + w - 10) + ' ' + (y + h) + ' H ' + x + ' Z" />';
    }
    return '<rect ' + c + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="7" />';
  }

  function renderFlowNode(n) {
    var cls = 'fl-node fl-' + n.type + (n.unverified ? ' unverified' : '') + (n.active === false ? ' inactive' : '');
    var g = '<g class="' + cls + '" data-flow-node="' + esc(n.id) + '" tabindex="0" role="button">';
    var tip = n.label + (n.detail ? ' · ' + n.detail : '') + (n.note ? ' · ' + n.note : '');
    g += '<title>' + esc(tip) + '</title>' + flowShape(n);
    var lineH = FM.lineH;
    var contentH = (n.lines.length - 1) * lineH + FM.titleH + (n.detail ? FM.subGap + FM.subH : 0);
    var top = n.y + (n.h - (n.type === 'sql' ? 10 : 0) - contentH) / 2;
    var cx = n.x + n.w / 2;
    g += '<text class="fl-title" text-anchor="middle">' + n.lines.map(function (line, i) {
      return '<tspan x="' + cx + '" y="' + (top + FM.titleH * 0.8 + i * lineH) + '">' + esc(line) + '</tspan>';
    }).join('') + '</text>';
    if (n.detail) {
      g += '<text class="fl-sub" text-anchor="middle"><tspan x="' + cx + '" y="' +
        (top + FM.titleH * 0.8 + (n.lines.length - 1) * lineH + FM.subGap + FM.subH) + '">' + esc(n.detail) + '</tspan></text>';
    }
    if (n.unverified) {
      g += '<g class="fl-badge bad"><circle cx="' + (n.x + n.w - 1) + '" cy="' + (n.y + 1) + '" r="9" /><text x="' + (n.x + n.w - 1) + '" y="' + (n.y + 4.5) + '" text-anchor="middle">!</text></g>';
    } else if (n.evCount) {
      g += '<g class="fl-badge ok"><circle cx="' + (n.x + n.w - 1) + '" cy="' + (n.y + 1) + '" r="9" /><text x="' + (n.x + n.w - 1) + '" y="' + (n.y + 4.5) + '" text-anchor="middle">' + n.evCount + '</text></g>';
    }
    return g + '</g>';
  }

  function renderFlowEdges(lay) {
    return lay.edges.map(function (e) {
      var marker = e.kind === 'success' ? 'fl-arrow-ok' : e.kind === 'error' ? 'fl-arrow-bad' : e.kind === 'retry' ? 'fl-arrow-warn' : 'fl-arrow';
      var off = e.active === false ? ' inactive' : '';
      var s = '<path class="fl-edge ' + e.kind + off + '" d="' + e.d + '" marker-end="url(#' + marker + ')" />';
      if (e.label) {
        var w = e.labelW || Math.ceil(e.label.length * 8) + 14;
        var lx = e.vertical ? e.lx + w / 2 + 3 : e.lx;
        s += '<rect class="fl-edge-label-bg' + off + '" x="' + (lx - w / 2) + '" y="' + (e.ly - 7) + '" width="' + w + '" height="14" rx="3" />' +
          '<text class="fl-edge-label ' + e.kind + off + '" x="' + lx + '" y="' + (e.ly + 4) + '" text-anchor="middle">' + esc(e.label) + '</text>';
      }
      return s;
    }).join('');
  }

  function renderFlowSection(c, lay) {
    var seen = [];
    lay.nodes.forEach(function (n) { if (seen.indexOf(n.type) < 0) seen.push(n.type); });
    var legend = lay.branchLabel
      ? '<span class="fl-legend-item"><b>分支</b> ' + esc(lay.branchLabel) + '</span>'
      : '';
    legend += seen.map(function (t) {
      var tone = t === 'start' || t === 'end' ? 'neutral' : t;
      return '<span class="fl-legend-item"><i class="fl-swatch fl-swatch-' + esc(tone) + '"></i>' + esc(FLOW_LABELS[t] || t) + '</span>';
    }).join('');
    if (lay.nodes.some(function (n) { return n.unverified; })) {
      legend += '<span class="fl-legend-item"><i class="fl-swatch fl-swatch-unverified"></i>未取证</span>';
    }
    if (lay.nodes.some(function (n) { return n.active === false; })) {
      legend += '<span class="fl-legend-item"><i class="fl-swatch fl-swatch-inactive"></i>非本用例路径</span>';
    }
    var aria = lay.nodes.map(function (n) { return n.label; }).join(' → ');
    return '<div class="section-label" style="margin-top:18px">测试流程 · ' + lay.nodes.length + ' 步' +
      (lay.branchLabel ? ' · 分支：' + esc(lay.branchLabel) : '') + '</div>' +
      '<div class="flow-legend">' + legend + '</div>' +
      '<div class="flow-wrap"><svg class="flow-svg" role="img" aria-label="' + esc(aria) + '" viewBox="0 0 ' + lay.width + ' ' + lay.height +
      '" width="' + lay.width + '" height="' + lay.height + '" preserveAspectRatio="xMinYMin meet">' +
      renderFlowEdges(lay) + lay.nodes.map(renderFlowNode).join('') + '</svg></div>' +
      '<div class="flow-hint">当前分支高亮；点击节点可定位到对应证据</div>';
  }

  var COL_SEM = (REPORT.reportConfig && REPORT.reportConfig.columnSemantics) || {};
  // 报告声明的关键行匹配串（字面子串），命中行在日志证据里加粗高亮
  var LOG_HIGHLIGHT = (function () {
    var v = REPORT.reportConfig && REPORT.reportConfig.logHighlight;
    return Array.isArray(v) ? v.filter(function (s) { return typeof s === 'string' && s.length > 0; }) : [];
  })();
  // 常见日志头：<时间> <级别> <其余>；解析不出时整行按普通文本输出
  var LOG_LEVEL_RE = /^(\\d{4}-\\d{2}-\\d{2}[ T][\\d:.,]+)\\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\\s+([\\s\\S]*)$/;

  function isLogHit(line, pats) {
    for (var i = 0; i < pats.length; i++) {
      if (line.indexOf(pats[i]) >= 0) return true;
    }
    return false;
  }
  // 全局 logHighlight 与证据级 highlight 合并，后者用于个别证据的补充规则
  function evHighlights(e) {
    var own = e && Array.isArray(e.highlight)
      ? e.highlight.filter(function (s) { return typeof s === 'string' && s.length > 0; })
      : [];
    return own.length ? LOG_HIGHLIGHT.concat(own) : LOG_HIGHLIGHT;
  }
  function logLine(line, forceHit) {
    var m = LOG_LEVEL_RE.exec(line);
    var lv = m ? m[2].toLowerCase() : '';
    var cls = 'lg-line' + (lv ? ' lv-' + lv : '') + (forceHit ? ' lg-hit' : '');
    var inner;
    if (m) {
      // Spring 日志把线程/logger 放在 "] : " 之前，之后才是正文；级别/行号右对齐会有多个空格
      var rest = m[3], pre = '', msg = rest;
      var sep = /^([\\s\\S]*?\\]\\s+:\\s)([\\s\\S]*)$/.exec(rest);
      if (sep) { pre = sep[1]; msg = sep[2]; }
      inner = '<span class="lg-ts">' + esc(m[1]) + '</span>' +
        '<span class="lg-lv ' + lv + '">' + esc(m[2]) + '</span>' +
        (pre ? '<span class="lg-pre">' + esc(pre) + '</span>' : '') +
        '<span class="lg-msg">' + (esc(msg) || '&#8203;') + '</span>';
    } else {
      inner = '<span class="lg-msg">' + (esc(line) || '&#8203;') + '</span>';
    }
    return '<div class="' + cls + '">' + inner + '</div>';
  }

  // 表格单元格：null 显示 ∅；命中列语义时显示彩色标签（title 保留原值）；数字右对齐；长值截断
  function evCell(v, col) {
    if (v === null || v === undefined) return '<td class="ev-null" title="null">∅</td>';
    var meta = COL_SEM[col];
    var hit = meta && meta.values && meta.values[String(v)];
    if (hit) {
      return '<td><span class="ev-st ' + esc(hit[0]) + '" title="' + esc(v) + '">' + esc(hit[1]) + '</span></td>';
    }
    var s = String(v);
    if (typeof v === 'number') return '<td class="ev-num">' + esc(s) + '</td>';
    if (s.length > 28) return '<td title="' + esc(s) + '">' + esc(s.slice(0, 27)) + '…</td>';
    return '<td>' + esc(s) + '</td>';
  }
  function evTable(t, e) {
    var cols = t.columns || [], rows = t.rows || [];
    var head = cols.map(function (col) {
      var meta = COL_SEM[col];
      return '<th title="' + esc(col) + '">' + esc(meta && meta.label ? meta.label : col) + '</th>';
    }).join('');
    var body = rows.map(function (row) {
      return '<tr>' + cols.map(function (col, i) { return evCell(row[i], col); }).join('') + '</tr>';
    }).join('');
    var html = '<div class="ev-table"><div class="ev-table-cap"><code>' + esc(t.name || '') + '</code>' +
      (t.where ? '<span class="ev-where">' + esc(t.where) + '</span>' : '') +
      '<span class="ev-rows">' + rows.length + ' 行</span></div>' +
      '<div class="ev-table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
    var sql = t.sql || e.command;
    if (sql) html += '<details class="ev-sql"><summary>查看 SQL</summary><pre>' + esc(sql) + '</pre></details>';
    return html;
  }
  function autoTablesEnabled() {
    return !(REPORT.reportConfig && REPORT.reportConfig.autoTables === false);
  }
  /** 未显式声明 tables 时，尝试把 raw 的 JSON 结果自动转成表格；失败返回 null，保持原文本渲染。 */
  function autoTableFromRaw(e) {
    if (!e.raw) return null;
    var parsed;
    try { parsed = JSON.parse(String(e.raw)); } catch (err) { return null; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      return [{ name: '查询结果', columns: parsed.columns, rows: parsed.rows, sql: e.command || '' }];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (var i = 0; i < parsed.length; i++) {
      if (!parsed[i] || typeof parsed[i] !== 'object' || Array.isArray(parsed[i])) return null;
    }
    var cols = [];
    parsed.forEach(function (row) {
      Object.keys(row).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
    });
    if (!cols.length) return null;
    var rows = parsed.map(function (row) {
      return cols.map(function (c) {
        var v = row[c];
        if (v === null || v === undefined) return null;
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      });
    });
    return [{ name: '查询结果', columns: cols, rows: rows, sql: e.command || '' }];
  }
  function evBody(e, foldRaw) {
    var body = '';
    var req = payloadText(e.request), res = payloadText(e.response);
    if (req) body += '<div class="payload-label">请求</div><pre>' + esc(req) + '</pre>';
    if (res) body += '<div class="payload-label">响应</div><pre>' + esc(res) + '</pre>';
    var tables = Array.isArray(e.tables) ? e.tables : [];
    var autoTabled = false;
    if (!tables.length && autoTablesEnabled()) {
      var auto = autoTableFromRaw(e);
      if (auto) { tables = auto; autoTabled = true; }
    }
    if (tables.length) {
      // 结构化表格已承载行值，command 不再平铺，result 只作结论行
      body += tables.map(function (t) { return evTable(t, e); }).join('');
      if (e.result) body += '<div class="ev-concl">' + esc(e.result) + '</div>';
    } else {
      if (e.command) body += '<pre>' + esc(e.command) + '</pre>';
      if (e.result) body += '<pre>' + esc(e.result) + '</pre>';
    }
    if (e.raw && autoTabled) {
      body += '<details class="ev-raw"><summary>原始输出</summary><pre>' + esc(e.raw) + '</pre></details>';
    } else if (e.raw) {
      // 去掉尾部空行再数行，避免 3 行内容因尾随换行被算成 4 行；CRLF 先归一，避免行尾回车符进入 pre-wrap（本段位于模板字符串内，注释里不可写反斜杠转义）
      var rawLines = String(e.raw).replace(/\\r\\n/g, '\\n').replace(/\\n+$/, '').split('\\n');
      var isLog = rawLines.some(function (l) { return LOG_LEVEL_RE.test(l); });
      if (isLog) {
        var pats = evHighlights(e);
        var hits = [];
        rawLines.forEach(function (l, i) { if (isLogHit(l, pats)) hits.push(i); });
        if (foldRaw && rawLines.length > 3) {
          // 关键行提到折叠块外，不展开也能看到结论
          if (hits.length) {
            body += '<div class="lg-key"><div class="lg-key-cap">关键行 · ' + hits.length + '</div>' +
              hits.map(function (i) { return logLine(rawLines[i], true); }).join('') + '</div>';
          }
          body += '<details class="ev-raw"><summary>原始输出 · ' + rawLines.length + ' 行' +
            (hits.length ? ' · 关键 ' + hits.length + ' 行' : '') + '</summary>' +
            '<div class="ev-log">' + rawLines.map(function (l) { return logLine(l, isLogHit(l, pats)); }).join('') + '</div></details>';
        } else {
          body += '<div class="ev-log">' + rawLines.map(function (l) { return logLine(l, isLogHit(l, pats)); }).join('') + '</div>';
        }
      } else if (foldRaw && rawLines.length > 3) {
        body += '<details class="ev-raw"><summary>原始输出 · ' + rawLines.length + ' 行</summary><pre>' + esc(e.raw) + '</pre></details>';
      } else {
        body += '<pre>' + esc(e.raw) + '</pre>';
      }
    }
    return body;
  }
  function evHead(e) {
    var html = '<div class="ev-head"><code>' + esc(e.id) + '</code><span class="layer-tag">' + esc(e.layer || '其他') + '</span>';
    if (e.at) html += '<span class="ev-at">' + esc(e.at) + '</span>';
    html += '</div>';
    var keys = e.keys && typeof e.keys === 'object' && !Array.isArray(e.keys) ? Object.keys(e.keys) : [];
    if (keys.length) {
      html += '<div class="ev-keys">' + keys.map(function (k) {
        return '<span class="ev-key">' + esc(k) + '<b>' + esc(e.keys[k]) + '</b></span>';
      }).join('') + '</div>';
    }
    return html;
  }
  // 无 flow 的旧报告沿用原 DOM（仅 body，无 id/层头），与改造前的输出保持一致
  function renderEvidenceByLayer(evs) {
    var byLayer = {};
    evs.forEach(function (e) { (byLayer[e.layer || '其他'] = byLayer[e.layer || '其他'] || []).push(e); });
    return Object.keys(byLayer).map(function (layer) {
      return '<details class="ev"><summary>' + esc(layer) + ' · ' + byLayer[layer].length + ' 项</summary>' +
        byLayer[layer].map(function (e) { return evBody(e, false); }).join('') + '</details>';
    }).join('');
  }
  function renderEvidenceByNode(c, evs) {
    var byId = {};
    evs.forEach(function (e) { byId[e.id] = e; });
    var seen = {};
    var html = (c.flow.nodes || []).map(function (n) {
      var refs = (n.evidenceRefs || []).filter(function (id) { return byId[id]; });
      if (!refs.length) return '';
      refs.sort(function (a, b) {
        var ta = byId[a].at, tb = byId[b].at;
        if (!ta) return tb ? 1 : 0;
        if (!tb) return -1;
        ta = String(ta); tb = String(tb);
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      var layers = [];
      refs.forEach(function (id) {
        var l = byId[id].layer || '其他';
        if (layers.indexOf(l) < 0) layers.push(l);
      });
      return '<details class="ev" data-node="' + esc(n.id) + '"><summary><span class="fl-type">' + esc(FLOW_LABELS[n.type] || n.type) + '</span>' +
        esc(n.label) + ' · ' + refs.length + ' 项' +
        layers.map(function (l) { return ' <span class="layer-tag">' + esc(l) + '</span>'; }).join('') + '</summary>' +
        refs.map(function (id) {
          if (seen[id]) return '<div class="ev-ref">同上一条证据 <code>' + esc(id) + '</code></div>';
          seen[id] = true;
          return '<div class="ev-item" data-ev-id="' + esc(id) + '">' + evHead(byId[id]) + evBody(byId[id], true) + '</div>';
        }).join('') + '</details>';
    }).join('');

    var missing = (c.flow.nodes || []).filter(function (n) { return n.unverified === true || n.type === 'missing'; });
    if (missing.length) {
      html += '<div class="ev-missing">未取证节点：' + missing.map(function (n) {
        return '<span class="ev-chip" data-goto-node="' + esc(n.id) + '" title="' + esc(n.note || '设计上无证据') + '">' + esc(n.label) + '</span>';
      }).join('') + '</div>';
    }
    var unbound = evs.filter(function (e) { return !seen[e.id]; });
    if (unbound.length) {
      html += '<details class="ev"><summary>未挂载到流程节点的证据 · ' + unbound.length + ' 项</summary>' +
        unbound.map(function (e) { return '<div class="ev-item" data-ev-id="' + esc(e.id) + '">' + evHead(e) + evBody(e, true) + '</div>'; }).join('') + '</details>';
    }
    return html;
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
    if (c.flow && FLOW_LAYOUTS[c.id]) {
      html += renderFlowSection(c, FLOW_LAYOUTS[c.id]);
    }

    // assertions
    var as = c.assertions || [];
    var hasFlow = !!(c.flow && FLOW_LAYOUTS[c.id]);
    var evIds = {};
    (c.evidence || []).forEach(function (e) { evIds[e.id] = true; });
    html += '<div class="section-label" style="margin-top:16px">断言对照 · ' + as.length + ' 条</div>';
    if (!as.length) {
      html += '<div class="empty">没有断言——PASS 却无断言会被判为 blocker。</div>';
    } else {
      var ths = hasFlow
        ? '<th style="width:34%">预期断言</th><th style="width:30%">实测</th><th style="width:14%">取证层</th><th style="width:12%">证据</th><th style="width:10%">匹配</th>'
        : '<th style="width:38%">预期断言</th><th style="width:34%">实测</th><th style="width:16%">取证层</th><th style="width:12%">匹配</th>';
      html += '<table class="assert"><thead><tr>' + ths + '</tr></thead><tbody>' +
        as.map(function (a) {
          var bad = a.matches !== true || !String(a.actual || '').trim();
          var evCell = '';
          if (hasFlow) {
            evCell = '<td>' + (a.evidenceRef && evIds[a.evidenceRef]
              ? '<a class="ev-jump" role="button" tabindex="0" data-ev="' + esc(a.evidenceRef) + '" title="' + esc(a.evidenceRef) + '">' + esc(a.evidenceRef) + '</a>'
              : '—') + '</td>';
          }
          return '<tr class="' + (bad ? 'bad' : '') + '"><td>' + inlineMd(a.expected) + '</td><td class="mono">' + inlineMd(a.actual) +
            '</td><td><span class="layer-tag">' + esc(a.layer || '—') + '</span></td>' + evCell + '<td class="mark ' + (bad ? 'bad' : 'ok') + '">' +
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
      var byNode = hasFlow;
      html += '<div class="section-label" style="margin-top:18px">原始证据 · ' + evs.length + ' 项' + (byNode ? ' · 按流程节点' : '') + '</div>';
      html += byNode ? renderEvidenceByNode(c, evs) : renderEvidenceByLayer(evs);
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
  function markFlowNode(id) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-flow-node]'), function (g) {
      g.classList.toggle('hl', g.getAttribute('data-flow-node') === id);
    });
  }
  function markEvidenceChip(id) {
    Array.prototype.forEach.call(document.querySelectorAll('.ev-chip[data-goto-node]'), function (c) {
      c.classList.toggle('hl', c.getAttribute('data-goto-node') === id);
    });
  }
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
      Array.prototype.forEach.call(document.querySelectorAll('[data-flow-node]'), function (node) {
        node.addEventListener('click', function () {
          var id = node.getAttribute('data-flow-node');
          markFlowNode(id);
          markEvidenceChip(id);
          var target = null;
          Array.prototype.forEach.call(document.querySelectorAll('details.ev[data-node]'), function (d) {
            if (d.getAttribute('data-node') === id) target = d;
          });
          if (target) { target.open = true; target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.ev-chip[data-goto-node]'), function (chip) {
        chip.addEventListener('click', function () {
          var id = chip.getAttribute('data-goto-node');
          markFlowNode(id);
          markEvidenceChip(id);
          var g = null;
          Array.prototype.forEach.call(document.querySelectorAll('[data-flow-node]'), function (n) {
            if (n.getAttribute('data-flow-node') === id) g = n;
          });
          if (g) g.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.ev-jump[data-ev]'), function (a) {
        function jump(ev) {
          ev.preventDefault();
          var id = a.getAttribute('data-ev');
          var item = null;
          Array.prototype.forEach.call(document.querySelectorAll('.ev-item[data-ev-id]'), function (el) {
            if (!item && el.getAttribute('data-ev-id') === id) item = el;
          });
          if (!item) return;
          var box = item.closest('details');
          if (box) box.open = true;
          item.scrollIntoView({ block: 'center', behavior: 'smooth' });
          item.classList.remove('flash');
          void item.offsetWidth;
          item.classList.add('flash');
          setTimeout(function () { item.classList.remove('flash'); }, 1600);
        }
        a.addEventListener('click', jump);
        a.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') jump(ev);
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
