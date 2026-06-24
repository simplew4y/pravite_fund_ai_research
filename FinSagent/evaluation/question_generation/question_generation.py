#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Generate evaluation questions and grounded answers from images.

What it does:
1. Read all images from a directory.
2. For each image, send exactly one image + prompt to a multimodal model.
3. Ask the model to:
   - summarize the main content briefly
   - generate N complex-but-one-sentence questions
   - provide grounded answers
4. Save one JSON file containing one object per image:
   - index
   - image_name
   - summary
   - qa_pairs

Example:
    export OPENAI_API_KEY="..."
    python generate_rag_qa_from_images.py \
        --image_dir ./screenshots \
        --output_json ./zeekr_eval.json \
        --questions_per_image 5 \
        --model gpt-5

Output JSON schema:
[
  {
    "index": 0,
    "image_name": "file_name.png",
    "summary": "short summary",
    "qa_pairs": [
      {
        "query": "one-sentence question",
        "ground_truth_answer": "grounded answer"
      }
    ]
  }
]
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from openai import OpenAI


SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


SYSTEM_PROMPT = """You are generating evaluation data for an agentic RAG benchmark.

## Task
Given one document screenshot, produce grounded QA pairs for that image.

## Important constraints
1. Questions must sound like natural user questions, NOT like "based on this page/file/image".
2. Each question should be roughly one sentence.
3. Questions should be answerable from the image alone, and should not be overly broad or vague.
4. Questions should not be redundant with each other; they should test different aspects of the image content.
5. Answers must be complete, and must stay grounded in what is visible in the image. Do NOT invent facts that are not supported by the image.
6. Your answer should include specific evidence details, such as numbers, entities, operations to be supported.
7. Questions must be self-contained for a retrieval system that cannot see the image.
8. The company being referred to is Zeekr, and the question should explicitly say "Zeekr" whenever needed for clarity.
9. Questions must NOT refer to the source text/passage/document or use phrases like "the passage", "the text", "the document", "the section", "the excerpt", "described", or "according to".
10. Questions should be phrased as natural business, finance, or research questions, not about how information is displayed.
11. Questions must NOT be simple lookup questions.

Avoid asking for:
- a single directly visible number
- the largest category by inspection
- a direct value in another currency column
- a label or title copied from the image

Prefer questions that require:
- identifying the core driver of a financial outcome
- evaluating whether a claim is supported
- explaining why one positive trend did not lead to profitability
- distinguishing between two plausible interpretations

---
## Style reference (few-shot guidance only):
**Reference image content:**
A financial summary table for Zeekr covering 2021 to 2023, including revenue, gross profit, operating expenses, operating loss, and net loss.

**Several reference question examples:**
1. What was the core driver behind Zeekr’s continuously expanding net loss from 2021 to 2023?
2. Is the claim that Zeekr was already close to breakeven in 2023 supported?
3. Do Zeekr’s losses look more like a business model problem or the result of heavy expansion-stage investment?

**Bad example questions (to avoid):**
- What was the company’s net loss in 2023?
- Which operating expense category was the largest in 2023?
- Did revenue increase from 2022 to 2023?
---

## Output JSON schema
{
  "summary": "short summary of the image content",
  "qa_pairs": [
    {
      "query": "one-sentence question",
      "ground_truth_answer": "grounded answer"
    }
  ]
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image_dir", type=str, required=True, help="Directory containing images.")
    parser.add_argument("--output_json", type=str, required=True, help="Path to output JSON.")
    parser.add_argument("--model", type=str, default="gpt-5.2-2025-12-11", help="Model name.")
    parser.add_argument("--questions_per_image", type=int, default=3, help="Number of QA pairs per image.")
    parser.add_argument("--max_retries", type=int, default=3, help="Retries for malformed JSON.")
    parser.add_argument("--temperature", type=float, default=0.2, help="Optional sampling param if model supports it.")
    return parser.parse_args()


def list_images(image_dir: Path) -> List[Path]:
    images = []
    for p in sorted(image_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            images.append(p)
    return images


def encode_image_to_data_url(image_path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(str(image_path))
    if not mime_type:
        mime_type = "image/png"

    with image_path.open("rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime_type};base64,{b64}"


def build_user_input(image_path: Path, questions_per_image: int) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = [
        {
            "type": "input_text",
            "text": (
                f"Generate exactly {questions_per_image} QA pairs for this image.\n"
                "Return strict JSON only."
            ),
        },
        {
            "type": "input_image",
            "image_url": encode_image_to_data_url(image_path),
        },
    ]
    return [{"role": "user", "content": content}]


def call_model(
    client: OpenAI,
    model: str,
    image_path: Path,
    questions_per_image: int,
    max_retries: int = 3,
    temperature: float = 0.2,
) -> Dict[str, Any]:
    last_err = None

    for attempt in range(1, max_retries + 1):
        try:
            response = client.responses.create(
                model=model,
                input=build_user_input(image_path, questions_per_image),
                instructions=SYSTEM_PROMPT,
                text={"format": {"type": "json_object"}},
                temperature=temperature,
            )

            raw_text = response.output_text
            data = json.loads(raw_text)
            validate_single_output(data, questions_per_image)
            return data

        except Exception as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(1.5 * attempt)
            else:
                raise RuntimeError(
                    f"Model call failed after {max_retries} attempts for image "
                    f"{image_path.name}: {e}"
                ) from e

    raise RuntimeError(f"Unexpected failure: {last_err}")


def validate_single_output(data: Dict[str, Any], questions_per_image: int) -> None:
    if not isinstance(data, dict):
        raise ValueError("Output is not a JSON object.")

    summary = data.get("summary")
    qa_pairs = data.get("qa_pairs")

    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("Missing or invalid 'summary' field.")

    if not isinstance(qa_pairs, list) or len(qa_pairs) != questions_per_image:
        raise ValueError(f"Output must contain exactly {questions_per_image} qa_pairs.")

    for i, qa in enumerate(qa_pairs):
        if not isinstance(qa, dict):
            raise ValueError(f"qa_pairs[{i}] is not an object.")

        query = qa.get("query")
        answer = qa.get("ground_truth_answer")

        if not isinstance(query, str) or not query.strip():
            raise ValueError(f"Invalid query at qa_pairs[{i}].")

        if not isinstance(answer, str) or not answer.strip():
            raise ValueError(f"Invalid ground_truth_answer at qa_pairs[{i}].")


def build_final_results(image_outputs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    final_results: List[Dict[str, Any]] = []

    for idx, item in enumerate(image_outputs):
        final_results.append({
            "index": idx,
            "image_name": item["image_name"],
            "summary": item["summary"].strip(),
            "qa_pairs": [
                {
                    "query": qa["query"].strip(),
                    "ground_truth_answer": qa["ground_truth_answer"].strip(),
                }
                for qa in item["qa_pairs"]
            ],
        })

    return final_results


def main() -> None:
    args = parse_args()

    image_dir = Path(args.image_dir)
    output_json = Path(args.output_json)

    if not image_dir.exists() or not image_dir.is_dir():
        raise FileNotFoundError(f"Image directory not found: {image_dir}")

    images = list_images(image_dir)
    if not images:
        raise ValueError(f"No supported images found in: {image_dir}")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError("OPENAI_API_KEY is not set.")

    client = OpenAI(api_key=api_key)

    image_outputs: List[Dict[str, Any]] = []

    print(f"Found {len(images)} images. Processing one image per request...", file=sys.stderr)

    for i, image_path in enumerate(images, start=1):
        print(f"[{i}/{len(images)}] Processing {image_path.name}", file=sys.stderr)

        result = call_model(
            client=client,
            model=args.model,
            image_path=image_path,
            questions_per_image=args.questions_per_image,
            max_retries=args.max_retries,
            temperature=args.temperature,
        )

        image_outputs.append({
            "image_name": image_path.name,
            "summary": result["summary"],
            "qa_pairs": result["qa_pairs"],
        })

    final_results = build_final_results(image_outputs)

    output_json.parent.mkdir(parents=True, exist_ok=True)
    with output_json.open("w", encoding="utf-8") as f:
        json.dump(final_results, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(final_results)} image-level records to {output_json}", file=sys.stderr)


if __name__ == "__main__":
    main()