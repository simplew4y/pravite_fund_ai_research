import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from tqdm import tqdm


class Annotator:
    def __init__(
        self,
        model_name: str,
        api_key: str,
        base_url: str,
        max_retries: int = 3,
        retry_delay_sec: float = 1.0,
        max_workers: int = 8,
    ):
        self.model_name = model_name
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.retry_delay_sec = retry_delay_sec
        self.max_workers = max_workers
        self._thread_local = threading.local()

    def _get_client(self) -> Any:
        client = getattr(self._thread_local, "llm", None)
        if client is None:
            import openai

            client = openai.OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
            )
            self._thread_local.llm = client
        return client

    def _get_prompt(self, query: str, answer: str, chunk: str) -> str:
        return f"""
        # Role
        You are an expert financial document annotation specialist, specializing in providing high-quality relevance annotations for question-answering systems focused on financial regulatory filings (such as SEC filings).

        # Task
        Given a financial domain user query, the **ground-truth answer**, and a document chunk, determine the relevance of the document chunk to answering the query.
        A chunk is relevant **only if it contains information that directly contributes to producing part of the ground-truth answer**.
        Do NOT mark a chunk as relevant simply because it discusses the same company, topic, or financial metric in a general sense.

        # Ground-Truth Answer
        The ground-truth answer is provided so you can verify whether the chunk actually supplies facts, figures, or reasoning steps that appear in or are necessary for the answer. Use it as a strict reference.

        # Relevance Assessment Criteria
        **Relevant (YES) — the chunk must satisfy at least one:**
        1. **Direct Answer Evidence**: The chunk contains specific data points, figures, statements, or facts that are directly used in or verifiable against the ground-truth answer.
        2. **Necessary Calculation Basis**: The chunk provides numbers or definitions that are required intermediate steps to derive the ground-truth answer (e.g., component values needed for a computation).
        3. **Essential Contextual Premise**: The chunk supplies a critical contextual fact (e.g., an accounting policy, a disclosed event, a definitional clause) without which the ground-truth answer cannot be correctly understood or produced.

        **Irrelevant (NO) — any of the following makes a chunk irrelevant:**
        1. **Same Topic, Wrong Specifics**: The chunk discusses the same financial metric or topic but for a **different time period, entity, or segment** that is **not asked about in the query and not used in the ground-truth answer**.
        2. **Generic Background**: The chunk provides general company overview, industry context, or boilerplate language that does not materially contribute to the ground-truth answer.
        3. **Incidental Mention**: The chunk mentions query-related keywords only in passing (e.g., in footnotes, disclaimers, or unrelated paragraphs) without contributing answer-relevant content.
        4. **Tangentially Related**: The chunk is about a related but distinct topic (e.g., query asks about revenue, chunk discusses headcount) and its content does not appear in or support the ground-truth answer.
        5. **Time Period Mismatch**: The chunk covers a different time period than what the query specifically asks for, **unless** the query explicitly requests a trend, comparison, or range that would encompass that period.

        # Annotation Examples
        ---
        **Example 1: Direct Data Match**
        Query: What was Lotus Technology's Q4 2023 revenue?
        Answer: Lotus Technology reported Q4 2023 revenue of $750 million.
        Chunk: "Lotus Technology (LOT) reported Q4 2023 revenue of $750 million, representing a 45% increase year-over-year, primarily driven by strong sales of the Eletre electric vehicle model."
        Analysis: The chunk directly contains the Q4 2023 revenue figure ($750 million) that appears in the ground-truth answer.
        Relevance: YES
        ---
        **Example 2: Keywords Present but Content Mismatched**
        Query: What were the main risks disclosed in Tesla's 2023 10-K filing?
        Answer: Tesla's 2023 10-K disclosed risks including supply chain disruption, regulatory changes in key markets, and competition in the EV sector.
        Chunk: "Tesla's 2023 annual shareholder meeting highlighted the company's commitment to sustainable transportation and discussed upcoming product launches for 2024."
        Analysis: The chunk discusses shareholder meeting topics, not 10-K risk disclosures. None of its content contributes to the ground-truth answer.
        Relevance: NO
        ---
        **Example 3: Time Period Mismatch — Query asks for a specific period**
        Query: What was Apple's iPhone revenue in Q1 2024?
        Answer: Apple's iPhone segment generated $69.7 billion in Q1 2024.
        Chunk: "Apple's iPhone segment generated $65.8 billion in Q1 2023, showing resilience despite global supply chain challenges."
        Analysis: The query asks specifically for Q1 2024. The chunk provides Q1 2023 data, which is a different period and is not part of the ground-truth answer. The query does not ask for a trend or comparison.
        Relevance: NO
        ---
        **Example 4: Time Period Mismatch — Query asks for a trend (relevant)**
        Query: Analyze Apple's iPhone revenue trend from Q1 2023 to Q1 2024.
        Answer: Apple's iPhone revenue grew from $65.8 billion in Q1 2023 to $69.7 billion in Q1 2024, a 5.9% increase.
        Chunk: "Apple's iPhone segment generated $65.8 billion in Q1 2023, showing resilience despite global supply chain challenges."
        Analysis: The query explicitly asks for a trend spanning Q1 2023 to Q1 2024. The Q1 2023 figure in this chunk is part of the ground-truth answer.
        Relevance: YES
        ---
        **Example 5: Necessary Calculation Basis**
        Query: What was Company X's gross margin in FY2023?
        Answer: Company X's gross margin was 42%, calculated from $4.2B gross profit on $10B revenue.
        Chunk: "Company X reported total revenue of $10 billion for fiscal year 2023, a 12% increase from the prior year."
        Analysis: The revenue figure ($10B) is a necessary component for computing the gross margin that appears in the ground-truth answer.
        Relevance: YES
        ---
        **Example 6: Related but Not Contributing to Answer**
        Query: What was Company X's net income in 2023?
        Answer: Company X reported net income of $1.2 billion in 2023.
        Chunk: "Company X employed 45,000 people globally as of December 2023 and opened 12 new offices across Asia-Pacific."
        Analysis: The chunk is about the same company and year, but headcount and office openings do not contribute to the net income answer.
        Relevance: NO
        ---

        # Begin Annotation
        Original Query: {query}
        Ground-Truth Answer: {answer}
        Chunk: {chunk}

        Respond in the following format:
        Line 1: "YES" or "NO" — indicate whether the chunk is relevant.
        Line 2: Your analysis reasoning, briefly explaining why it is or is not relevant with specific reference to the ground-truth answer.

        Please strictly adhere to this 2-line format with no additional text, explanations, or commentary.
        """

    def _annotate(self, query: str, answer: str, chunk: str) -> Tuple[str, str]:
        prompt = self._get_prompt(query, answer, chunk)
        last_error = ""

        for attempt in range(1, self.max_retries + 1):
            try:
                response = self._get_client().chat.completions.create(
                    model=self.model_name,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0,
                )
                content = (response.choices[0].message.content or "").strip()
                answer_lines = [line.strip() for line in content.split("\n") if line.strip()]
                if not answer_lines:
                    raise ValueError("Empty response content")

                label = answer_lines[0].strip().upper()
                if label not in {"YES", "NO"}:
                    raise ValueError(f"Invalid label: {label}")

                reasoning = answer_lines[1].strip() if len(answer_lines) > 1 else ""
                return label, reasoning
            except Exception as e:
                last_error = str(e)
                if attempt == self.max_retries:
                    break
                time.sleep(self.retry_delay_sec * attempt)

        return "NO", f"annotation_failed_after_retries: {last_error}"

    def _annotate_chunk(
        self,
        question: str,
        answer: str,
        chunk_obj: Any,
        chunk_index: int,
    ) -> Optional[Tuple[int, str, Dict[str, str]]]:
        chunk_text = get_chunk_text(chunk_obj)
        if not chunk_text:
            return None

        label, reasoning = self._annotate(question, answer, chunk_text)
        annotated_chunk = {
            "chunk_id": get_chunk_id(chunk_obj),
            "chunk": chunk_text,
            "reasoning": reasoning,
        }
        return chunk_index, label, annotated_chunk

    def process_annotations(self, question: str, answer: str, retrieved_chunks: List[Any]) -> Dict[str, Any]:
        positives: List[Dict[str, str]] = []
        negatives: List[Dict[str, str]] = []
        ordered_results: List[Optional[Tuple[str, Dict[str, str]]]] = [None] * len(retrieved_chunks)

        annotatable_chunks = [
            (chunk_index, chunk_obj)
            for chunk_index, chunk_obj in enumerate(retrieved_chunks)
            if get_chunk_text(chunk_obj)
        ]

        if annotatable_chunks:
            max_workers = max(1, min(self.max_workers, len(annotatable_chunks)))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_index = {
                    executor.submit(self._annotate_chunk, question, answer, chunk_obj, chunk_index): chunk_index
                    for chunk_index, chunk_obj in annotatable_chunks
                }
                for future in tqdm(as_completed(future_to_index), total=len(future_to_index), leave=False):
                    result = future.result()
                    if result is None:
                        continue
                    chunk_index, label, annotated_chunk = result
                    ordered_results[chunk_index] = (label, annotated_chunk)

        for result in ordered_results:
            if result is None:
                continue
            label, annotated_chunk = result
            if label == "YES":
                positives.append(annotated_chunk)
            else:
                negatives.append(annotated_chunk)

        return {
            "question": question,
            "num_positives": len(positives),
            "num_negatives": len(negatives),
            "positives": positives,
            "negatives": negatives,
        }


