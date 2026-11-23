#!/usr/bin/env node
/**
 * 夹具回归：对 fixtures 目录跑一遍渲染器，断言每份夹具产生的告警码集合与 expected.json 一致。
 *
 * 用法：node ~/.claude/skills/e2e-test-process/references/fixtures/run.mjs
 * 退出码：0 全部一致；1 有差异。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const renderer = join(here, '..', 'render-report.mjs');
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'));

let stdout = '';
try {
  stdout = execFileSync(process.execPath, [renderer, here], { encoding: 'utf8' });
} catch (err) {
  // --strict 未启用，渲染器异常时没有 stdout 也是失败
  console.error(err.stdout || '');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// 输出形如：✓ flow-linear-test-report.json → ...  (0 blocker, 0 warn)，随后缩进 4 空格的告警行
const actual = {};
let cur = null;
for (const line of stdout.split('\n')) {
  const head = /^[✓⚠✕] (\S+-test-report\.json) → /.exec(line);
  if (head) { cur = head[1]; actual[cur] = new Set(); continue; }
  const alarm = /^\s{4}\[\w+\] ([A-Z][A-Z_]*):/.exec(line);
  if (alarm && cur) actual[cur].add(alarm[1]);
}

let failed = 0;
for (const [file, want] of Object.entries(expected)) {
  const got = actual[file] ? [...actual[file]].sort() : null;
  if (!got) {
    console.error(`✕ ${file}: 渲染器未产出该夹具的输出`);
    failed++;
    continue;
  }
  const wantSorted = [...want].sort();
  const same = got.length === wantSorted.length && got.every((c, i) => c === wantSorted[i]);
  if (same) {
    console.log(`✓ ${file}: ${got.length ? got.join(', ') : '无告警'}`);
  } else {
    console.error(`✕ ${file}\n    期望: ${wantSorted.join(', ') || '（无）'}\n    实际: ${got.join(', ') || '（无）'}`);
    failed++;
  }
}

const extra = Object.keys(actual).filter((f) => !(f in expected));
if (extra.length) console.error(`✕ 未在 expected.json 登记的夹具：${extra.join(', ')}`);

if (failed || extra.length) {
  console.error(`\n夹具回归失败：${failed + extra.length} 项`);
  process.exit(1);
}
console.log(`\n夹具回归通过：${Object.keys(expected).length} 份`);
