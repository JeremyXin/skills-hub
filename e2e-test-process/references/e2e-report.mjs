#!/usr/bin/env node
/**
 * Plan-first E2E 报告生成器（公共库）：把 plan + `-test-run.json` 转成报告三件套的基础结构。
 *
 * 用法：
 *   node e2e-report.mjs --plan <plan.json> --run <run.json> --out-dir <dir> --meta <meta.json> [--name prefix]
 *
 * 输出：<prefix>-test-report.json / <prefix>-test-report.md；随后用 render-report.mjs 出 HTML。
 * 每条用例的 flow 只包含该用例自己的节点（内联 flow），不使用共享模板。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
}
for (const k of ['plan', 'run', 'out-dir', 'meta']) {
    if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
}
const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
const run = JSON.parse(fs.readFileSync(args.run, 'utf8'));
const meta = JSON.parse(fs.readFileSync(args.meta, 'utf8'));
const outDir = path.resolve(args['out-dir']);
fs.mkdirSync(outDir, { recursive: true });
const prefix = args.name || path.basename(args.plan, '.json').replace('-test-plan', '');

const planCases = new Map(plan.cases.map((c) => [c.id, c]));
const reportCases = [];
const requirementIds = [];

for (const rc of run.cases) {
    const pc = planCases.get(rc.id);
    if (!pc) continue;
    const vars = { ...(plan.variables || {}), ...(pc.vars || {}) };
    const evidence = [];
    const assertions = [];
    const layers = new Set();
    const nodeById = new Map((pc.nodes || []).map((n) => [n.id, n]));
    const runById = new Map(rc.nodes.map((n) => [n.id, n]));

    for (const n of pc.nodes) {
        const rn = runById.get(n.id);
        if (!rn) continue;
        if (rn.evidence) {
            const ev = { ...rn.evidence };
            if (ev.layer === '数据层' && vars.buyer) {
                ev.keys = { contactWa: vars.buyer, distributionId: vars.dist };
            }
            evidence.push(ev);
            layers.add(ev.layer);
        }
        for (const chk of rn.checks || []) {
            assertions.push({ expected: chk.expected, actual: chk.actual,
                layer: rn.evidence ? rn.evidence.layer : '服务层', matches: chk.ok,
                evidenceRef: rn.evidence ? rn.evidence.id : undefined });
        }
    }

    // 内联 flow：只含本用例节点
    const flowNodes = [];
    const firstIds = pc.nodes.length ? (pc.edges || []).length
        ? pc.nodes.map((n) => n.id).filter((id) => !(pc.edges || []).some(([, to]) => to === id))
        : [pc.nodes[0].id] : [];
    const lastIds = pc.nodes.length ? (pc.edges || []).length
        ? pc.nodes.map((n) => n.id).filter((id) => !(pc.edges || []).some(([from]) => from === id))
        : [pc.nodes[pc.nodes.length - 1].id] : [];
    flowNodes.push({ id: 'start', type: 'start', label: '开始' });
    for (const n of pc.nodes) {
        const rn = runById.get(n.id);
        const node = { id: n.id, type: n.type, label: n.label, detail: n.detail };
        const refs = rn && rn.evidence ? [rn.evidence.id] : [];
        if (refs.length) node.evidenceRefs = refs;
        if (rn && rn.status === 'UNVERIFIED') {
            node.unverified = true;
            node.note = n.note || 'optional 未取证';
        }
        if (rn && rn.status === 'BLOCKED') {
            node.unverified = true;
            node.note = '前驱失败，未执行';
        }
        flowNodes.push(node);
    }
    flowNodes.push({ id: 'end', type: 'end', label: '结束' });
    const flowEdges = [
        ...firstIds.map((id) => ({ from: 'start', to: id })),
        ...(pc.edges || []).map(([from, to]) => ({ from, to })),
        ...lastIds.map((id) => ({ from: id, to: 'end' })),
    ];

    requirementIds.push(...(pc.requirements || []));
    reportCases.push({
        id: pc.id, title: pc.title, priority: pc.priority, verdict: rc.status,
        requirements: pc.requirements || [], implementation: pc.implementation,
        layers: [...layers], requirementStatement: pc.requirementStatement,
        assertions, evidence,
        flow: { direction: 'LR', nodes: flowNodes, edges: flowEdges },
        gaps: (rc.notes || []),
    });
}

const reqs = [...new Set(requirementIds)].map((id) => ({ id, title: meta.requirementTitles?.[id] || id }));
const byPriority = {};
for (const c of reportCases) {
    const p = byPriority[c.priority] ||= { priority: c.priority, total: 0, pass: 0, fail: 0, blocked: 0 };
    p.total++;
    if (c.verdict === 'PASS') p.pass++;
    else if (c.verdict === 'FAIL') p.fail++;
    else p.blocked++;
}

const report = {
    schemaVersion: 1,
    requirement: meta.requirement,
    env: meta.env || run.env,
    reportDate: meta.reportDate || new Date().toISOString().slice(0, 10),
    meta: { branch: meta.branch, commit: meta.commit, carrier: meta.carrier,
        executedAt: meta.executedAt || run.finishedAt, executor: meta.executor },
    reportConfig: meta.reportConfig || {
        payloadLayers: ['接口层'],
        layerFields: { '日志层': ['raw'], '数据层': ['tables'] },
        flowRequired: true,
    },
    verdict: meta.verdict || { publishable: true, summary: '', conditions: [] },
    executionHistory: meta.executionHistory || [],
    requirements: reqs,
    cases: reportCases,
    stats: { byPriority: Object.values(byPriority) },
    defects: meta.defects || [],
    notCovered: meta.notCovered || [],
    cleanup: meta.cleanup || { method: '', checkedItems: 1, residual: 0, detail: '' },
    conclusion: meta.conclusion || [],
};

const jsonPath = path.join(outDir, `${prefix}-test-report.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const md = [];
md.push(`# ${meta.requirement} 测试报告`, '');
md.push('## 1. 基本信息', '');
md.push(`- 分支 / commit：\`${meta.branch}\` @ \`${meta.commit}\``);
md.push(`- 测试环境：${meta.env}，载体：${meta.carrier}`);
md.push(`- 执行时间 / 执行人：${meta.executedAt} / ${meta.executor}`, '');
md.push('## 2. 执行统计', '', '| 优先级 | 总数 | PASS | FAIL | BLOCKED |', '|---|---|---|---|---|');
for (const s of report.stats.byPriority) md.push(`| ${s.priority} | ${s.total} | ${s.pass} | ${s.fail} | ${s.blocked} |`);
md.push('', '## 3. 逐例证据', '');
for (const c of reportCases) {
    md.push(`#### ${c.id} ${c.title} —— ${c.verdict}`, '');
    md.push(`- **评测方式**：${c.layers.join(' + ')}`);
    md.push(`- **测试流程**：${c.flow.nodes.map((n) => n.label).join(' → ')}`);
    md.push('- **具体证据**：');
    c.evidence.forEach((e, i) => {
        md.push(`  ${i + 1}. 【${e.layer}】\`${e.command}\` → \`${e.result || ''}\``);
    });
    md.push('', `- **证据摘要**：${c.requirementStatement || ''}`, '');
}
md.push('## 4. 结论', '', ...((meta.conclusion || []).map((x) => `- ${x}`)));
const mdPath = path.join(outDir, `${prefix}-test-report.md`);
fs.writeFileSync(mdPath, md.join('\n'));

console.log(`report json: ${jsonPath}`);
console.log(`report md:   ${mdPath}`);
console.log('next: node ~/.claude/skills/e2e-test-process/references/render-report.mjs <out-dir>');
