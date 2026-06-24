import subprocess
import sys
import os
import logging
import json
import threading  # 引入线程锁
import time
import concurrent.futures  # 引入并行执行库
import re

os.sync()  # 强制将内存中的数据写入磁盘

# 配置日志
log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "main_pipeline_secque.log")
logging.basicConfig(
    filename=log_file, 
    level=logging.INFO, 
    format='%(asctime)s - %(levelname)s - %(message)s')

# 创建一个锁对象
lock = threading.Lock()


from pathlib import Path


def find_subdirs(root_path):
    if not root_path.exists():
        return []
    return [str(dir_path).split('/')[-1] for dir_path in root_path.iterdir()
            if dir_path.is_dir()]


def replace_spaces_in_path(path):
    """替换路径中的空格为下划线"""
    return path.replace(" ", "_")

def validate_path(path):
    """增强路径验证"""
    if not os.path.exists(path):
        raise FileNotFoundError(f"路径不存在: {path}")
    return os.path.abspath(path)

def build_step_paths(input_path, output_dir):
    """构建各步骤路径的工厂函数"""
    base_name = os.path.basename(input_path)
    base_name = base_name.replace('_content_list', '').replace('.json', '')
    base_name = replace_spaces_in_path(base_name)  # 替换路径中的空格
    
    paths = {
        # 步骤配置
        'step2_output': os.path.join(output_dir, base_name, "base.json"),
        'step3_output': os.path.join(output_dir, base_name, "base_remove_empty.json"),
        'step6_output': os.path.join(output_dir, base_name, "base_remove_empty_processed.json"),
        'step7_output': os.path.join(output_dir, base_name, "base_processed_chunked.json"),  # 修改为processed_chunked
        'step8_output': os.path.join(output_dir, base_name, "base_final.json"),  # 最终输出命名为final
        
        # 中间目录
        'work_dir': os.path.join(output_dir, base_name)
    }

    return paths

def check_file_existence(file_path):
    """确保文件存在，增加锁机制"""
    with lock:  # 锁住检查文件操作，避免并发读取/写入冲突
        while not os.path.exists(file_path):
            logging.info(f"文件 {file_path} 尚未生成，等待中...")
            time.sleep(1)  # 等待1秒后再次检查

