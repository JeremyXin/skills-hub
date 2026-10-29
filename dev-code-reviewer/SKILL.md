---
name: dev-code-reviewer
description: 手动触发的代码审查。审查当前分支相对指定基线的改动，按目标一致性、兼容性、运行时、性能、安全、规范架构、测试文档七个方向逐项 checklist 取证，输出 7 节结构化报告（含问题与影响面总结）。审查目标由主会话整理为 intent 传入（可来自手动传入的 plan，也可由会话总结），reviewer 不读取计划文件。只读，不修改代码，不进入需求流水线。当用户调用 /dev-code-reviewer，或要求"审查这个分支 / 这次改动 / 合入前自查"时使用。
---

# 三轴代码审查

把一次代码审查拆成 Spec（目标对齐）/ Standards（规范与质量）/ Risk（运行时与工程风险）三个视角，交给 `dev-code-reviewer` 一次完成。主会话只负责定范围、给输入、展示结论。

## 参数

`$ARGUMENTS` 格式：`[base] [plan 路径]`

- `base`：git 基线 ref/SHA。缺省为 `origin/master-v3`。
- `plan 路径`：可选。用于辅助主会话整理 intent；不传时由 commit/diff 总结。

**不自动查找计划文档。** 不要扫描 `docs/plans`、不要按分支名猜测；intent 由主会话显式整理。

## 0. 确定审查范围

1. 解析参数；`base` 缺省 `origin/master-v3`。
2. 校验（`<base>` 是占位符，执行时必须替换成实际 ref/SHA）：
   ```bash
   git rev-parse --verify <base>
   git rev-parse HEAD
   git diff --stat <base>...HEAD
   ```
   - ref 无法解析 → 直接报错，结束。
   - diff 为空 → 告知"当前分支相对 <base> 无改动"，结束，不派 agent。
3. 检查未提交改动：`git status --short` 非空时提示用户"以下改动未提交，不在本次审查范围内"，并问是否改用工作区审查（此时 `mode=worktree`、`head=WORKTREE`，命令改为 `git diff <base>`）。不要默认把未提交内容混进来。

## 1. 整理 intent（主会话职责）

intent 是 reviewer 判断"该做什么"的依据，由主会话整理后随 prompt 传入。reviewer 不读取计划文件，也不自行推断目标。

1. **传了 plan 路径且文件存在**：读文件，提炼改动目标（必要时附验收要点）。
2. **未传或文件不存在**：基于 `git log <base>..HEAD --oneline`、diff 与工作区状态，总结本次功能目标。文件不存在时告知用户"plan 不存在，intent 改由会话总结"。
3. intent 必须写进派发 prompt，不能只给路径让 reviewer 自己读。
4. 把 intent 告知用户，便于其判断是否需要补充 plan。

目录式计划由用户直接传具体文件（如 `s6-final-design.md`）；扁平式传 `*-implementation.md` 或 `*-design.md`。skill 不替用户挑选。

## 2. 收集规范来源

```bash
ls .claude/rules/*.md
```

把 `.claude/CLAUDE.md` 和实际存在的 `.claude/rules/*.md` 路径一并交给 reviewer。不要预先把规则内容贴进 prompt——让 reviewer 自己读，避免复述失真。

## 3. 派发 reviewer

Agent 工具参数：`subagent_type: dev-code-reviewer`，`prompt` 按下面模板填写。

**模板里的 `<...>` 是占位符，必须替换成实际值，不要原样拷贝 agent 定义里的命令。**

```text
审查范围
- base: <完整 SHA>
- head: <完整 SHA，工作区模式写 WORKTREE>
- mode: commit / worktree
- base 描述: <分支/标签名>
- head 描述: <分支名>

在仓库根目录 <path> 下执行：
- commit 模式：
  git log <base>..<head> --oneline
  git diff --stat <base>...<head>
  git diff <base>...<head>
- worktree 模式：
  git diff --stat <base>
  git diff <base>

输入材料
- intent: <改动目标/意图，可为空>
- standards: <路径列表>
- 历史账本: <有：列出既有问题与处置；无：无>

输出要求
- 严格按 agent 定义中的报告结构：Basic information / What Problem / 1. Code Change Review / 2. Code Quality Assessment / 3. Issues / 4. Merge Recommendation
- 每个方向小节保留分点列出的 checklist 状态（条目 / 状态 / 证据）
- 未执行的命令/测试与 UNKNOWN 缺口写在 Basic information 或对应 checklist 的 Evidence
- 只读：不修改文件、不派生子 agent
```

不要把自己对代码的判断塞进 prompt，reviewer 必须独立取证；也不要把 agent 正文整段复述进 prompt（它已经在系统提示里）。

## 4. 展示结果

reviewer 报告是固定的报告结构，**原样展示，不要压缩成"严重/重要/次要"三段式，也不要重排问题**：

1. `Basic information` + `What Problem Does This Change Solve?` —— 确认审查范围、intent、影响面（Blast radius）与审查范围说明。
2. `1. Code Change Review` —— 1.1 目标/intent 对齐、1.2 核心逻辑与运行时、1.3 兼容性、1.4 性能、1.5 安全，逐节看。
3. `2. Code Quality Assessment` —— 2.1 规范与架构、2.2 测试、2.3 文档。
4. `3. Issues` —— 3.1 Summary 表 + 3.2 Details 每条问题；Summary 与 Details 编号必须一致。
5. `4. Merge Recommendation` —— Conclusion / Blockers / Recommended，只引用 Issue 编号，不重复问题描述。

展示纪律：

- 每个方向小节必须保留分点列出的 checklist 状态；`FAIL` 与 `UNKNOWN` 不得隐藏或合并。
- 每份报告都要展示 1.1 的 intent 映射与文件归因；若 intent 由会话总结，提示用户"如需对齐原始需求可带 plan 路径重跑"。
- 需要额外强调时，只补充不改写：例如"Basic information 的审查范围说明显示本地测试未执行，合并前需补跑"。

展示后结束回合，问用户"是否按这些问题修复？修哪些？"。**不要自动改代码。**

## 硬性约束

- 本 skill 只读：不修改业务代码、不提交、不写 `state.json`。
- 不参与 `req-pipeline`，也不替换提交前的 `requesting-code-review` 流程。
- 子 agent 不能向用户提问；所有澄清由主会话完成。
- 用户指定审查未提交改动时，明确说明此时审的是工作区而非 commit 区间。

## 降级路径

| 场景 | 处理 |
|------|------|
| base 不存在 / diff 为空 | 直接结束，不派 agent |
| plan 未传 | 主会话根据 commit/diff 总结 intent |
| plan 路径不存在 | 告知用户并改由会话总结 intent，不猜其他计划文档 |
| diff 过大 | reviewer 自行分 pass，并在报告里说明 |
| 只读命令被拒 | 提示用户调整权限，不要绕过 |
