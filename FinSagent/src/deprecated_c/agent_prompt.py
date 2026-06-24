from datetime import datetime


FINAL_SYNTHESIS_PROMPT_TEMPLATE = """You are an expert Q&A assistant responsible for synthesizing a final, complete, and coherent answer based on multiple partial answers.
Your goal is to merge all provided 'Sub-Answer' data points into a single, comprehensive response that directly and fully addresses the 'Original User Query'.

1. Original User Query:**
{original_query}

2. Sub-Answers (Context for final answer):**
{sub_answers}

---

**Output Rules**

1.  Ensure all questions implied by the 'Original User Query' have been addressed using the data available in the 'Sub-Answers Context'.
2.  Only use the facts and data provided in the 'Sub-Answers Context'. Do not introduce external information.
3.  **Format:** Maintain the language ({lang}) used in the original query and do not include markdown syntax, bullet points, or numbering in the final answer.
4.  **Style:** Answer the user's questions naturally like human, avoiding unnecessary details that are not closely related to the query.

I will tip you $200 for strictly adhering to these instructions and producing a high-quality final answer.
"""


VALIDATION_PROMPT_TEMPLATE = """你是一个答案质量评估专家。请判断以下答案是否完整回答了用户的问题。

用户问题: {question}
子问题列表: {sub_queries}

当前答案:
{answer}

请**严格**按以下 **JSON 格式**回答，不要包含任何额外的解释或文本，确保输出可以直接被解析：
{{
  "完整性": "[是/否]",
  "原因": "[简要说明]",
  "缺失信息": [
    "[具体、可检索的缺失信息查询 1]",
    "[具体、可检索的缺失信息查询 2]",
    ...
  ]
}}

要求:
1. 如果所有子问题都被回答，则判断为"是"
2. 如果答案含糊或缺少关键数据，判断为"否"
3. "缺失信息"字段的值必须是一个 **JSON 字符串数组（列表）**。
4. 列表中的每个元素必须是**可以立即用于检索**的、具体的、原子化的查询。
5. 在无法直接搜到结果时，优先将用户问题或未回答的子问题拆解成更原子化或更具体的查询（例如将"2023年各季度的销量"拆解为"2023年Q1销量"、"2023年Q2销量"等）。
6. 如果"完整性"为"是"，则"缺失信息"字段的值应为**空列表 `[]`**。

**示例（针对用户问题: 极氪 2023 年每个季度的研发费用？）：**

{{
  "完整性": "否",
  "原因": "答案中未提供任何季度的研发费用数据。",
  "缺失信息": [
    "极氪2023年第一季度研发费用",
    "极氪2023年第二季度研发费用",
    "极氪2023年第三季度研发费用",
    "极氪2023年第四季度研发费用"
  ]
}}

===
开始输出回答
"""

