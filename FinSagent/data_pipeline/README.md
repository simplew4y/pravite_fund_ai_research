# file2chunk

## 步骤
1. 使用Mineru切chunk： 
    * env: `source activate /root/autodl-tmp/cjj/code/file2chunk/.venv/bin/activate`
    * `cd file2chunk`
    * `python mineru_analysis.py`
        * 修改 MinerU config: `/root/mineru.json`
2. 执行pipeline处理
    * `cd file2chunk`
    * `python main_pipeline_v5_20260426`
        * 设置`collection_name`
        * 按需添加中间处理步骤
        * 需要设置 `.env`
        * 现在使用deepseek-v4-pro，hardcode关掉thinking，如需换模型可以修改。
3. 处理表格
    * `bash run_process_table.sh`
    * 需要设置 `.env`
    * 需本地处理，服务器上连不上anthropic
4. 加载并持久化至Chroma
    1. 设置参数：
        * `config_path`
        * `collection_name`
    2. 加载文字chunk: `python data_pipeline/load_data.py`
    3. 加载table chunk: `python data_pipeline/load_table_chroma.py`

## Main Pipeline

### Step2
* title 合并逻辑：
    ```txt
        Threshold: title group should >= 500 characters

        Step 1:
        A > B > C > D1 [chunk1]
        A > B > C > D2 [chunk2]
        
        Step 2:
        A > B > C1 [ D1+chunk1, D2+chunk2 ]
        A > B > C2 [chunk3]

        Step 3:
        A > B [C1+D1+chunk1, C1+D2+chunks, C2+chunk3]
    ```
