"""HWPX 자동 검증 도구 — 한컴 오피스를 띄워 오픈 가능 여부와 내용을 검사.

사용:
    python tools/verify_hwpx.py <파일경로> [--expect-text "..."] [--expect-paragraphs N]

예:
    python tools/verify_hwpx.py output/stage2_mixed.hwpx \
        --expect-text "첫째 줄" --expect-text "줄바꿈A" --expect-paragraphs 4

요구사항:
    - Windows + 한컴오피스 2010+
    - pip install pyhwpx
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def verify(
    path: Path,
    expect_texts: list[str],
    expect_paragraphs: int | None,
    visible: bool,
) -> int:
    try:
        from pyhwpx import Hwp
    except ImportError:
        print("ERROR: pyhwpx 미설치. `pip install pyhwpx` 실행하세요.", file=sys.stderr)
        return 2

    if not path.exists():
        print(f"ERROR: 파일 없음: {path}", file=sys.stderr)
        return 2

    hwp = Hwp(visible=visible, new=False)
    errors: list[str] = []

    try:
        abs_path = str(path.resolve())
        print(f"[1/4] 오픈 시도: {abs_path}")
        ok = hwp.open(abs_path)
        if not ok:
            print("  [FAIL] 오픈 실패 (문서 손상 또는 포맷 오류)")
            return 1
        print("  [OK] 오픈 성공")

        print("[2/4] 페이지 수 조회")
        pages = hwp.PageCount
        print(f"  페이지 수: {pages}")

        print("[3/4] 전체 텍스트 추출")
        full_text = hwp.get_text_file("TEXT", "") or ""
        # TEXT 포맷에서 \n은 하드 문단 경계 (소프트 라인브레이크는 합쳐짐)
        para_count = len([ln for ln in full_text.split("\n") if ln != ""])
        snippet = full_text.strip().replace("\r\n", "\\n").replace("\n", "\\n")[:120]
        print(f"  텍스트: {snippet!r}")
        print(f"  하드 문단 수: {para_count}")

        print("[4/4] 검증")
        if expect_paragraphs is not None and para_count != expect_paragraphs:
            errors.append(f"문단 수 불일치: 기대 {expect_paragraphs}, 실제 {para_count}")
        for needle in expect_texts:
            if needle not in full_text:
                errors.append(f"텍스트 누락: {needle!r}")
            else:
                print(f"  [OK] 텍스트 포함: {needle!r}")
    finally:
        try:
            hwp.quit()
        except Exception:
            pass

    if errors:
        print("\n검증 실패:")
        for e in errors:
            print(f"  [FAIL] {e}")
        return 1
    print("\n[OK] 모든 검증 통과")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("path", type=Path)
    p.add_argument("--expect-text", action="append", default=[])
    p.add_argument("--expect-paragraphs", type=int, default=None)
    p.add_argument("--visible", action="store_true", help="한글 창을 화면에 표시")
    args = p.parse_args()
    return verify(args.path, args.expect_text, args.expect_paragraphs, args.visible)


if __name__ == "__main__":
    sys.exit(main())