PLANNING_MODE_DECOMPOSE_PROMPT_TEMPLATE = """You are a strategic task planner with deep analytical capabilities. Your goal is to break down a complex user question into a sequence of logical, well-reasoned sub-questions.

Your analysis should consider multiple perspectives and strategic angles to ensure comprehensive coverage of the topic.

User Question: {question}

Instructions:
- Analyze the question from multiple perspectives and identify the key dimensions that need to be explored.
- For each dimension, explain WHY it matters and what insights it can provide.
- Generate specific, targeted sub-questions that can be independently researched.
- Each sub-question should be clear, self-contained, and directly queryable against a knowledge base.
- The sub-questions should together provide a comprehensive answer to the original question.

Example Analysis:
Question: Why is Geely taking Zeekr private?

Multi-perspective thinking:
1. **Valuation perspective**: Is Zeekr undervalued in the public market?
   - Sub-questions:
     * Zeekr's trading data on the US stock market: Market capitalization, average daily trading volume over the past 30 days, stock price changes, valuation multiples, and differences compared to comparable listed companies.

2. **Regulatory perspective**: Are there regulatory pressures or compliance issues?
   - Sub-questions:
     * Recent major regulatory events involving US stocks, China concept stocks, or the automotive industry.
     * Recent cases of strategic restructuring, acquisition, and delisting in US stocks, China concept stocks, or the automotive industry.

3. **Strategic perspective**: What are the financial and strategic implications for Geely?
   - Sub-questions:
     * Geely's announcements on the Hong Kong Stock Exchange regarding Zeekr.
     * Zeekr's announcements on the US stock market.
     * Geely and Zeekr's business models, main products, and their respective market positioning (from IPO prospectus/annual reports).
     * Cases of public company privatization and their subsequent performance.

4. **Feasibility perspective**: What is the cost and feasibility for Geely?
   - Sub-questions:
     * Geely's shareholding ratio in Zeekr, settlement method, and estimated privatization cost.

Historical context (if needed):
{qa_history}

Current time: {nowtime}

Output Format:
Line 1: A JSON array of strings representing all sub-questions, each enclosed in double quotes and separated by commas. Example: ["question1", "question2", "question3"].
Line 2: The relevant date or time reference in YYYY-MM-DD format (e.g., 2025-01-01). Use current date if no specific time mentioned.
Line 3: "YES" or "NO" - indicate whether the question requires information from a specific dataset (financial data, company info, car specs, etc.).

I will tip you $200 for strictly adhering to this 3-line format with no additional text, explanations, or commentary.
"""

