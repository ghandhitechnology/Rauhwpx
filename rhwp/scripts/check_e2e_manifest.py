#!/usr/bin/env python3
"""Discover E2E tests and check that package/workflow commands reference real files."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUDIO = ROOT / "rhwp" / "rhwp-studio"
E2E = STUDIO / "e2e"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="print runnable regression files")
    args = parser.parse_args()
    if args.list:
        for path in sorted(E2E.glob("*.test.mjs")):
            print(path.relative_to(STUDIO))
        return 0

    package = json.loads((STUDIO / "package.json").read_text())
    commands = [(f"npm {name}", command) for name, command in package["scripts"].items()]
    commands.extend((str(path.relative_to(ROOT)), path.read_text())
                    for path in sorted((ROOT / ".github" / "workflows").glob("*.y*ml")))
    missing = []
    for source, command in commands:
        for name in re.findall(r"e2e/([\w.-]+\.mjs)\b", command):
            if not (E2E / name).is_file():
                missing.append(f"{source}: e2e/{name} does not exist")
    for message in missing:
        print(message)
    if not missing:
        print("E2E package and workflow references resolve.")
    return int(bool(missing))


if __name__ == "__main__":
    raise SystemExit(main())
