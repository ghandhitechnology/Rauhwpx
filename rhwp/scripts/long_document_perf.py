#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import multiprocessing
import os
import resource
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BINARY = ROOT / "target" / "release" / "rhwp"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure repeatable long-document bench time, RSS, and render-cache occupancy."
    )
    parser.add_argument("sample", help="HWP/HWPX sample path")
    parser.add_argument("--binary", default=str(DEFAULT_BINARY), help="release rhwp binary")
    parser.add_argument("--runs", type=int, default=3, help="isolated process runs")
    parser.add_argument("--bench-iters", type=int, default=1, help="rhwp bench iterations per run")
    parser.add_argument(
        "--render-path",
        choices=("legacy", "layer-svg"),
        default="layer-svg",
        help="renderer path measured by rhwp bench",
    )
    parser.add_argument("--output", help="optional JSON result path")
    return parser.parse_args()


def measure_once(
    command: list[str],
    env: dict[str, str],
    tsv_path: str,
    queue: multiprocessing.Queue,
) -> None:
    started = time.perf_counter()
    completed = subprocess.run(command, env=env, text=True, capture_output=True)
    wall_ms = (time.perf_counter() - started) * 1000
    max_rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    peak_rss_bytes = max_rss if sys.platform == "darwin" else max_rss * 1024
    row: dict[str, str] = {}
    if completed.returncode == 0:
        with Path(tsv_path).open(encoding="utf-8", newline="") as handle:
            row = next(csv.DictReader(handle, delimiter="\t"))
    queue.put(
        {
            "returnCode": completed.returncode,
            "wallMs": round(wall_ms, 3),
            "peakRssBytes": peak_rss_bytes,
            "metrics": row,
            "stderrTail": completed.stderr[-2000:],
        }
    )


def numeric_metrics(row: dict[str, str]) -> dict[str, Any]:
    integer_fields = {"pages", "cached_page_trees", "cached_layer_json_variants"}
    result: dict[str, Any] = {}
    for key, value in row.items():
        if key == "file":
            result[key] = value
        elif key in integer_fields:
            result[key] = int(value)
        else:
            result[key] = float(value)
    return result


def median_field(runs: list[dict[str, Any]], key: str) -> float:
    return round(statistics.median(float(run[key]) for run in runs), 3)


def main() -> None:
    args = parse_args()
    if args.runs < 1 or args.bench_iters < 1:
        raise SystemExit("--runs and --bench-iters must be positive")

    sample = Path(args.sample).resolve()
    binary = Path(args.binary).resolve()
    if not sample.is_file():
        raise SystemExit(f"sample not found: {sample}")
    if not binary.is_file():
        raise SystemExit(f"binary not found: {binary}; run cargo build --release")

    env = dict(os.environ)
    if args.render_path == "layer-svg":
        env["RHWP_RENDER_PATH"] = "layer-svg"
    else:
        env.pop("RHWP_RENDER_PATH", None)

    context = multiprocessing.get_context("spawn")
    measured: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="rhwp-long-doc-perf-") as temp_dir:
        for run_index in range(args.runs):
            tsv_path = str(Path(temp_dir) / f"run-{run_index + 1}.tsv")
            command = [
                str(binary),
                "bench",
                str(sample),
                "-n",
                str(args.bench_iters),
                "--tsv",
                tsv_path,
            ]
            queue = context.Queue()
            process = context.Process(target=measure_once, args=(command, env, tsv_path, queue))
            process.start()
            process.join()
            if process.exitcode != 0:
                raise SystemExit(f"measurement worker exited with {process.exitcode}")
            run = queue.get()
            if run["returnCode"] != 0:
                raise SystemExit(run["stderrTail"] or f"rhwp bench exited with {run['returnCode']}")
            run["metrics"] = numeric_metrics(run["metrics"])
            run.pop("stderrTail")
            measured.append(run)

    metric_keys = [
        key
        for key, value in measured[0]["metrics"].items()
        if key != "file" and isinstance(value, (int, float))
    ]
    result = {
        "sample": str(sample),
        "renderPath": args.render_path,
        "runs": measured,
        "median": {
            "wallMs": median_field(measured, "wallMs"),
            "peakRssBytes": int(statistics.median(run["peakRssBytes"] for run in measured)),
            "metrics": {
                key: median_field([run["metrics"] for run in measured], key)
                for key in metric_keys
            },
        },
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    print(serialized)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
