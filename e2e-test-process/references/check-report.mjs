#!/usr/bin/env node
/**
 * E2E 测试报告通用退出门禁（e2e-test-process 公共库）。
 *
 * 用法：
 *   node check-report.mjs <报告目录|report.json> [--strict]
 *
 * 规则来源：报告 JSON 顶层的 `reportConfig`，项目按需声明：
 *   {
 *     "payloadLayers": ["接口层", "回调层"],          // 这些层的证据必须同时有 request 与 response
 *     "layerFields": { "日志层": ["raw"], "数据层": ["tables"] },  // 各层证据必须包含的字段（数组字段需非空）
 *     "flowRequired": true                             // 默认 true；设为 false 才允许用例不写流程图
 *   }
 *
 * 退出码：0=通过；1=存在错误（--strict 时告警也计为错误）；2=参数/文件问题。
 * 与 render-report.mjs 的分工：render 负责渲染与自身告警；本脚本负责与渲染无关的通用门禁。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
    console.error('usage: node check-report.mjs <dir|json> [--strict]');
    process.exit(2);
}

let file = target;
if (fs.statSync(target).isDirectory()) {
    const files = fs.readdirSync(target).filter((f) => f.endsWith('-test-report.json'));
    if (files.length !== 1) {
        console.error(`期望恰好 1 个 *-test-report.json，实际 ${files.length} 个`);
        process.exit(2);
    }
    file = path.join(target, files[0]);
}

const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = d.reportConfig || {};
const payloadLayers = Array.isArray(cfg.payloadLayers) ? cfg.payloadLayers : [];
const layerFields = cfg.layerFields && typeof cfg.layerFields === 'object' ? cfg.layerFields : {};
const flowRequired = cfg.flowRequired !== false;

const errors = [];
const warns = [];
const infos = [];
const E = (m) => errors.push(m);
const W = (m) => warns.push(m);
const I = (m) => infos.push(m);
let unverifiedNodes = 0;

for (const k of ['schemaVersion', 'meta', 'verdict', 'stats', 'cleanup', 'conclusion', 'cases']) {
    if (d[k] == null) E(`缺少顶层字段 ${k}`);
}
if (!Array.isArray(d.cases) || !d.cases.length) E('cases 为空');

const templates = d.flowTemplates || {};
const NO_EVIDENCE_NODE = new Set(['start', 'end', 'decision', 'missing']);

const hasField = (e, field) => {
    const v = e[field];
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
};

for (const c of d.cases || []) {
    const id = c.id || '(无 id)';

    if (flowRequired && !c.flow && !c.flowRef) E(`${id}: 缺少 flow/flowRef（测试流程图）`);

    if (!Array.isArray(c.assertions) || !c.assertions.length) {
        E(`${id}: 缺少 assertions`);
    }
    for (const a of c.assertions || []) {
        for (const f of ['expected', 'actual', 'layer']) {
            if (a[f] == null || a[f] === '') E(`${id}: 断言缺少 ${f}`);
        }
        if (typeof a.matches !== 'boolean') W(`${id}: 断言缺少 matches（预期与实测是否一致）`);
    }

    const evIds = new Set((c.evidence || []).map((e) => e.id));
    for (const e of c.evidence || []) {
        if (!e.at) W(`${id}/${e.id}: 证据缺少 at（时间点）`);
        for (const [layer, fields] of Object.entries(layerFields)) {
            if (e.layer !== layer) continue;
            for (const f of Array.isArray(fields) ? fields : [fields]) {
                if (!hasField(e, f)) E(`${id}/${e.id}: ${layer}证据缺少字段 ${f}`);
            }
        }
        if (payloadLayers.includes(e.layer) && (!hasField(e, 'request') || !hasField(e, 'response'))) {
            W(`${id}/${e.id}: ${e.layer}证据未同时提供 request/response（该层声明了报文要求）`);
        }
    }
    // 报文层：该层至少一条证据同时含 request 与 response（「未发生」类断言豁免）
    for (const layer of payloadLayers) {
        const layerAssertions = (c.assertions || []).filter((a) => a.layer === layer);
        if (!layerAssertions.length) continue;
        const evs = (c.evidence || []).filter((e) => e.layer === layer);
        if (!evs.length) continue;
        const ok = evs.some((e) => hasField(e, 'request') && hasField(e, 'response'));
        if (!ok) E(`${id}: ${layer}缺少同时包含 request/response 的证据`);
    }

    let nodes = [];
    let active = new Set();
    if (c.flow) {
        nodes = c.flow.nodes || [];
        active = new Set(nodes.map((n) => n.id));
    } else if (c.flowRef) {
        const t = templates[c.flowRef.template];
        if (!t) {
            E(`${id}: flowRef.template 不存在: ${c.flowRef.template}`);
            continue;
        }
        nodes = t.nodes || [];
        const branch = c.flowRef.branch ? (t.branches || {})[c.flowRef.branch] : null;
        if (c.flowRef.branch && !branch) E(`${id}: flowRef.branch 不存在: ${c.flowRef.branch}`);
        active = new Set(branch ? branch.nodes || [] : nodes.map((n) => n.id));
    }
    const overrides = (c.flowRef && c.flowRef.nodeOverrides) || {};
    const refs = (c.flowRef && c.flowRef.evidenceRefs) || {};
    for (const n of nodes) {
        if (!active.has(n.id) || NO_EVIDENCE_NODE.has(n.type)) continue;
        const ov = overrides[n.id] || {};
        const unverified = ov.unverified != null ? ov.unverified : n.unverified;
        const note = ov.note != null ? ov.note : n.note;
        const nodeRefs = [...(refs[n.id] || []), ...(n.evidenceRefs || [])];
        for (const r of nodeRefs) {
            if (!evIds.has(r)) E(`${id}: 节点 ${n.id} 引用了不存在的证据 ${r}`);
        }
        if (!nodeRefs.length) {
            if (unverified !== true) {
                E(`${id}: 节点 ${n.id} 未挂证据且未标 unverified（会渲染为缺失）`);
            } else if (!note) {
                E(`${id}: 节点 ${n.id} 标了 unverified 但缺少 note 说明`);
            } else {
                unverifiedNodes++;
            }
        }
    }
}

if (d.cleanup) {
    if (!Number.isFinite(d.cleanup.residual)) E('cleanup.residual 必须是数字（残留行数）');
    if (!(Number(d.cleanup.checkedItems) > 0)) E('cleanup.checkedItems 必须是正数（回查项数）');
}
if (unverifiedNodes > 0) I(`共 ${unverifiedNodes} 个流程节点标为未取证（均有 note 说明）`);

const fail = errors.length > 0 || (strict && warns.length > 0);
console.log(
    `check-report: ${path.basename(file)} | 用例 ${(d.cases || []).length} | 错误 ${errors.length} | 告警 ${warns.length} | 提示 ${infos.length}${strict ? ' (strict)' : ''}`,
);
for (const m of errors) console.log('  ✗ ' + m);
for (const m of warns) console.log('  · ' + m);
for (const m of infos) console.log('  i ' + m);
process.exit(fail ? 1 : 0);
