#!/usr/bin/env python3
"""Read-only repository inventory for building a source-learning plan.

Usage:
    python3 repo_inventory.py <repo> [--json] [--top 30] [--max-file-bytes 2000000]

Outputs language mix, manifests, entry-point candidates, top files by LOC,
test locations, and top-level directories. Deterministic and offline.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env",
    "dist", "build", "target", "out", "coverage", ".next", ".nuxt",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".idea", ".vscode", ".omc", ".archify", ".zcode", ".superpowers",
    "vendor", "third_party", "site-packages",
}

LANG_BY_EXT = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".scala": "Scala",
    ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
    ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
    ".sql": "SQL", ".vue": "Vue", ".svelte": "Svelte",
}

MANIFEST_NAMES = {
    "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
    "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
    "Gemfile", "composer.json", "Dockerfile", "docker-compose.yml",
    "docker-compose.yaml", "Makefile", "justfile", "Procfile",
    "tsconfig.json", "vite.config.ts", "webpack.config.js", "rollup.config.js",
    "pyproject.toml", "tox.ini", "noxfile.py", ".python-version", ".nvmrc",
}

ENTRY_BASENAMES = {
    "main.py", "app.py", "asgi.py", "wsgi.py", "manage.py", "cli.py",
    "__main__.py", "index.ts", "index.js", "main.ts", "main.js",
    "main.go", "main.rs", "cmd.rs", "program.cs", "Program.cs",
}
ENTRY_DIR_NAMES = {"cmd", "bin", "entries", "entrypoints"}

TEST_DIR_NAMES = {"tests", "test", "spec", "__tests__", "e2e", "integration"}
TEST_FILE_RE = re.compile(
    r"(^test_.*\.py$|.*_test\.py$|.*\.test\.(js|ts|jsx|tsx|mjs|cjs)$|"
    r".*\.spec\.(js|ts|jsx|tsx)$|.*_test\.go$|.*Test\.(java|kt|scala)$)"
)

SOURCE_EXTS = set(LANG_BY_EXT)


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(filenames):
            yield Path(dirpath) / name


def count_loc(path: Path, max_bytes: int) -> int | None:
    try:
        if path.stat().st_size > max_bytes:
            return None
        data = path.read_bytes()
        if b"\x00" in data[:4096]:
            return None
        text = data.decode("utf-8", errors="ignore")
        return sum(1 for line in text.splitlines() if line.strip())
    except (OSError, ValueError):
        return None


def summarize_manifest(path: Path, root: Path) -> dict[str, Any]:
    rel = str(path.relative_to(root))
    out: dict[str, Any] = {"path": rel, "kind": path.name}
    name = path.name
    try:
        if name == "package.json":
            data = json.loads(path.read_text(encoding="utf-8"))
            out.update({
                "name": data.get("name"),
                "version": data.get("version"),
                "bin": data.get("bin"),
                "main": data.get("main") or data.get("module") or data.get("types"),
                "scripts": data.get("scripts", {}),
                "dependencies": sorted((data.get("dependencies") or {}).keys()),
                "devDependencies": sorted((data.get("devDependencies") or {}).keys()),
            })
        elif name == "pyproject.toml":
            try:
                import tomllib  # Python 3.11+
                data = tomllib.loads(path.read_text(encoding="utf-8"))
                project = data.get("project", {})
                out.update({
                    "name": project.get("name"),
                    "version": project.get("version"),
                    "requires-python": project.get("requires-python"),
                    "scripts": project.get("scripts", {}),
                    "dependencies": project.get("dependencies", []),
                    "optional-dependencies": sorted((project.get("optional-dependencies") or {}).keys()),
                    "build-backend": (data.get("build-system") or {}).get("build-backend"),
                })
            except Exception as exc:  # noqa: BLE001
                out["note"] = f"toml parse failed: {type(exc).__name__}"
        elif name == "go.mod":
            text = path.read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"^module\s+(\S+)", text, re.MULTILINE)
            out["name"] = m.group(1) if m else None
            out["go"] = (re.search(r"^go\s+(\S+)", text, re.MULTILINE) or [None, None])[1]
        elif name == "Cargo.toml":
            text = path.read_text(encoding="utf-8", errors="ignore")
            m = re.search(r'^name\s*=\s*"([^"]+)"', text, re.MULTILINE)
            out["name"] = m.group(1) if m else None
        elif name == "Dockerfile":
            text = path.read_text(encoding="utf-8", errors="ignore")
            out["expose"] = re.findall(r"^EXPOSE\s+(.+)$", text, re.MULTILINE)
            out["cmd"] = re.findall(r"^(?:CMD|ENTRYPOINT)\s+(.+)$", text, re.MULTILINE)
            out["env"] = re.findall(r"^ENV\s+([A-Za-z_][A-Za-z0-9_]*)", text, re.MULTILINE)
        elif name == "Makefile":
            text = path.read_text(encoding="utf-8", errors="ignore")
            out["targets"] = re.findall(r"^([A-Za-z0-9_.-]+):(?!=)", text, re.MULTILINE)[:30]
        elif name in {"docker-compose.yml", "docker-compose.yaml"}:
            text = path.read_text(encoding="utf-8", errors="ignore")
            out["services"] = re.findall(r"^  ([A-Za-z0-9_-]+):\s*$", text, re.MULTILINE)
    except (OSError, ValueError, json.JSONDecodeError) as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def detect_entries(root: Path, files: list[Path], manifests: list[dict[str, Any]]) -> list[str]:
    entries: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        if value and value not in seen:
            seen.add(value)
            entries.append(value)

    for m in manifests:
        if m.get("kind") == "package.json":
            bin_value = m.get("bin")
            if isinstance(bin_value, str):
                add(bin_value)
            elif isinstance(bin_value, dict):
                for v in bin_value.values():
                    add(str(v))
            add(str(m.get("main")) if m.get("main") else None)
        if m.get("kind") == "pyproject.toml":
            for v in (m.get("scripts") or {}).values():
                add(str(v).split()[0] if str(v).strip() else None)
        if m.get("kind") == "Dockerfile":
            for cmd in m.get("cmd") or []:
                if "-m" in cmd:
                    parts = cmd.split()
                    idx = parts.index("-m")
                    if idx + 1 < len(parts):
                        add(parts[idx + 1].replace(".", "/") + ".py")
                m2 = re.search(r"([\w./-]+\.(?:js|py))", cmd)
                if m2:
                    add(m2.group(1))

    for p in files:
        rel = str(p.relative_to(root))
        if p.name in ENTRY_BASENAMES or p.stem in {"main", "__main__"}:
            add(rel)
        if p.suffix in SOURCE_EXTS and any(part in ENTRY_DIR_NAMES for part in p.parts[:-1]):
            add(rel)

    return entries[:40]


def summarize(root: Path, top: int, max_bytes: int) -> dict[str, Any]:
    files = list(iter_files(root))
    lang_files: Counter[str] = Counter()
    lang_loc: Counter[str] = Counter()
    loc_rows: list[tuple[int, str]] = []
    manifests: list[dict[str, Any]] = []
    test_files: list[str] = []
    top_dirs: Counter[str] = Counter()

    for p in files:
        rel = str(p.relative_to(root))
        parts = Path(rel).parts
        if len(parts) > 1:
            top_dirs[parts[0]] += 1
        if p.name in MANIFEST_NAMES:
            manifests.append(summarize_manifest(p, root))
        loc = count_loc(p, max_bytes)
        if loc is not None and p.suffix in LANG_BY_EXT:
            lang = LANG_BY_EXT[p.suffix]
            lang_files[lang] += 1
            lang_loc[lang] += loc
            loc_rows.append((loc, rel))
        if TEST_FILE_RE.match(p.name) or any(d in TEST_DIR_NAMES for d in parts[:-1]):
            if "docs" in parts[:-1]:
                continue
            if p.suffix in SOURCE_EXTS or p.name.endswith((".md", ".sh")):
                test_files.append(rel)

    loc_rows.sort(reverse=True)

    return {
        "root": str(root),
        "file_count": len(files),
        "text_file_count": sum(1 for _, _ in loc_rows),
        "total_loc": sum(loc for loc, _ in loc_rows),
        "languages": [
            {"language": lang, "files": lang_files[lang], "loc": lang_loc[lang]}
            for lang in sorted(lang_loc, key=lambda x: lang_loc[x], reverse=True)
        ],
        "manifests": manifests,
        "entry_candidates": detect_entries(root, files, manifests),
        "top_files": [{"loc": loc, "path": rel} for loc, rel in loc_rows[:top]],
        "test_files": sorted(test_files)[:60],
        "test_file_count": len(test_files),
        "top_dirs": [{"dir": d, "files": c} for d, c in top_dirs.most_common(20)],
    }


def render_markdown(data: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# Repo inventory: `{data['root']}`")
    lines.append("")
    lines.append(
        f"- Files scanned: **{data['file_count']}** "
        f"(text files counted: {data['text_file_count']})"
    )
    lines.append(f"- Approximate LOC: **{data['total_loc']}**")
    lines.append(f"- Test files: **{data['test_file_count']}**")
    lines.append("")
    lines.append("## Languages")
    lines.append("")
    lines.append("| Language | Files | LOC |")
    lines.append("|---|---:|---:|")
    for row in data["languages"]:
        lines.append(f"| {row['language']} | {row['files']} | {row['loc']} |")
    lines.append("")
    lines.append("## Manifests")
    lines.append("")
    for m in data["manifests"]:
        detail = {k: v for k, v in m.items() if k not in {"path", "kind"} and v not in (None, [], {}, "")}
        lines.append(f"- `{m['path']}` — {json.dumps(detail, ensure_ascii=False)}")
    if not data["manifests"]:
        lines.append("- (none detected)")
    lines.append("")
    lines.append("## Entry-point candidates")
    lines.append("")
    for e in data["entry_candidates"]:
        lines.append(f"- `{e}`")
    if not data["entry_candidates"]:
        lines.append("- (none detected — inspect package scripts / Dockerfile CMD manually)")
    lines.append("")
    lines.append(f"## Top {len(data['top_files'])} files by LOC")
    lines.append("")
    lines.append("| LOC | File |")
    lines.append("|---:|---|")
    for row in data["top_files"]:
        lines.append(f"| {row['loc']} | `{row['path']}` |")
    lines.append("")
    lines.append("## Tests")
    lines.append("")
    for t in data["test_files"][:40]:
        lines.append(f"- `{t}`")
    if not data["test_files"]:
        lines.append("- (none detected)")
    lines.append("")
    lines.append("## Top-level directories")
    lines.append("")
    lines.append("| Directory | Files |")
    lines.append("|---|---:|")
    for row in data["top_dirs"]:
        lines.append(f"| `{row['dir']}/` | {row['files']} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", help="Repository root")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of Markdown")
    parser.add_argument("--top", type=int, default=30, help="Number of largest files to list")
    parser.add_argument("--max-file-bytes", type=int, default=2_000_000, help="Skip files larger than this when counting LOC")
    args = parser.parse_args()

    root = Path(args.repo).expanduser().resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2

    data = summarize(root, args.top, args.max_file_bytes)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