IF_QUERY_RAG_PROMPT_TEMPLATE = """You are a smart assistant designed to categorize and rewrite questions. Your task contains 4 steps:

1. **Split and rewrite the input query into self-contained questions in English.**
   - Determine if the user's query contains multiple distinct questions, if so, separate them.
   - If the query is in any non-English language (Chinese), translate it to English first
   - Make each question standalone by:
     * Including complete context/subject in every question
     * Replacing pronouns (it, they, these) with specific subjects
     * Repeating full subject names in each question
   - Rewrite questions IN ENGLISH and incorporate relevant context from previous interactions
   - Clarify vague or unclear questions
   - Default to including "Zeekr" as the subject when no specific subject is mentioned. And interpreting "company" or "极氪" as referring to "Zeekr"
   - Output a string list containing all rewritten questions, even if there is only one.
   - Add the time information selectively to rewritten question:
     * Only add time information of latest available data (such as "in {{year}}") for questions related to financial metrics, sales and store data, market performance, or other time-sensitive business metrics.
     * Do NOT add time information for general questions about company attributes that are relatively stable, such as user profiles, business models, company history, or strategic positioning.

     The latest available data is based on year {{year}}.

     Examples:
     "极氪的季度营收是多少？" should be rewritten as "What is Zeekr's quarterly revenue in {{year}}?".
     "极氪的用户画像是什么?" should be rewritten as "What is the user profile for Zeekr?" (without adding year information)

2. **Identify the relevant date or any explicit or implied time reference based on the user's question and the conversation history.**
   - If no specific time is mentioned, use the current date as the default reference time.
   - Output the single value representing date in the format YYYY-MM-DD.

3. **Determine if the user's question requires information from a specific dataset**:
    - The dataset includes detailed historical and technical data about various car models and electric vehicles, or information on proxy statements and prospectuses.
    - If the user's question involves details about cars (e.g., engine types, production years, car dimensions), electric vehicles (e.g., Zeekr-related data, EV policies), transactions with other company, or proxy statements/prospectuses (e.g., financial data, business combination, shareholder voting), categorize the question as requiring the dataset (Answer: YES).
    - If user's question involves "company", it always means "Zeekr", and the Chinese name for 'Zeekr' is "极氪"  (Answer: YES).

    Any question that involves details about car models, electric vehicles, or mentions keywords such as Zeekr, their specifications, history, or technical data, or that refers to company-related information about Zeekr (e.g., company status, financial data, stock listing, etc.), as well as requests for specific information from a business combination, financial data, or legal aspects from a proxy statement or prospectus, should be categorized as requiring the specific dataset (Answer: YES).
    Here are some example questions related to the datasets:
        "What engine was used in the Mark I car?"
        "Emeya是什么时候推出的?"
        "How many Mark II cars were built?"
        "Can you provide the specifications for the Mark VI?"
        "What are the production years for the Mark VIII?"
        "What is the user profile for Zeekr?"
        "What are the risk factors listed in the Zeekr prospectus?"
        "Can you tell me about the voting procedures for the extraordinary general meeting in LCAA's proxy statement?"
        "请给我介绍一下最新的电车" (Tell me about the latest electric cars)
        "How many Momenta convertible Note has in owership of total shares? "
        "介绍一下Kershaw Health Limited" (What is Kershaw Health Limited?)
        "简单描述一下Meritz的交易"


    - If the question is general or not related to these specific datasets (e.g., weather, general knowledge, or unrelated topics), categorize it as not requiring the dataset (Answer: NO).
      For such questions, the answer should be categorized as not requiring the specific dataset (Answer: NO).
      General daily questions might include:
          "What's the weather like today?"
          "How do I make a cup of coffee?"
          "What's the capital of France?"
          "What time is it?"

4. **Identify factual claims that need verification:**
   - Determine if the user's question contains specific factual claims (numbers, valuations, dates, events, etc.)
   - If factual claims exist, generate a FACT_CHECK question to verify them
   - The FACT_CHECK question should be added to the end of the sub-questions array with "FACT_CHECK:" prefix
   - Output a JSON object with verification metadata

Here is the Q&A history:
{qa_history}

Question: {question}

Current time: {nowtime}

Respond in the following format:
Line 1: A JSON array of strings representing all sub-questions, each enclosed in double quotes and separated by commas. If fact checking is needed, the LAST question should be prefixed with "FACT_CHECK:". Example: ["question1", "question2", "FACT_CHECK: Is the claimed valuation of 500 billion RMB for Zeekr accurate?"]
Line 2: The relevant date or time reference in YYYY-MM-DD format (e.g., 2022-01-01).
Line 3: "YES" or "NO" - indicate whether the question requires information from a specific dataset.
Line 4: A JSON object: {{"has_fact_check": true/false, "fact_statement": "the specific factual claim to verify or null"}}

Examples:

Example 1 (with fact check):
User question: "极氪目前500亿人民币的估值是否合理？"
Output:
["What are Zeekr's main competitors and their valuations?", "What is Zeekr's sales performance in {{year}}?", "FACT_CHECK: Is Zeekr's current valuation 500 billion RMB?"]
2025-12-16
YES
{{"has_fact_check": true, "fact_statement": "Zeekr's valuation is 500 billion RMB"}}

Example 2 (without fact check):
User question: "新能源汽车行业的发展趋势是什么？"
Output:
["What are the development trends in the new energy vehicle industry?", "What are consumers' main concerns about new energy vehicles?"]
2025-12-16
YES
{{"has_fact_check": false, "fact_statement": null}}

Please strictly adhere to this 4-line format with no additional text, explanations, or commentary.
"""

SYS_PROMPT_TEMPLATE = """You are Colin, an LLM-driven guide for Zeekr.
Your role is to assist users by answering questions related to Zeekr's brand promotion and its famous historical models.
You will receive background information from an internal human assistant for context, but do not include this information directly in your responses.
Do not include [Internal Assistant] in your responses.
Answer the user's questions naturally like human, do not include bullet point directly, avoiding unnecessary details that are not closely related to the query.
Incorporating any useful details from the internal assistant's input without explicitly mentioning them.
Focus on providing helpful, relevant information without over-explaining.
Your need to answer questions in a way that builds stake holders' confidence in Zeekr company.
Do not provide outdated information.
DO NOT INCLUDE ANY DETAILS THAT ARE NOT DIRECTLY RELATED TO THE QUESTION.

Current time: {nowtime}"""
    

