#!/usr/bin/env python3
"""Commit working-tree product files via GitHub Git Data API (no git push)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
BRANCH = os.environ.get("TARGET_BRANCH", "chore/editing-experience-2026-09-24")
API = f"https://api.github.com/repos/{REPO}"
MESSAGE = "fix: 셀 문단 줄 간격 변경 후 후속 문단 vpos를 재계산한다"
DELETE_GLOBS = (
    ".github/patches/0*.patch",
    ".github/patches/issue-6639-vpos.patch.gz.b64",
    ".github/patches/commit_via_api.py",
    ".github/workflows/apply-issue-6639-patch.yml",
)


def api(method: str, path: str, data: dict | None = None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        API + path,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "issue-6639-applicator",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise SystemExit(f"{method} {path} -> {err.code}: {detail}") from err


def git_lines(*args: str) -> list[str]:
    out = subprocess.check_output(["git", *args], text=True)
    return [line for line in out.splitlines() if line]


def delete_paths() -> list[str]:
    from glob import glob

    paths: list[str] = []
    for pattern in DELETE_GLOBS:
        if any(ch in pattern for ch in "*?["):
            paths.extend(glob(pattern))
        elif Path(pattern).exists():
            paths.append(pattern)
    return sorted(set(paths))


def main() -> None:
    changed = set(git_lines("diff", "--name-only"))
    changed.update(git_lines("ls-files", "--others", "--exclude-standard"))
    to_delete = delete_paths()
    uploads = sorted(p for p in changed if p not in set(to_delete))
    if not uploads and not to_delete:
        print("no working-tree changes; skip commit")
        return

    ref = api("GET", f"/git/ref/heads/{BRANCH}")
    base_sha = ref["object"]["sha"]
    base_commit = api("GET", f"/git/commits/{base_sha}")
    base_tree = base_commit["tree"]["sha"]
    print(f"base {base_sha[:12]} tree {base_tree[:12]}")

    tree_items: list[dict] = []
    for path in uploads:
        content = Path(path).read_text(encoding="utf-8")
        blob = api("POST", "/git/blobs", {"content": content, "encoding": "utf-8"})
        tree_items.append(
            {"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}
        )
        print(f"blob {path} {blob['sha'][:12]} {len(content.encode())} bytes")
    for path in to_delete:
        tree_items.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
        print(f"delete {path}")

    tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_items})
    commit = api(
        "POST",
        "/git/commits",
        {
            "message": MESSAGE,
            "tree": tree["sha"],
            "parents": [base_sha],
            "author": {"name": "Andy", "email": "heemang12bo@gmail.com"},
            "committer": {"name": "Andy", "email": "heemang12bo@gmail.com"},
        },
    )
    api("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": commit["sha"]})
    print(f"committed {commit['sha']} on {BRANCH}")


if __name__ == "__main__":
    sys.exit(main())
