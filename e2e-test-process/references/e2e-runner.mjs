#!/usr/bin/env node
/**
 * Plan-first E2E 执行器（公共库）。
 *
 * 用法：
 *   node e2e-runner.mjs --plan <plan.json> --adapter <adapter.mjs> [--case TC-001] [--out run.json] [--env test]
 *
 * 职责：变量解析、拓扑调度、断言、证据组装、输出 `-test-run.json`。
 * 具体连库/发请求/取日志由项目适配器实现（契约见 references/test-plan-schema.md §5）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
    const out = { cases: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--case') out.cases.push(argv[++i]);
        else if (a.startsWith('--case=')) out.cases.push(a.slice(7));
        else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv);
for (const required of ['plan', 'adapter']) {
    if (!args[required]) {
        console.error(`missing --${required}`);
        process.exit(2);
    }
}
const planPath = path.resolve(args.plan);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const adapter = await import(pathToFileURL(path.resolve(args.adapter)).href);
const projectRoot = path.resolve(args['project-root'] || process.cwd());
const ctx = { projectRoot, env: args.env || 'test', workspace: path.dirname(planPath) };

const resolveStr = (s, vars) => s.replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `\${${k}}`));
const resolveDeep = (v, vars) => {
    if (typeof v === 'string') return resolveStr(v, vars);
    if (Array.isArray(v)) return v.map((x) => resolveDeep(x, vars));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, vars)]));
    return v;
};

function topoSort(nodes, edges) {
    const ids = nodes.map((n) => n.id);
    const indeg = new Map(ids.map((id) => [id, 0]));
    const next = new Map(ids.map((id) => [id, []]));
    for (const [from, to] of edges || []) {
        if (!indeg.has(from) || !indeg.has(to)) throw new Error(`edge 引用不存在节点: ${from}->${to}`);
        next.get(from).push(to);
        indeg.set(to, indeg.get(to) + 1);
    }
    const queue = ids.filter((id) => indeg.get(id) === 0);
    const order = [];
    while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const to of next.get(id)) {
            indeg.set(to, indeg.get(to) - 1);
            if (indeg.get(to) === 0) queue.push(to);
        }
    }
    if (order.length !== ids.length) throw new Error('plan 存在环');
    return order;
}

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a, b) => {
    if (a == null || b == null) return a == b;
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
    return String(a).trim() === String(b).trim();
};

function evalExpect(expect, r) {
    if (!expect) return [];
    return Object.entries(expect).map(([key, expected]) => {
        let actual;
        if (key === 'rowCount') actual = r.rowCount;
        else if (key === 'affected') actual = r.affected;
        else if (key === 'status') actual = r.status;
        else if (key === 'contains') actual = (r.raw || (r.lines || []).join('\n'));
        else if (key.startsWith('firstRow.')) {
            const col = key.slice(9);
            actual = r.rows && r.rows[0] ? r.rows[0][r.columns.indexOf(col)] : undefined;
        } else if (key.startsWith('json.')) actual = getPath(r.json, key.slice(5));
        else actual = undefined;
        const ok = key === 'contains' ? String(actual || '').includes(String(expected)) : same(actual, expected);
        return { key, expected, actual, ok };
    });
}

function buildEvidence(node, r, at, caseId) {
    const cfg = node.evidence || {};
    const ev = { id: `ev-${caseId}-${node.id}`, layer: cfg.layer, at, command: r.command };
    const captures = String(cfg.capture || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (captures.includes('tables')) {
        ev.tables = [{ name: node.detail || node.id, where: node.detail, sql: node.sql, columns: r.columns || [], rows: r.rows || [] }];
        ev.result = `${r.rowCount ?? (r.rows || []).length} 行`;
    }
    if (captures.includes('request')) ev.request = r.requestBody;
    if (captures.includes('response')) {
        ev.response = r.json == null ? r.raw : JSON.stringify(r.json);
        ev.result = `HTTP ${r.status}`;
    }
    if (captures.includes('raw')) {
        ev.raw = r.raw || (r.lines || []).join('\n');
        ev.result = (r.lines || []).length ? `${r.lines.length} 行日志` : '无日志';
        if (node.expect && node.expect.contains) ev.highlight = [node.expect.contains];
    }
    return ev;
}

async function runNode(node) {
    switch (node.action) {
        case 'sql.exec': return adapter.sqlExec(ctx, node);
        case 'sql.query': return adapter.sqlQuery(ctx, node);
        case 'http.post': return adapter.httpRequest(ctx, { method: 'POST', url: node.url, body: node.body, headers: node.headers });
        case 'log.fetch': return adapter.fetchLog(ctx, node);
        default: throw new Error(`未知 action: ${node.action}`);
    }
}

const selected = args.cases.length ? args.cases : plan.cases.map((c) => c.id);
const run = { schemaVersion: 1, plan: planPath, env: ctx.env, startedAt: new Date().toISOString(), cases: [] };
let caseFailed = false;

for (const casePlan of plan.cases.filter((c) => selected.includes(c.id))) {
    const vars = { ...(plan.variables || {}), ...(casePlan.vars || {}) };
    const record = { id: casePlan.id, title: casePlan.title, priority: casePlan.priority,
        requirements: casePlan.requirements || [], requirementStatement: casePlan.requirementStatement,
        fixtures: [], nodes: [], cleanup: [], notes: [] };
    const statusById = new Map();
    try {
        for (const fx of casePlan.fixtures || []) {
            const f = resolveDeep(fx, vars);
            const r = await adapter.sqlExec(ctx, f);
            record.fixtures.push({ status: r.ok ? 'PASS' : 'FAIL', command: r.command, affected: r.affected, error: r.error });
            if (!r.ok) throw new Error(`fixture 失败: ${r.error || ''}`);
        }
        const order = topoSort(casePlan.nodes, casePlan.edges);
        const byId = new Map(casePlan.nodes.map((n) => [n.id, n]));
        for (const id of order) {
            const rawNode = byId.get(id);
            const node = resolveDeep(rawNode, vars);
            const preds = (casePlan.edges || []).filter(([, to]) => to === id).map(([from]) => from);
            const blocked = preds.some((p) => ['FAIL', 'BLOCKED'].includes(statusById.get(p)));
            if (blocked) {
                statusById.set(id, 'BLOCKED');
                record.nodes.push({ id, status: 'BLOCKED', reason: '前驱失败' });
                continue;
            }
            const at = new Date().toISOString().slice(11, 19);
            if (['start', 'end', 'decision'].includes(node.type) && !node.action) {
                record.nodes.push({ id, status: 'PASS', synthetic: true });
                statusById.set(id, 'PASS');
                continue;
            }
            try {
                const r = await runNode(node);
                const checks = evalExpect(node.expect, r);
                let status = checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
                if (status === 'FAIL' && node.optional) status = 'UNVERIFIED';
                const ev = node.evidence ? buildEvidence(node, r, at, casePlan.id) : undefined;
                record.nodes.push({ id, status, actual: r.rows ? { rowCount: r.rowCount, firstRow: r.rows[0] } : r.json ?? r.affected,
                    command: r.command, at, checks, evidence: ev, error: r.error });
                if (status === 'UNVERIFIED') record.notes.push(`${id} unverified: ${node.note || 'optional 未取证'}`);
                statusById.set(id, status);
                if (status === 'FAIL') caseFailed = true;
            } catch (e) {
                statusById.set(id, 'FAIL');
                caseFailed = true;
                record.nodes.push({ id, status: 'FAIL', error: e.message });
            }
        }
    } finally {
        for (const cl of casePlan.cleanup || []) {
            try {
                const r = await adapter.sqlExec(ctx, resolveDeep(cl, vars));
                record.cleanup.push({ status: r.ok ? 'PASS' : 'FAIL', command: r.command, affected: r.affected });
            } catch (e) {
                record.cleanup.push({ status: 'FAIL', error: e.message });
            }
        }
    }
    record.status = record.nodes.some((n) => n.status === 'FAIL') ? 'FAIL'
        : record.nodes.some((n) => n.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
    run.cases.push(record);
    console.log(`${record.id}: ${record.status} (${record.nodes.filter((n) => n.status === 'PASS').length}/${record.nodes.length} nodes PASS)`);
}

run.finishedAt = new Date().toISOString();
const outPath = path.resolve(args.out || path.join(path.dirname(planPath), '-test-run.json'));
fs.writeFileSync(outPath, JSON.stringify(run, null, 2));
console.log(`run written: ${outPath}`);
process.exit(caseFailed ? 1 : 0);