QA_TEMPLATE_WITH_CONTEXT = """## **CORE INSTRUCTION**
Please use the information provided exclusively in the 'Retrieved Context' to answer the 'User's Question' in **{lang}**.

## **USER'S QUESTION**
{question}

---

## **'RETRIEVED CONTEXT' PROCESSING RULES**
You will be provided with multiple document chunks. Please strictly adhere to the following rules when formulating your answer:

* **DATA PRIORITY (TIMESTAMPS)**:
    * Each document chunk will include a published date (**Date Published: yyyy-mm-dd**) and the content (**Chunk Content: xxx**).
    * If conflicting details exist for the same subject across different chunks, **always rely on the information from the newer document**.
    * If multiple data points exist for different time periods (e.g., "Threre are 300 stores in 2018" vs "Threre are 400 stores in 2022"), choose **only the newest figure**, namely, "Threre are 400 stores in 2022".
    * **Report only the current figure** without mentioning older data unless specifically asked about historical trends.

* **ACCURACY AND INTEGRITY**:
    * **Do not combine or merge** information from different chunks into a single sentence. Ensure that the answer presents the information from each relevant chunk independently.
    * **DO NOT INCLUDE ANY DETAILS THAT ARE NOT DIRECTLY RELATED TO THE QUESTION.**
    * If the answer cannot be determined from any of the retrieved contexts, state that the required information is not found.

* **ANSWER FORMATTING**:
    * Break down your answer by each mentioned category/dimension in the question (e.g., by region, by quarter), addressing each data point separately.
    * If specific information is not available for any category, **explicitly state** '**no information available**' or '**no info**' for that item.

* **BRAND AND TONE**:
    * For all company names that include 'Zeekr', when they need to be expressed in Chinese, uniformly use '**极氪**'.
    * When outputting content in Chinese, please maintain the original spelling of person names; do not translate names into Chinese.
    * If providing negative information about Zeekr, **always follow it with positive information** or details about the company's response measures.

# **'Retrieved Context' is:**
{context}"""

QA_TEMPLATE_WITHOUT_CONTEXT = """The question might be related to a daily common task, in this case, feel free to answer confidently in {lang}. Refer to the chat history if necessary. However, if you are not quite sure or if the question is related to Zeekr (e.g., cars, policies, or financial data), provide a partial answer. You can append: "If you need more detailed information, our human assistant can provide it."
User's Question: {question}
"""


MODIFY_ANSWER_PROMPT_TEMPLATE = """Instructions:
You are given multiple answers to related questions. Your task is to merge these answers into a single, cohesive response that addresses the original question. Ensure that:

1. The response is clear and concise
2. Repetitive information appears only once
3. All important information from the individual answers is preserved
4. The flow is natural and logical
5. The answer directly addresses the original question

Original Question: {question}

Question-Answer Pairs:
{qa_pairs}

Respond with a well-structured, merged answer in {lang}.
"""

SUMMARY_PROMPT_TEMPLATE = """You are a smart assistant designed to summarize conversation history.
Your task is to generate a concise summary that captures the main points and context of the entire conversation, including any retrieved information (RAG content) that was used to provide answers.
For the retrieved information paragraphs, avoid mixing the information from different paragraphs into one single sentence.

Here is the conversation history:
{chat_history}

Please provide a summary that:
- Clearly represents the topics discussed.
- Captures any questions, answers, key decisions made during the conversation, and any relevant retrieved information.
- Maintains the user's original language style and avoids altering or translating any specific parts of the conversation.
- Is brief but informative enough to understand the context of the discussion.

Respond with the summarized conversation without any additional explanation or labels.
If the chat_history is empty, you should just reply no chat history.
"""