def get_question_text(item: Dict[str, Any]) -> str:
    return item.get("original_question") or item.get("question") or item.get("query") or ""


def get_answer_text(item: Dict[str, Any]) -> str:
    return item.get("ground_truth_answer") or item.get("answer") or ""


def get_chunk_text(chunk_obj: Any) -> str:
    if isinstance(chunk_obj, dict):
        return chunk_obj.get("page_content", "")
    return str(chunk_obj)


def get_chunk_id(chunk_obj: Any) -> str:
    if not isinstance(chunk_obj, dict):
        return ""

    metadata = chunk_obj.get("metadata") or {}
    return (
        metadata.get("doc_id")
        or metadata.get("original_img_path")
        or metadata.get("source_file")
        or ""
    )


def load_data(input_file: str) -> List[Dict[str, Any]]:
    with open(input_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("Input file must be a JSON list.")
    return data


def save_results(output_file: str, results: List[Dict[str, Any]]) -> None:
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Annotate retrieved chunks JSON.")
    parser.add_argument("input_file", help="Path to the retrieved chunks JSON file.")
    parser.add_argument("output_file", help="Path to write the annotation results JSON file.")
    parser.add_argument("--model", default="deepseek-v3.2", help="LLM model name.")
    parser.add_argument(
        "--api-key",
        help="LLM API key.",
    )
    parser.add_argument(
        "--base-url",
        default="https://api.lkeap.cloud.tencent.com/v1",
        help="LLM base URL.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Maximum retries per chunk annotation.",
    )
    parser.add_argument(
        "--retry-delay-sec",
        type=float,
        default=1.0,
        help="Base retry delay in seconds. Actual sleep is delay * attempt index.",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=8,
        help="Maximum number of concurrent chunk annotation requests within a question.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    print("Starting annotation...")

    annotator = Annotator(
        args.model,
        args.api_key,
        args.base_url,
        max_retries=args.max_retries,
        retry_delay_sec=args.retry_delay_sec,
        max_workers=args.max_workers,
    )
    data = load_data(args.input_file)
    total_questions = len(data)
    print(f"Total questions: {total_questions}")

    results: List[Dict[str, Any]] = []
    for idx, item in enumerate(tqdm(data, desc="Annotating questions"), start=1):
        question = get_question_text(item)
        answer = get_answer_text(item)
        retrieved_chunks = item.get("retrieved_chunks", [])

        tqdm.write(f"Processing question {idx}/{total_questions}: {question[:80]}...")
        result = annotator.process_annotations(question, answer, retrieved_chunks)
        results.append(result)
        save_results(args.output_file, results)

    print(f"\nAll annotation completed! Saved to {args.output_file}")
