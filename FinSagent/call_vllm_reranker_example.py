#!/usr/bin/env python3
import json
import sys

import requests


def main() -> int:
    url = "http://127.0.0.1:5432/rerank"
    payload = {
        "model": "BAAI/bge-reranker-v2-gemma",
        "query": "极氪2024年销量如何？",
        "documents": [
            "极氪2024年全年交付表现强劲。",
            "苹果公司发布了新款手机。",
            "该公司在海外市场扩张。",
            "极氪在欧洲市场继续拓展。",
            "公司公布了新的车型规划。",
        ],
        "top_n": 5,
    }

    try:
        response = requests.post(url, json=payload, timeout=60)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 1

    data = response.json()
    print(json.dumps(data, ensure_ascii=False, indent=2))

    print("\nRanked results:")
    for item in data.get("results", []):
        index = item.get("index")
        score = item.get("relevance_score")
        document = item.get("document", {}).get("text", "")
        print(f"- index={index} score={score:.6f} text={document}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
