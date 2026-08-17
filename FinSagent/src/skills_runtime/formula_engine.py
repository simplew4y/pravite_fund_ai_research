"""Small, auditable expression evaluator for declarative finance skills."""

from __future__ import annotations

import ast
import math
import operator
from typing import Any


class FormulaError(ValueError):
    pass


_BINARY = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCTIONS = {"abs": abs, "min": min, "max": max, "round": round}


def evaluate_formula(expression: str, variables: dict[str, Any]) -> float:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"invalid expression: {exc}") from exc
    value = _evaluate(tree.body, variables)
    result = float(value)
    if not math.isfinite(result):
        raise FormulaError("formula produced a non-finite result")
    return result


def _evaluate(node: ast.AST, variables: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id not in variables:
            raise FormulaError(f"missing variable: {node.id}")
        value = variables[node.id]
        if not isinstance(value, (int, float)):
            raise FormulaError(f"variable {node.id} is not numeric")
        return value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        left = _evaluate(node.left, variables)
        right = _evaluate(node.right, variables)
        try:
            return _BINARY[type(node.op)](left, right)
        except ZeroDivisionError as exc:
            raise FormulaError("division by zero") from exc
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_evaluate(node.operand, variables))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCTIONS:
        if node.keywords:
            raise FormulaError("keyword arguments are not allowed")
        args = [_evaluate(arg, variables) for arg in node.args]
        return _FUNCTIONS[node.func.id](*args)
    raise FormulaError(f"unsupported formula syntax: {type(node).__name__}")