def reset_ids(file_path):
    """重设 JSON 文件中的 ID，从 1 开始"""
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    current_id = 1
    for item in data:
        if 'id' in item:  # 只处理有 id 字段的项
            item['id'] = current_id
            current_id += 1

    # 写回文件
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def generate_final_json(step7_output_path, final_output_path):
    """生成 final.json"""
    with open(step7_output_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 此处可以根据需求进行进一步的处理
    with open(final_output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def infer_company_name(input_path):
    """按 SEC 文件名中的 `_10` 截断提取公司名"""
    base_name = os.path.basename(input_path)
    base_name = base_name.replace('_content_list', '').replace('.json', '')
    company_part = re.split(r"_10", base_name, maxsplit=1, flags=re.IGNORECASE)[0]
    company_name = company_part.replace("_", " ").strip(" -_")
    return company_name or "the company"


def process_document(input_path, output_dir, enable_summary):
    try:
        # ========== 初始化验证 ==========
        input_path = validate_path(input_path)
        output_dir = os.path.abspath(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        
        # 获取各步骤路径
        path_config = build_step_paths(input_path, output_dir)
        work_dir = path_config['work_dir']
        os.makedirs(work_dir, exist_ok=True)

        # ========== 检查是否已处理完成 ==========
        if os.path.isfile(path_config['step8_output']):
            logging.info(f"已存在 base_final.json，跳过处理: {path_config['step8_output']}")
            print(f"[SKIP] base_final.json already exists: {path_config['step8_output']}")
            return

        # ========== Step 1: 基础处理 (skip image processing) ==========
        logging.info("[Step 1/5] 启动基础处理流程 (跳过图片分析)...")
        step2_cmd = [
            "python", "step2_mineru2base.py",
            input_path,
            output_dir,
            "--skip-image-chunks" # ! 跳过表格
        ]
        subprocess.run(step2_cmd, check=True)
        
        check_file_existence(path_config['step2_output'])  # 使用锁机制检查文件是否生成
        logging.info(f"基础处理完成: {path_config['step2_output']}")

        # ========== Step 2: 数据清洗 ==========
        logging.info("[Step 2/5] 启动数据清洗...")
        step3_cmd = [
            "python", "step3_remove_empty_content.py",
            path_config['step2_output']
        ]
        subprocess.run(step3_cmd, check=True)
        
        check_file_existence(path_config['step3_output'])  # 使用锁机制检查文件是否生成
        logging.info(f"数据清洗完成: {path_config['step3_output']}")

        # ========== Step 3: 指代消解与摘要生成 ==========
        print("[Step 3/5] 启动指代消解与摘要生成...")

        check_file_existence(path_config['step3_output'])  # 使用锁机制检查文件是否生成
        
        # 检查文件内容是否有效
        try:
            with open(path_config['step3_output'], 'r', encoding='utf-8') as f:
                data = json.load(f)
                if not data:
                    raise ValueError("步骤3输出文件为空")
        except Exception as e:
            raise ValueError(f"步骤3输出文件无效: {str(e)}")

        # 确保输出目录存在
        step6_output_dir = os.path.dirname(path_config['step6_output'])
        os.makedirs(step6_output_dir, exist_ok=True)

        # 执行步骤6
        company_name = infer_company_name(input_path)
        step6_cmd = [
            "python", "step6_anaphora_resolution_general.py",
            os.path.abspath(path_config['step3_output']),  # 使用绝对路径，确保路径正确
            os.path.abspath(path_config['step6_output']),  # 使用绝对路径
            company_name,
        ]
        if enable_summary:
            step6_cmd.append("--generate-summary")
        subprocess.run(step6_cmd, check=True)

        check_file_existence(path_config['step6_output'])  # 使用锁机制检查文件是否生成
        logging.info(f"指代消解与摘要生成完成: {path_config['step6_output']} (company_name={company_name})")

        # ========== Step 4: 文本分块 ==========
        logging.info("[Step 4/5] 启动文本分块处理...")
        step7_cmd = [
            "python", "step7_split_chunks.py",  # 确保脚本名是正确的
            "-i", path_config['step6_output'],  # 输入文件
            "-o", path_config['step7_output'],  # 输出文件
            "-s", str(256)  # 块大小
        ]
        subprocess.run(step7_cmd, check=True)

        check_file_existence(path_config['step7_output'])  # 使用锁机制检查文件是否生成
        logging.info(f"文本分块处理完成: {path_config['step7_output']}")

        # ========== Step 5: 重设 ID 并生成 final ==========
        logging.info("[Step 5/5] 启动 ID 重设处理...")
        reset_ids(path_config['step7_output'])  # 重设 step7 输出

        logging.info("[Step 5/5] 生成 final.json 文件...")
        generate_final_json(path_config['step7_output'], path_config['step8_output'])  # 生成 final.json
        logging.info(f"final.json 生成完成: {path_config['step8_output']}")

    except subprocess.CalledProcessError as e:
        logging.error(f"子流程执行失败: {str(e)}")
        sys.exit(1)
    except Exception as e:
        logging.error(f"流程错误: {str(e)}")
        sys.exit(1)


def main():
    # 输入文件路径列表
    # input_files = [
    #     "/root/autodl-tmp/file2chunk/mineru2/Lotus F-1 20240503/auto/Lotus F-1 20240503_content_list.json",
    #     "/root/autodl-tmp/file2chunk/mineru2/Lotus 424B3 20241112/auto/Lotus 424B3 20241112_content_list.json"
    # ]
    

    # 设置根目录
    #root_folder = "/root/autodl-tmp/file2chunk/script/pipeline_test"
    root_folder = "/root/autodl-tmp/RAG_Agent_data/secque/processed_pdf"

    # Example usage

    processed = find_subdirs(Path("/root/autodl-tmp/RAG_Agent_data/secque/final_pdf"))

    whole_list = find_subdirs(Path("/root/autodl-tmp/RAG_Agent_data/secque/processed_pdf"))

    #print(len(processed))
    #print(len(whole_list))

    unfinished = (([x for x in whole_list if x not in processed]))
    # print(len(unfinished))

    # 存储所有 `_content_list.json` 文件的路径
    content_list_files = []

    # 遍历所有子文件夹
    #print(os.walk(root_folder))
    for subdir, _, files in os.walk(root_folder):
        #print(subdir)
        for file in files:
            if file.endswith("_content_list.json"):
                if subdir.split('/')[-2] in unfinished:
                    #print(subdir.split('/')[-2])
                    content_list_files.append(os.path.join(subdir, file))

    # # 打印所有匹配的文件路径
    for content_file in content_list_files:
        logging.info(f"{content_file}")
    input_files = content_list_files
    logging.info(f"{len(input_files)} files in total")
    output_dir = "/root/autodl-tmp/RAG_Agent_data/secque/final_pdf"
    max_workers = 4
    enable_summary = True
    
    # 使用多线程处理每个输入文件
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = []
        for input_path in input_files:
            futures.append(executor.submit(process_document, input_path, output_dir, enable_summary))

        # 等待所有线程完成
        concurrent.futures.wait(futures)

if __name__ == "__main__":
    main()
