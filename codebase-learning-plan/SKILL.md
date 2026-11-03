---
name: codebase-learning-plan
description: 为任意代码项目或模块生成可执行的 7 天源码学习计划：模块拆分、核心功能点、知识要点、技术栈、技术难点、源码清单与阅读顺序、1-2 条核心流程的逐段源码走读、每模块思考题与验收标准。Use when the user asks for a 7-day or crash-course learning plan, a structured source-reading guide, a codebase onboarding curriculum, or asks "如何学习这个项目/模块" "给我一个源码阅读计划" "7 天学会这个项目".
---

# Codebase Learning Plan

## Overview

Produce a **reading route**, not a summary. The deliverable is a 7-day plan whose every module can be studied from real source files, whose every core flow is traced through real `path:line` anchors, and whose thinking questions are answerable from those anchors.

Default assumptions (state them, then proceed): whole repository, 7 days, 2-4 hours per day, reader knows the project's primary language.

## Workflow

### Step 1 — Scope the target

- Default: entire repository at the given path.
- If the user names a module, plan that module plus its direct dependencies.
- If the user gives no repo path, use the current working directory.
- Ask only when the target is genuinely ambiguous (multiple repos, or an unclear module boundary). Do not block on audience level or time budget; assume defaults and say so.

### Step 2 — Inventory deterministically

Run the inventory script instead of guessing:

```bash
python3 scripts/repo_inventory.py <repo> --top 40
```

It reports language mix, LOC, manifests, entry-point candidates, largest files, test locations, and top-level directories.

Then read, in order:

1. `README*`, `docs/design*`, `docs/architecture*`, `HANDOFF*`
2. Manifest: `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`
3. Entry files from the inventory output
4. Headers and exports of the 10 largest source files

Confirm architecture from imports, calls, and config — never from filenames alone. If docs disagree with code, prefer code and note the drift.

### Step 3 — Build the module map

Produce a table: **module / responsibility / key directories / days / why it matters**.

Rules:

- Choose **5-8 modules** for 7 days. Fewer is better than a shallow sweep.
- Order by dependency, not directory order: common layer → core domain → orchestration → adapters/IO → cross-cutting → end-to-end.
- Day 1 is always **architecture + common layer** (entry, config, errors, shared models).
- Day 7 is always **end-to-end integration + self-assessment**.
- If the project is small, compress to 3-5 days and say so explicitly.
- If the project is very large, keep 7 days but mark optional modules as "选读".

Selection heuristics are in `references/source-reading-method.md` §1.

### Step 4 — Write every module card

For **each** module, include all eight fields:

1. **模块定位** — where it sits, upstream/downstream, what breaks without it
2. **核心功能点** — 3-7 bullet points, each with its entry command/API
3. **知识要点** — language/framework/protocol/domain knowledge actually used here
4. **技术栈** — technology, where it is used, required depth
5. **技术难点** — difficulty → how the project solves it → which code proves it
6. **源码地图 + 阅读顺序** — file table (path / responsibility / priority / reading mode) + ordered 1-2-3 reading path
7. **核心流程 1-2 条** — see Step 5
8. **思考题 3-5 道 + 今日验收** — see Step 6

### Step 5 — Trace 1-2 core flows per module

Each flow must contain:

- **一句话链路**: input → key processing → output
- **链路图**: ASCII, with module boundaries marked
- **源码走读**: 5-8 anchored steps. Each step uses `path/to/file.ext:line` and answers four questions:
  1. What does it do (input/output/state change)?
  2. Why is it at this layer (why not one layer up/down)?
  3. What is the boundary (null, timeout, concurrency, permission, truncation, encoding)?
  4. What happens on failure (throw/error code/degrade/retry), and how does the caller see it?
- **关键数据结构**: name + fields + why designed this way
- **设计权衡**: why not the alternative; what it costs

Prefer one **happy path** + one **failure/recovery path** per module (permission denied, timeout, retry, rollback, degradation). A module with only a happy path gets a shallower card; say so rather than padding.

Flow selection and depth calibration are in `references/source-reading-method.md` §2-3.

### Step 6 — Write thinking questions

3-5 per module, spanning at least three of these levels:

| Level | Purpose |
|---|---|
| 事实 | confirm the reader located the code |
| 机制 | explain causality and ordering |
| 设计 | judge tradeoffs and extension points |
| 延伸 | connect to other modules or external contracts |

No yes/no questions. Every question must be answerable from the cited anchors. Add a short **今日验收** checklist (can draw the chain, can name 3 data structures, can explain 2 error branches, can answer the questions).

Question design rules are in `references/source-reading-method.md` §4.

### Step 7 — Verify before delivery

1. Write the plan to a Markdown file.
2. Run:

```bash
python3 scripts/check_refs.py <plan.md> --root <repo>
```

3. Fix every missing file and every out-of-range line number. Do not ship with a failed check.
4. Spot-check three flows: can they be followed in order without other materials?
5. Spot-check three questions: does the answer follow from the cited code?
6. Check daily load: if a day exceeds ~4 hours, split it or mark part as 选读.

### Step 8 — Deliver

- Default output: `docs/<project>-7day-learning-plan.md`.
- If the file exists, read it first and ask before overwriting.
- If the user wants chat-only output, print the full plan in the chat.
- Precede the full document with a short orientation: one-paragraph positioning + module map + recommended reading order.

## Output contract

Use `references/output-template.md` as the structure. Do not invent extra top-level sections; an appendix for glossary/index/references is fine.

## Quality gates

- Every module has at least 1 flow; every flow has at least 5 code anchors.
- Every `path:line` reference exists and is in range (checked by script).
- No invented APIs, commands, flags, or file names.
- No generic textbook content that could apply to any repository.
- Questions are non-trivial and anchored.
- 7 days is a default; any compression or extension is explicitly stated.
- The reader can answer "改一个功能要碰哪些文件" after Day 7.

## Anti-shortcuts

- Do not paraphrase the README and call it a plan.
- Do not read every file; select and justify.
- Do not fabricate line numbers or flows. If a flow cannot be traced, choose another and say why.
- Do not write "this function does X" without explaining why it exists and what breaks otherwise.
- Do not order modules by folder listing; order by dependency.

## Resources

- `scripts/repo_inventory.py` — deterministic repository inventory (languages, manifests, entries, largest files, tests)
- `scripts/check_refs.py` — validates every `path:line` in the generated plan
- `references/output-template.md` — required document structure and writing quality bar
- `references/source-reading-method.md` — module/flow selection, walkthrough depth, question design, anti-patterns
