#!/usr/bin/env python3
"""Verify that file references in a generated learning plan actually exist.

Usage:
    python3 check_refs.py <plan.md> [--root <repo>] [--json] [--allow-missing]

Extracts path-looking references from inline code spans and markdown links,
then checks existence (and line numbers) relative to --root. Exits non-zero
when a reference is missing, so it can gate plan delivery.

References it understands:
    `src/lib/client.ts:120`
    `src/lib/client.ts:120-160`
    [client.ts](src/lib/client.ts)
    `docs/design.md`

It intentionally ignores URLs, CLI commands, globs, placeholders, and type names.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SOURCE_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
    ".java", ".kt", ".scala", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
    ".rb", ".php", ".swift", ".sh", ".bash", ".zsh", ".sql", ".vue",
    ".svelte", ".md", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg",
    ".xml", ".gradle", ".proto", ".graphql", ".css", ".scss", ".html",
    ".ipynb", ".dockerfile", ".conf", ".properties",
}

LINE_SUFFIX = re.compile(r"^(.*?):(\d+)(?:-(\d+))?$")
INLINE_CODE = re.compile(r"`([^`\n]+)`")
MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
BARE_REF = re.compile(
    r"(?<![\w./-])((?:[\w.-]+/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|c|h|cc|cpp|hpp|cs|rb|php|swift|sh|bash|sql|vue|svelte|md|ya?ml|json|toml|ini|cfg|xml|gradle|proto|graphql|css|scss|html))"
    r"(?::(\d+)(?:-(\d+))?)?"
)

SKIP_PREFIXES = (
    "http://", "https://", "ftp://", "ssh://", "git@", "npm:", "pip:",
    "bdinfra ", "npm ", "npx ", "yarn ", "pnpm ", "python ", "python3 ",
    "node ", "go ", "cargo ", "mvn ", "gradle ", "docker ", "kubectl ",
    "git ", "make ", "pytest ", "uvicorn ", "curl ", "bash ", "sh ",
)


def is_candidate(text: str) -> bool:
    t = text.strip()
    if not t or any(ch in t for ch in "<>*?[]{}|"):
        return False
    if any(t.startswith(p) for p in SKIP_PREFIXES):
        return False
    if "://" in t or t.startswith("@"):
        return False
    if re.search(r"\s", t):
        return False
    return True


def extract_refs(markdown: str) -> list[tuple[str, int | None, int | None]]:
    refs: list[tuple[str, int | None, int | None]] = []
    seen: set[tuple[str, int | None, int | None]] = set()

    def add(raw: str) -> None:
        if not is_candidate(raw):
            return
        path = raw
        start = end = None
        m = LINE_SUFFIX.match(raw)
        if m:
            path = m.group(1)
            start = int(m.group(2))
            end = int(m.group(3)) if m.group(3) else start
        suffix = Path(path).suffix.lower()
        has_dir = "/" in path
        if suffix not in SOURCE_EXTS and not has_dir:
            return
        item = (path, start, end)
        if item not in seen:
            seen.add(item)
            refs.append(item)

    for span in INLINE_CODE.findall(markdown):
        add(span)
    for target in MD_LINK.findall(markdown):
        add(target)
    for m in BARE_REF.finditer(markdown):
        add(m.group(1))
    return refs


def check(plan: Path, root: Path) -> dict:
    text = plan.read_text(encoding="utf-8", errors="ignore")
    refs = extract_refs(text)
    missing: list[dict] = []
    bad_lines: list[dict] = []
    ok = 0

    for path, start, end in refs:
        target = (root / path).resolve()
        if not target.exists():
            missing.append({"ref": path, "line": start})
            continue
        if start is not None and target.is_file():
            try:
                total = len(target.read_text(encoding="utf-8", errors="ignore").splitlines())
            except OSError:
                total = 0
            if end is not None and (start < 1 or end > total):
                bad_lines.append({"ref": path, "line": f"{start}-{end}", "file_lines": total})
                continue
        ok += 1

    return {
        "plan": str(plan),
        "root": str(root),
        "checked": len(refs),
        "ok": ok,
        "missing": missing,
        "bad_lines": bad_lines,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", help="Markdown learning plan to check")
    parser.add_argument("--root", default=".", help="Repository root that references are relative to")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    parser.add_argument("--allow-missing", action="store_true", help="Exit 0 even when references are missing")
    args = parser.parse_args()

    plan = Path(args.plan).expanduser().resolve()
    root = Path(args.root).expanduser().resolve()
    if not plan.is_file():
        print(f"error: not a file: {plan}", file=sys.stderr)
        return 2
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2

    result = check(plan, root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Checked {result['checked']} references against {root}")
        print(f"  ok: {result['ok']}")
        if result["missing"]:
            print(f"  missing: {len(result['missing'])}")
            for item in result["missing"]:
                line = f":{item['line']}" if item.get("line") else ""
                print(f"    ✗ {item['ref']}{line}")
        if result["bad_lines"]:
            print(f"  line out of range: {len(result['bad_lines'])}")
            for item in result["bad_lines"]:
                print(f"    ✗ {item['ref']}:{item['line']} (file has {item['file_lines']} lines)")

    failed = bool(result["missing"] or result["bad_lines"])
    if failed and not args.allow_missing:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
