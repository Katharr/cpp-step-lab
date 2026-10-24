"""从已观察到的单步和执行前数据提取格子读写，不向 GDB 求值用户表达式。"""
import re


def empty_access():
    return {"line": None, "reads": [], "writes": []}


def collect_access(facts, previous, frames, motion, status):
    result = empty_access()
    if not previous or previous["status"] != "paused" or status != "paused" or motion not in ("next", "step"):
        return result
    old = previous["frames"][0]
    if not frames or frames[0]["id"] != old["id"] or not old["line"] or frames[0]["line"] == old["line"]:
        return result
    line = old["line"]
    statements = [node for node in _walk(facts.tree.root_node)
                  if node.type in ("expression_statement", "declaration")
                  and node.start_point.row + 1 == line]
    if len(statements) != 1:
        return result
    statement = statements[0]
    if statement.start_point.row != statement.end_point.row or statement.has_error:
        return result
    if statement.type == "declaration" and len(statement.children_by_field_name("declarator")) != 1:
        return result
    ancestor = statement.parent
    while ancestor:
        if ancestor.type in ("if_statement", "while_statement", "for_statement", "do_statement", "switch_statement") and ancestor.start_point.row + 1 == line:
            return result
        ancestor = ancestor.parent
    # 条件路径、调用、副作用下标及同一行的多重赋值都不推测。
    nodes = list(_walk(statement))
    assignments = [node for node in nodes if node.type == "assignment_expression"]
    updates = [node for node in nodes if node.type == "update_expression"]
    if len(assignments) + len(updates) > 1:
        return result
    if updates and (statement.named_child_count != 1 or statement.named_children[0].id != updates[0].id):
        return result
    if any(node.type in ("call_expression", "conditional_expression", "lambda_expression", "sizeof_expression", "pointer_expression", "comma_expression", "decltype", "noexcept_expression")
           # >> 可能是输入流写入；缺少流成功证明时不能标作读取。
           or (node.type == "binary_expression" and facts.text(node.child_by_field_name("operator")) in ("&&", "||", ">>"))
           for node in nodes):
        return result
    lookup = {}
    for item in sorted(previous["variables"], key=lambda item: (item.get("frame") is None, item.get("depth", 0))):
        if item.get("visible") and not item.get("shadowed"):
            lookup.setdefault(item["name"], item)

    def integer(node):
        if node is None:
            raise ValueError()
        text = facts.text(node)
        if node.type == "number_literal":
            if not re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)(?:[uUlL]*)", text):
                raise ValueError()
            value = re.sub(r"[uUlL]+$", "", text)
            return int(value, 8 if len(value) > 1 and value[0] == "0" and value[1].isdigit() else 0 if value.startswith(("0x", "0X", "0b", "0B")) else 10)
        if node.type == "identifier":
            item = lookup.get(text, {})
            if item.get("state") == "ok" and re.fullmatch(r"-?\d+", item.get("value") or ""):
                return int(item["value"])
            raise ValueError()
        if node.type in ("parenthesized_expression", "subscript_argument_list") and node.named_child_count == 1:
            return integer(node.named_children[0])
        if node.type == "unary_expression":
            value = integer(node.child_by_field_name("argument"))
            operator = facts.text(node.child_by_field_name("operator"))
            if operator in ("+", "-", "~", "!"):
                return {"+": lambda: value, "-": lambda: -value, "~": lambda: ~value, "!": lambda: int(not value)}[operator]()
        if node.type == "binary_expression":
            left, right = integer(node.child_by_field_name("left")), integer(node.child_by_field_name("right"))
            operator = facts.text(node.child_by_field_name("operator"))
            if max(abs(left), abs(right)) > 2 ** 53:
                raise ValueError()
            if operator in ("/", "%") and right:
                quotient = (abs(left) // abs(right)) * (-1 if (left < 0) != (right < 0) else 1)
                return quotient if operator == "/" else left - quotient * right
            operations = {"+": lambda: left + right, "-": lambda: left - right, "*": lambda: left * right,
                          "&": lambda: left & right, "|": lambda: left | right, "^": lambda: left ^ right}
            if operator in operations:
                return operations[operator]()
        raise ValueError()

    target = assignments[0].child_by_field_name("left") if assignments else updates[0].child_by_field_name("argument") if updates else None
    for node in nodes:
        if node.type != "subscript_expression" or (node.parent and node.parent.type == "subscript_expression"):
            continue
        base, coordinates = node, []
        try:
            while base.type == "subscript_expression":
                coordinates.insert(0, integer(base.child_by_field_name("indices")))
                base = base.child_by_field_name("argument")
            if base.type != "identifier":
                continue
            item = lookup.get(facts.text(base), {})
            data = item.get("data") or {}
            if item.get("state") != "ok" or data.get("state") != "ok" or len(coordinates) != len(data.get("shape", [])):
                continue
            if any(not lower <= coordinate < lower + size for coordinate, lower, size in zip(coordinates, data["lowerBounds"], data["shape"])):
                continue
            entry = {"variableId": item["id"], "coordinates": coordinates}
            writing = target is not None and node.id == target.id
            if writing:
                result["writes"].append(entry)
            if not writing or updates or facts.text(assignments[0].child_by_field_name("operator")) != "=":
                result["reads"].append(entry)
        except (ValueError, TypeError, AttributeError, OverflowError):
            continue
    if result["reads"] or result["writes"]:
        result["line"] = line
    return result


def _walk(node):
    yield node
    for child in node.named_children:
        yield from _walk(child)
