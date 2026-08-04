"""모든 Stage 산출물을 한 번에 검증.

사용:
    PYTHONIOENCODING=utf-8 python tools/verify_all.py

선행 조건:
    cargo run --example hwpx_dump_empty --release
    cargo run --example hwpx_dump_text  --release
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / "tools" / "verify_hwpx.py"

# (파일 경로, --expect-text 인자 목록, --expect-paragraphs)
CASES: list[tuple[str, list[str], int | None]] = [
    ("output/stage1_empty.hwpx", [], None),
    ("output/stage2_text.hwpx", ["안녕 Hello 123"], 1),
    (
        "output/stage2_mixed.hwpx",
        ["첫째 줄", "줄바꿈A", "줄바꿈B", "탭", "끝"],
        4,
    ),
    # 라운드트립 검증
    (
        "output/rt_ref_mixed.hwpx",
        ["첫째 줄", "줄바꿈A", "줄바꿈B", "탭", "끝"],
        4,
    ),
]


def main() -> int:
    failed: list[str] = []
    for rel_path, expects, paras in CASES:
        path = ROOT / rel_path
        print(f"\n{'=' * 60}\n>>> {rel_path}\n{'=' * 60}")
        if not path.exists():
            print(f"  SKIP (파일 없음 — examples 먼저 빌드 필요)")
            failed.append(rel_path)
            continue
        cmd = [sys.executable, str(VERIFY), str(path)]
        for t in expects:
            cmd.extend(["--expect-text", t])
        if paras is not None:
            cmd.extend(["--expect-paragraphs", str(paras)])
        result = subprocess.run(cmd, env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"})
        if result.returncode != 0:
            failed.append(rel_path)

    print(f"\n{'=' * 60}")
    if failed:
        print(f"FAILED ({len(failed)}/{len(CASES)}):")
        for f in failed:
            print(f"  - {f}")
        return 1
    print(f"ALL PASSED ({len(CASES)}/{len(CASES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
