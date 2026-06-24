PLANNING_PROMPT_TEMPLATE = """You are a high-level task planner. Your goal is to break down a complex user question into a sequence of logical steps.
Each step will be executed by an intelligent agent (AgenticRAG).

User Question: {question}

Instructions:
- Please analyze the question and provide a plan as a JSON list of strings.
- Each string should be a clear, self-contained task or question.
- Do not create too many granular steps; the agent is capable of handling complex queries. Focus on high-level logical dependencies.

Example:
Question: Why is Geely taking Zeekr private?
You could think from several perspectives:
1. First, consider the general purposes for a public company to go private: including undervaluation, strategic restructuring, and regulatory issues.
To answer this, possible sub-questions include:
    - Query: Zeekr's trading data on the US stock market: Market capitalization/Average daily trading volume over the past 30 days, stock price changes, valuation multiples, and differences compared to comparable listed companies.
    - Query: Recent major regulatory events involving US stocks / China concept stocks / the automotive industry.
    - Query: Recent cases of strategic restructuring, acquisition, and delisting in US stocks / China concept stocks / the automotive industry.
2. The second point is the feasibility/cost for Geely, as the controlling shareholder of Zeekr, to take Zeekr private: Shareholding ratio, settlement method, and privatization cost.
To answer this, possible sub-questions include:
    - Query: Geely's announcements on the Hong Kong Stock Exchange.
    - Query: Zeekr's announcements on the US stock market - 6K.
3. The strategic impact of Geely and Zeekr both being car manufacturers, and Geely Automobile being an HKEX-listed company, on the privatization of Zeekr.
To answer this, possible sub-questions include:
    - Query: Geely and Zeekr's business models, main products, and their respective market positioning (IPO prospectus/annual report).
    - Query: Cases of public company privatization and their subsequent performance.

Plan: [
    "Zeekr's trading data on the US stock market: Market capitalization/Average daily trading volume over the past 30 days, stock price changes, valuation multiples, and differences compared to comparable listed companies.",
    "Recent major regulatory events involving US stocks / China concept stocks / the automotive industry.",
    "Recent cases of strategic restructuring, acquisition, and delisting in US stocks / China concept stocks / the automotive industry.",
    "Geely's announcements on the Hong Kong Stock Exchange.",
    "Zeekr's announcements on the US stock market - 6K.",
    "Geely and Zeekr's business models, main products, and their respective market positioning (IPO prospectus/annual report).",
    "Cases of public company privatization and their subsequent performance."
]

Output MUST be a valid JSON array of strings.
"""

RETHINK_PROMPT_TEMPLATE = """You are a task controller overseeing the execution of a complex query.
You have an original question and a history of executed steps and their results.
Your job is to decide what to do next.

Original Question: {question}

Execution History:
{history}

Analyze the history.
1. Have we gathered enough information to answer the original question?
2. If YES, synthesize the final answer.
3. If NO, determine what steps are still needed.

Output MUST be a valid JSON object with the following fields:
- "status": "done" or "continue"
- "thought": A brief explanation of your reasoning.
- "final_answer": (If status is "done") The comprehensive final answer to the user's question.
- "next_steps": (If status is "continue") A list of strings representing the next steps to execute.

Example Output (Done):
{{
    "status": "done",
    "thought": "We have gathered revenue data for both companies and performed the comparison.",
    "final_answer": "Apple's revenue growth was...",
    "next_steps": []
}}

Example Output (Continue):
{{
    "status": "continue",
    "thought": "We have Apple's data but failed to get Microsoft's data due to missing context.",
    "final_answer": "",
    "next_steps": ["Find Microsoft's 2023 financial report summary"]
}}
"""

RETHINK_FORCE_DONE_PROMPT_TEMPLATE = """You are a task controller overseeing the execution of a complex query.
You have reached the maximum number of allowed steps (Budget Exhausted).
You MUST now synthesize the best possible answer using ONLY the information gathered so far.
Do NOT propose any new steps.

Original Question: {question}

Execution History:
{history}

Task:
Synthesize a final answer based on the history. If the history is insufficient, state clearly what is missing but still provide the partial answer.

Output MUST be a valid JSON object with the following fields:
- "status": "done"
- "thought": A brief explanation of how you synthesized the answer from available data.
- "final_answer": The comprehensive final answer (or partial answer) to the user's question.

Example Output:
{{
    "status": "done",
    "thought": "Budget exhausted. Synthesizing partial answer based on available data.",
    "final_answer": "Based on the retrieved information, I can confirm that..."
}}
"""
