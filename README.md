# skills-hub

收集和维护高质量的 Claude Code Skill,让常用的工作流以可复用、可版本化的方式沉淀下来。

## Skills

| Skill | 作用 |
|-------|------|
| [codebase-learning-plan](./codebase-learning-plan/SKILL.md) | 为任意代码项目或模块生成可执行的 7 天源码学习计划,含模块拆分、核心流程逐段源码走读、思考题与引用校验脚本。 |
| [dev-code-reviewer](./dev-code-reviewer/SKILL.md) | 对当前分支相对基线的改动做只读代码审查,按目标对齐、规范与质量、运行时风险三个视角逐项取证,输出结构化报告与合并建议。 |

依赖子 agent 的 skill,其定义放在 [agents/](./agents/) 下,安装时需同时链接到 Claude Code 的 agents 目录。

## 本地安装

用软链接把本仓的 skill 挂到 `~/.claude/skills/`,这样改本仓即生效、且可用 git 版本化:

```bash
ln -sfn "$HOME/Leibaoxin/code/skills-hub/<skill-name>" "$HOME/.claude/skills/<skill-name>"
```

验证:

```bash
readlink "$HOME/.claude/skills/<skill-name>"
ls "$HOME/.claude/skills/<skill-name>/SKILL.md"
```

## License

[Apache-2.0](./LICENSE)
