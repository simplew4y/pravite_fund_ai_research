#!/usr/bin/env python3
"""Bounded end-to-end concurrency benchmark for the FinSagent HTTP API."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp


QUESTIONS = [
    "NVIDIA模型（NVDA.OQ 2025年7月15日版本）封面页上列出的覆盖分析师是谁？",
    "仅根据当前保时捷模型，2035E归母净利润是多少？如果模型没有该预测期，请明确说明资料未披露，不要外推。",
]


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


async def one(session: aiohttp.ClientSession, url: str, run_id: str, concurrency: int, index: int) -> dict[str, Any]:
    payload = {"question": QUESTIONS[index % len(QUESTIONS)], "session_id": f"{run_id}_c{concurrency}_{index}_{time.time_ns()}"}
    started = time.perf_counter()
    try:
        async with session.post(url, json=payload) as response:
            body = await response.text()
            elapsed = time.perf_counter() - started
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = {"raw_text": body}
            return {"index": index, "status_code": response.status, "ok": response.status == 200,
                    "elapsed_seconds": round(elapsed, 3), "request": payload, "response": parsed, "error": None}
    except Exception as exc:
        elapsed = time.perf_counter() - started
        return {"index": index, "status_code": None, "ok": False, "elapsed_seconds": round(elapsed, 3),
                "request": payload, "response": None, "error": f"{type(exc).__name__}: {exc}"}


async def arm(session: aiohttp.ClientSession, url: str, run_id: str, concurrency: int, requests: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    semaphore = asyncio.Semaphore(concurrency)

    async def bounded(index: int) -> dict[str, Any]:
        async with semaphore:
            return await one(session, url, run_id, concurrency, index)

    wall_started = time.perf_counter()
    results = await asyncio.gather(*(bounded(index) for index in range(requests)))
    wall = time.perf_counter() - wall_started
    successes = [row for row in results if row["ok"]]
    latencies = [float(row["elapsed_seconds"]) for row in successes]
    summary = {
        "concurrency": concurrency, "requests": requests, "successes": len(successes),
        "errors": requests - len(successes), "timeout_rate": round(sum("Timeout" in str(r.get("error")) for r in results) / requests, 4),
        "error_rate": round((requests - len(successes)) / requests, 4), "wall_seconds": round(wall, 3),
        "throughput_requests_per_second": round(len(successes) / wall, 4) if wall else None,
        "latency_p50_seconds": round(statistics.median(latencies), 3) if latencies else None,
        "latency_p95_seconds": round(percentile(latencies, 0.95), 3) if latencies else None,
        "latency_max_seconds": round(max(latencies), 3) if latencies else None,
    }
    return results, summary


async def run(args: argparse.Namespace) -> None:
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    timeout = aiohttp.ClientTimeout(total=args.timeout)
    connector = aiohttp.TCPConnector(limit=max(args.concurrency))
    summaries: list[dict[str, Any]] = []
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        for concurrency in args.concurrency:
            print(f"START concurrency={concurrency} requests={args.requests}", flush=True)
            results, summary = await arm(session, args.url, args.run_id, concurrency, args.requests)
            (output / f"concurrency_{concurrency}_raw.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            summaries.append(summary)
            print(json.dumps(summary, ensure_ascii=False), flush=True)
    payload = {"run_id": args.run_id, "url": args.url, "completed_at_utc": datetime.now(timezone.utc).isoformat(), "arms": summaries}
    (output / "concurrency_summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5012/chat")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4, 8])
    parser.add_argument("--requests", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
