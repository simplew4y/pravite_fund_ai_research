import json
import logging
from typing import List, Dict, Any, TypedDict, Annotated
import operator
from langgraph.graph import StateGraph, END

from deprecated_c.controller_prompt import PLANNING_PROMPT_TEMPLATE, RETHINK_PROMPT_TEMPLATE, RETHINK_FORCE_DONE_PROMPT_TEMPLATE
from core.AgenticRAG import answer_with_agentic_rag

logger = logging.getLogger(__name__)

class ControllerState(TypedDict):
    """State for the Task Controller Graph"""
    original_question: str
    plan: List[str]              # List of steps to execute
    current_step: str            # The step currently being executed
    history: List[Dict[str, str]] # Execution history: [{step, result}, ...]
    final_answer: str
    status: str                  # "planning", "continue", "done"
    iteration: int               # Safety counter
    max_iterations: int          # Budget limit
    chat_manager: Any            # Passed in context
    rag_manager: Any            # Passed in context

async def plan_node(state: ControllerState) -> Dict[str, Any]:
    """Generate the initial plan."""
    question = state["original_question"]
    chat_manager = state["chat_manager"]
    
    prompt = PLANNING_PROMPT_TEMPLATE.format(question=question)
    messages = [{"role": "user", "content": prompt}]

    try:
        response = chat_manager.llm.chat.completions.create(
            model=chat_manager.model_name,
            messages=messages,
            temperature=0,
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        logger.info(f"[Controller] Initial Plan: {content}")
        
        if content.startswith("```json"):
            content = content.replace("```json", "").replace("```", "")
        
        plan_data = json.loads(content)
        plan = plan_data.get("steps", plan_data) if isinstance(plan_data, dict) else plan_data
        
        if not isinstance(plan, list):
            plan = [question]
            
    except Exception as e:
        logger.error(f"Error generating plan: {e}")
        plan = [question]

    return {
        "plan": plan,
        "status": "continue",
        "iteration": 0,
        "max_iterations": 10 # Default max iterations
    }

async def execute_node(state: ControllerState) -> Dict[str, Any]:
    """Execute the next step in the plan using AgenticRAG."""
    plan = state["plan"]
    if not plan:
        # Should not happen if logic is correct, but handle gracefully
        return {"status": "done", "final_answer": "No steps left to execute."}

    # Pop the next step
    current_step = plan[0]
    remaining_plan = plan[1:]
    
    logger.info(f"[Controller] Executing step: {current_step}")
    
    try:
        # Invoke the AgenticRAG sub-graph/process
        # We use the wrapper function here, which handles the workflow internal setup
        step_result = await answer_with_agentic_rag(
            chat_manager=state["chat_manager"],
            rag_manager=state["rag_manager"],
            user_query=current_step
        )
    except Exception as e:
        logger.error(f"Error executing step '{current_step}': {e}")
        step_result = f"Error executing this step: {str(e)}"

    # Update history
    new_history_item = {
        "step": current_step,
        "result": step_result
    }
    
    updated_history = state.get("history", []) + [new_history_item]

    return {
        "plan": remaining_plan,
        "current_step": current_step,
        "history": updated_history,
        "iteration": state["iteration"] + 1
    }

async def rethink_node(state: ControllerState) -> Dict[str, Any]:
    """Review history and decide next steps."""
    question = state["original_question"]
    history = state["history"]
    chat_manager = state["chat_manager"]
    iteration = state.get("iteration", 0)
    max_iterations = state.get("max_iterations", 10)
    
    history_text = "\n".join([
        f"Step: {item['step']}\nResult: {item['result']}\n"
        for item in history
    ])

    # Check if budget is exhausted
    is_budget_exhausted = iteration >= max_iterations
    
    if is_budget_exhausted:
        logger.warning(f"[Controller] Budget exhausted (iteration {iteration}/{max_iterations}). Forcing wrap-up.")
        prompt_template = RETHINK_FORCE_DONE_PROMPT_TEMPLATE
    else:
        prompt_template = RETHINK_PROMPT_TEMPLATE

    prompt = prompt_template.format(
        question=question,
        history=history_text
    )
    messages = [{"role": "user", "content": prompt}]

    try:
        response = chat_manager.llm.chat.completions.create(
            model=chat_manager.model_name,
            messages=messages,
            temperature=0,
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        logger.info(f"[Controller] Rethink Decision (Budget Exhausted={is_budget_exhausted}): {content}")
        
        if content.startswith("```json"):
            content = content.replace("```json", "").replace("```", "")
            
        decision = json.loads(content)
        
        status = decision.get("status", "continue")
        final_answer = decision.get("final_answer", "")
        new_steps = decision.get("next_steps", [])
        
        # If budget exhausted, force status to done even if model says continue
        if is_budget_exhausted:
            status = "done"
            if not final_answer:
                final_answer = "Budget exhausted. Unable to complete all planned steps. Partial info: " + history_text[:500] + "..."

        updates = {
            "status": status,
            "final_answer": final_answer
        }
        
        if status == "continue" and new_steps:
            current_plan = state.get("plan", [])
            updates["plan"] = new_steps + current_plan
            
        return updates

    except Exception as e:
        logger.error(f"Error during rethink: {e}")
        return {
            "status": "done", 
            "final_answer": "Error during reasoning phase. Returning gathered info.\n\n" + history_text
        }

def build_controller_graph():
    workflow = StateGraph(ControllerState)
    
    workflow.add_node("planner", plan_node)
    workflow.add_node("executor", execute_node)
    workflow.add_node("rethinker", rethink_node)
    
    workflow.set_entry_point("planner")
    
    workflow.add_edge("planner", "executor")
    workflow.add_edge("executor", "rethinker")
    
    def should_continue(state: ControllerState) -> str:
        if state["status"] == "done":
            return END
            
        # Note: Budget check is now handled inside rethinker to allow for final synthesis.
        # But as a safety net, if rethinker failed to set status=done on max_iterations, we catch it here.
        if state["iteration"] > state.get("max_iterations", 10): 
             logger.warning("Max iterations exceeded safety check.")
             return END
             
        if not state["plan"]:
            logger.warning("Controller status is continue but plan is empty. Ending.")
            return END
            
        return "executor"

    workflow.add_conditional_edges(
        "rethinker",
        should_continue,
        {
            "executor": "executor",
            END: END
        }
    )
    
    return workflow.compile()

class TaskController:
    def __init__(self, chat_manager, rag_manager):
        self.chat_manager = chat_manager
        self.rag_manager = rag_manager
        self.app = build_controller_graph()

    async def run(self, user_query: str) -> str:
        """Run the controller workflow."""
        logger.info(f"Starting TaskController Graph for: {user_query}")
        
        initial_state = {
            "original_question": user_query,
            "plan": [],
            "current_step": "",
            "history": [],
            "final_answer": "",
            "status": "planning",
            "iteration": 0,
            "max_iterations": 1, # Configurable budget
            "chat_manager": self.chat_manager,
            "rag_manager": self.rag_manager
        }
        
        try:
            final_state = await self.app.ainvoke(initial_state)
            
            answer = final_state.get("final_answer")
            if not answer:
                # Fallback if loop exited without explicit answer
                history = final_state.get("history", [])
                answer = "Process completed but no final answer generated. Summary:\n" + \
                         "\n".join([f"- {h['step']}: {h['result'][:100]}..." for h in history])
            
            return answer
            
        except Exception as e:
            logger.error(f"TaskController Graph execution failed: {e}")
            return f"Error executing task controller: {str(e)}"
