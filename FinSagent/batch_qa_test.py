#!/usr/bin/env python3
"""
批量 Agentic RAG QA 测试
从JSON文件读取问题，逐个测试并记录结果（包括激活的agents）
"""

import os
import sys
import json
import yaml
import logging
import asyncio
import time
from pathlib import Path
from typing import List, Dict, Any

# 添加 src 目录到 Python 路径
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

# 实验配置（可通过环境变量覆盖）
EXPERIMENT_NAME = os.environ.get("EXPERIMENT_NAME", "default")

# 设置日志
os.makedirs("./pe_logs", exist_ok=True)
_log_file = f'./pe_logs/batch_qa_test_{EXPERIMENT_NAME}.log'
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(_log_file),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def load_config():
    """加载配置文件"""
    config_path = os.environ.get("CONFIG_PATH") or os.path.join(os.path.dirname(__file__), 'config', 'production.yaml')
    try:
        logger.info(f"加载配置文件: {config_path}")
        with open(config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
        return config
    except Exception as e:
        logger.error(f"加载配置文件失败: {e}")
        return None

def load_questions(json_path: str) -> List[Dict[str, Any]]:
    """从JSON文件加载问题"""
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            questions = json.load(f)
        logger.info(f"✅ 成功加载 {len(questions)} 个问题")
        return questions
    except Exception as e:
        logger.error(f"❌ 加载问题文件失败: {e}")
        return []

def save_result(result: Dict[str, Any], output_path: str):
    """增量保存单个结果到JSON文件"""
    try:
        # 如果文件已存在，读取现有结果
        if os.path.exists(output_path):
            with open(output_path, 'r', encoding='utf-8') as f:
                try:
                    results = json.load(f)
                except json.JSONDecodeError:
                    results = []
        else:
            results = []
        
        # 添加新结果
        results.append(result)
        
        # 写回文件（带缩进，便于阅读）
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        
        logger.info(f"💾 结果已保存 (当前总数: {len(results)})")
    except Exception as e:
        logger.error(f"❌ 保存结果失败: {e}")

async def batch_qa_test(questions_path: str, output_path: str):
    """批量QA测试主函数"""
    
    # 加载配置
    config = load_config()
    if not config:
        logger.error("❌ 无法加载配置，退出测试")
        return
    
    # 加载问题
    questions = load_questions(questions_path)
    if not questions:
        logger.error("❌ 没有加载到问题，退出测试")
        return

    max_questions = int(os.environ.get("MAX_QUESTIONS", "0") or 0)
    if max_questions > 0:
        questions = questions[:max_questions]
        logger.info(f"🔬 MAX_QUESTIONS={max_questions}，仅运行前 {len(questions)} 个问题")
    
    # 确保输出目录存在
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    try:
        # 导入必要模块
        from core.ChatService import ChatService
        from core.RAGManager import RAGManager
        
        logger.info("🔧 正在初始化 RAG Manager...")
        rag_manager = RAGManager(config, collections={config['collection_name']: 10})
        
        logger.info("🔧 正在初始化 Chat Service...")
        chat_service = ChatService(
            config=config,
            rag_manager=rag_manager,
            rerank_topk=5
        )
        
        total = len(questions)
        success_count = 0
        failed_indices = []
        
        # 逐个测试问题
        for idx, question_data in enumerate(questions, 1):
            original_question = question_data.get("question", question_data.get("original_question", ""))
            original_answer = question_data.get("answer", "")
            question_idx = question_data.get("idx", idx)
            
            # 醒目的分隔符
            separator = "=" * 80
            logger.info(separator)
            logger.info(f"🔍 测试问题 [{idx}/{total}] | 索引: {question_idx}")
            logger.info("=" * 80)
            logger.info(f"📝 问题: {original_question}")
            logger.info("=" * 80)
            
            # 每次使用唯一的session_id，确保清除chat history
            session_id = f"batch_test_{question_idx}_{int(time.time() * 1000)}"
            
            # 开始计时
            start_time = time.time()
            
            try:
                # 调用 generate_response_async
                answer, chat_history, _, _ = await chat_service.generate_response_async(
                    question=original_question,
                    session_id=session_id,
                )

                # 结束计时
                elapsed_time = time.time() - start_time
                
                # 构建结果
                result = {
                    "idx": question_idx,
                    "experiment": EXPERIMENT_NAME,
                    "original_question": original_question,
                    "original_answer": original_answer,
                    "answer": answer,
                    "elapsed_time_seconds": round(elapsed_time, 2),
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "status": "success"
                }
                
                # 立即保存结果（增量写入）
                save_result(result, output_path)
                
                success_count += 1
                
                # 输出结果摘要
                logger.info("─" * 80)
                logger.info("✅ 测试成功")
                logger.info(f"⏱️  总耗时: {elapsed_time:.2f} 秒")
                answer_preview = answer[:150] + "..." if len(answer) > 150 else answer
                logger.info(f"📄 答案预览: {answer_preview}")
                logger.info("=" * 80 + "\n")
                
                print(f"✅ [{idx}/{total}] 完成 | 总耗时: {elapsed_time:.2f}s")
                
            except Exception as e:
                elapsed_time = time.time() - start_time
                logger.error("─" * 80)
                logger.error(f"❌ 问题 {idx} 处理失败: {e}")
                logger.error("─" * 80)
                import traceback
                traceback.print_exc()
                logger.error("=" * 80 + "\n")
                
                failed_indices.append(question_idx)
                
                # 记录失败结果
                result = {
                    "idx": question_idx,
                    "experiment": EXPERIMENT_NAME,
                    "original_question": original_question,
                    "original_answer": original_answer,
                    "answer": "",
                    "elapsed_time_seconds": round(elapsed_time, 2),
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "status": "failed",
                    "error": str(e)
                }
                save_result(result, output_path)
                
                print(f"❌ [{idx}/{total}] 失败 | 错误: {str(e)[:50]}")
            
            # 短暂延迟，避免请求过快
            await asyncio.sleep(0.5)
        
        # 输出最终统计
        final_separator = "=" * 80
        logger.info(final_separator)
        logger.info("🎉 批量测试完成!")
        logger.info("=" * 80)
        logger.info(f"📊 统计信息:")
        logger.info(f"   总问题数: {total}")
        logger.info(f"   ✅ 成功: {success_count}")
        logger.info(f"   ❌ 失败: {total - success_count}")
        if failed_indices:
            logger.info(f"   失败的索引: {failed_indices}")
        logger.info(f"   💾 结果文件: {output_path}")
        logger.info("=" * 80 + "\n")
        
        print(final_separator)
        print("🎉 批量测试完成!")
        print("=" * 80)
        print(f"总计: {total} | ✅ 成功: {success_count} | ❌ 失败: {total - success_count}")
        if failed_indices:
            print(f"失败索引: {failed_indices}")
        print(f"结果文件: {output_path}")
        print("=" * 80)
        
    except Exception as e:
        logger.error(f"❌ 测试执行失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    # 配置路径（可通过环境变量覆盖）
    QUESTIONS_JSON = os.environ.get(
        "QUESTIONS_JSON",
        "/root/autodl-tmp/dir_whw/FinSagent_COLM_experiments/zeekr_colm_e2e_gt_with_key_pts_0330.json",
    )
    OUTPUT_JSON = os.environ.get(
        "OUTPUT_JSON",
        f"/root/autodl-tmp/dir_whw/FinSagent/test/{EXPERIMENT_NAME}_test_results.json",
    )
    
    # 打印启动信息
    print("=" * 80)
    print(f"🚀 批量 Agentic RAG 测试启动  [实验: {EXPERIMENT_NAME}]")
    print("=" * 80)
    print(f"📂 问题文件: {QUESTIONS_JSON}")
    print(f"💾 结果文件: {OUTPUT_JSON}")
    print(f"🔬 ENABLE_TITLE_SUMMARIES={os.environ.get('ENABLE_TITLE_SUMMARIES', '1')}")
    print("=" * 80 + "\n")
    
    # 运行测试
    asyncio.run(batch_qa_test(QUESTIONS_JSON, OUTPUT_JSON))
