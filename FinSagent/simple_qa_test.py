#!/usr/bin/env python3
"""
简单的 Agentic RAG QA 测试
"""

import os
import sys
import yaml
import logging
import asyncio
import time

# 添加 src 目录到 Python 路径
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

# 设置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('./pe_logs/simple_qa_test_tools.log'),  # 写入文件
        logging.StreamHandler()  # 同时输出到控制台
    ]
)
logger = logging.getLogger(__name__)

def load_config():
    """加载配置文件"""
    config_path = os.path.join(os.path.dirname(__file__), 'config', 'production.yaml')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
        return config
    except Exception as e:
        logger.error(f"加载配置文件失败: {e}")
        return None

async def simple_qa_test():
    """简单的QA测试"""

    # 加载配置
    config = load_config()
    if not config:
        logger.error("无法加载配置，退出测试")
        return

    try:
        # 导入必要模块
        from core.ChatService import ChatService
        from core.RAGManager import RAGManager

        logger.info("正在初始化 RAG Manager...")
        rag_manager = RAGManager(config, collections={config['collection_name']: 10})

        logger.info("正在初始化 Chat Service...")
        chat_service = ChatService(
            config=config,
            rag_manager=rag_manager,
            rerank_topk=5
        )

        # 测试问题列表（从 xbh_test_basic_financial.log 中提取的30题）
        test_questions = [
            # "吉利为什么要私有化极氪",
            # "吉利为什么要私有化极氪",
            # "极氪2023年第2季度和第三季度分别的研发费用",
            # "极氪管理团队在豪华车市场的经验有哪些？",
            # "极氪目前 500000 亿美元的估值是否合理？",
            # "极氪 2024 年第三季度交付量？",
            # "极氪在中国的销售网络？"，
            # "What is Zeekr's gross margin?"
            # "Zeekr 的 52 周股价区间是多少？近一年股价表现如何？"
            # "What is Zeekr's gross margin in 2025?"
            # "Zeekr 的市值和企业价值（EV）分别是多少？两者差距说明了什么？"
            "NVIDIA在2025财年推出的GeForce RTX 50 Series有什么特点？"
        ]

        session_id = "simple_test_session"
        all_results = []

        # 测试每个问题
        for i, test_question in enumerate(test_questions, 1):
            logger.info("="*60)
            logger.info(f"测试问题 {i}/{len(test_questions)}: {test_question}")
            logger.info("="*60)

            # 开始计时
            start_time = time.time()

            # 调用重构后的接口，传入模式
            answer, chat_history, _, _ = await chat_service.generate_response_async(
                question=test_question,
                session_id=session_id,
            )

            # 结束计时
            end_time = time.time()
            elapsed_time = end_time - start_time

            # 结构化结果记录
            known = KNOWN_RESULTS.get(test_question, {})
            result = {
                "num": i,
                "question": test_question,
                "answer": answer,
                "elapsed": elapsed_time,
                "bf_called": known.get("bf_called"),
                "bf_error_before": known.get("bf_error", False),
                "bf_timeout_before": known.get("bf_timeout", False),
            }
            all_results.append(result)

            # 输出结果
            logger.info("="*60)
            logger.info("测试结果:")
            logger.info(f"原始问题: {test_question}")
            logger.info(f"最终答案: {answer}")
            logger.info(f"耗时: {elapsed_time:.2f} 秒")
            logger.info(f"对话历史长度: {len(chat_history.split(chr(10)))}")

            print("\n" + "="*60)
            print(f"🎉 测试问题 {i}/{len(test_questions)} 完成! (耗时: {elapsed_time:.2f}s)")
            print("="*60)
            print(f"问题: {test_question}")
            print(f"答案: {answer}")
            print("="*60 + "\n")

        # ============================================================
        # 测试完成，打印汇总表
        # ============================================================
        print("\n" + "="*100)
        print("📊 测试结果汇总 (对比优化前的日志)")
        print("="*100)
        header = f"{'Q#':>3} | {'优化前bf错误':>10} | {'优化前bf超时':>10} | {'耗时(s)':>7} | 问题"
        print(header)
        print("-" * 100)
        improved = 0
        same = 0
        for r in all_results:
            before_err = "ERR" if r["bf_error_before"] else "-"
            before_tmo = "TMO" if r["bf_timeout_before"] else "-"
            q = r["question"][:50]
            print(f"{r['num']:3d} | {before_err:>10} | {before_tmo:>10} | {r['elapsed']:>7.1f} | {q}")
            if r["bf_error_before"] or r["bf_timeout_before"]:
                if r["elapsed"] < 40:
                    improved += 1
                else:
                    same += 1
            else:
                same += 1
        print("-" * 100)
        print(f"✅ 优化后 错误/超时类问题耗时显著改善: {improved} 题")
        print(f"📌 耗时基本持平（原超时但仍慢）: {same} 题")
        print(f"📋 总计: {len(all_results)} 题")
        print("="*100 + "\n")

        print("\n" + "="*60)
        print("✅ 所有测试完成!")
        print("="*60)

    except Exception as e:
        logger.error(f"测试执行失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    print("🚀 开始 Agentic RAG 简单测试...")
    asyncio.run(simple_qa_test())
