#!/usr/bin/env python3
import os, sys, json, yaml, asyncio, logging

sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def load_config():
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'production.yaml')
    with open(config_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

async def run_test():
    config = load_config()

    from core.ChatService import ChatService
    from core.RAGManager import RAGManager

    logger.info("Initializing RAG Manager...")
    rag_manager = RAGManager(config, collections={'zeekr': 10})

    logger.info("Initializing Chat Service...")
    chat_service = ChatService(config=config, rag_manager=rag_manager, rerank_topk=5)

    # Load test questions
    q_path = os.path.join(os.path.dirname(__file__), 'question_company_profile.json')
    with open(q_path, 'r', encoding='utf-8') as f:
        questions = json.load(f)

    results = []
    for i, q in enumerate(questions):
        question = q['original_question']
        logger.info(f"\n{'='*60}")
        logger.info(f"[{i+1}/{len(questions)}] {question}")
        logger.info(f"{'='*60}")

        answer, history = await chat_service.generate_response_async(
            question=question,
            session_id=f"test_cp_{i}",
            mode="quick"
        )

        logger.info(f"Answer: {answer}")
        results.append({"question": question, "answer": answer})

    # Save results
    out_path = os.path.join(os.path.dirname(__file__), 'results_company_profile.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    logger.info(f"Results saved to {out_path}")

if __name__ == "__main__":
    asyncio.run(run_test())