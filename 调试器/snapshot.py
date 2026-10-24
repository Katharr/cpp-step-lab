"""真实符号身份 + 成熟 C++ 语法树；仅确认亲眼单步执行的简单初始化。"""
from copy import deepcopy
import re

from tree_sitter import Language, Parser
import tree_sitter_cpp
from access_trace import collect_access


def normalize_data(item, old):
    data = item.get("data")
    if not data:
        return
    item["dataKey"] = item["rawId"]
    before = {tuple(element["coordinates"]): element
              for element in ((old or {}).get("data") or {}).get("elements", [])}
    for element in data["elements"]:
        if item["state"] != "ok":
            element.update(state=item["state"], value=None, note=item["note"])
        prior = before.get(tuple(element["coordinates"]))
        element["changed"] = bool(prior and prior["state"] == element["state"] == "ok"
                                  and prior["value"] != element["value"])
        element["previousValue"] = prior["value"] if element["changed"] else None
    if item["state"] != "ok":
        data.update(state=item["state"], note=item["note"])
        if data["kind"] in ("vector", "string"):
            # 类对象未确认构造完成时，长度/容量也可能来自未初始化栈槽。
            data.update(shape=[], lowerBounds=[], total=0, offset=0, hidden=0, elements=[])
    # 整体值只作摘要，前端不需要解析任何 GDB 文本。
    item["value"] = (f"{data['kind']} · {data['total']} 个元素"
                     if item["state"] == "ok" and data["state"] == "ok" else None)


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)


class SourceFacts:
    def __init__(self, source):
        self.data = source.encode("utf-8")
        self.tree = Parser(Language(tree_sitter_cpp.language())).parse(self.data)
        self.declarations = {}
        self.actions = {}
        for node in walk(self.tree.root_node):
            if node.type == "declaration":
                for declarator in node.children_by_field_name("declarator"):
                    base = declarator.child_by_field_name("declarator") if declarator.type == "init_declarator" else declarator
                    while base is not None and base.type != "identifier":
                        base = base.child_by_field_name("declarator")
                    if base is None:
                        continue
                    value = declarator.child_by_field_name("value")
                    name = self.text(base)
                    line = node.start_point.row + 1
                    self.declarations[(line, name)] = {"initialized": value is not None,
                                                       "node": node, "value": value}
                    self.add_action(node, name, value, "declare")
            elif node.type == "assignment_expression":
                left = node.child_by_field_name("left")
                if left and left.type == "identifier":
                    operator = node.child_by_field_name("operator")
                    self.add_action(node, self.text(left), node.child_by_field_name("right"),
                                    "assign" if operator and self.text(operator) == "=" else "update")
            elif node.type == "update_expression":
                argument = node.child_by_field_name("argument")
                if argument and argument.type == "identifier":
                    self.add_action(node, self.text(argument), argument, "update")
            elif node.type == "expression_statement" and node.named_child_count == 1:
                expression = node.named_children[0]
                targets = []
                while expression.type == "binary_expression":
                    operator = expression.child_by_field_name("operator")
                    right = expression.child_by_field_name("right")
                    if not operator or self.text(operator) != ">>" or right.type != "identifier":
                        break
                    targets.append(self.text(right))
                    expression = expression.child_by_field_name("left")
                stream = self.text(expression).replace(" ", "")
                if stream in ("cin", "std::cin", "::std::cin"):
                    for name in reversed(targets):
                        self.add_action(node, name, None, "input", stream)

    def text(self, node):
        return self.data[node.start_byte:node.end_byte].decode("utf-8")

    def add_action(self, node, name, value, kind, stream=None):
        # 多行、多语句、条件表达式、宏展开不作已初始化证明。
        line = node.start_point.row + 1
        ancestor = node.parent
        while ancestor is not None:
            if (ancestor.type in ("if_statement", "while_statement", "do_statement", "switch_statement",
                                  "conditional_expression") and ancestor.start_point.row + 1 == line):
                return
            ancestor = ancestor.parent
        parent = node
        while parent.parent and parent.parent.type not in ("compound_statement", "for_statement", "translation_unit"):
            parent = parent.parent
        if (parent.type not in ("declaration", "expression_statement", "update_expression")
                or parent.start_point.row != parent.end_point.row or node.has_error):
            return
        self.actions.setdefault(line, []).append({"name": name, "value": value,
                                                  "kind": kind, "statement": parent, "stream": stream})

    def safe_value(self, node, known, containers):
        if node is None:
            return False
        if node.type in ("number_literal", "char_literal", "string_literal", "true", "false", "null"):
            return True
        if node.type == "identifier":
            return known.get(self.text(node), False)
        if node.type == "call_expression":
            function = node.child_by_field_name("function")
            arguments = node.child_by_field_name("arguments")
            if (function is None or function.type != "field_expression"
                    or arguments is None or arguments.named_child_count):
                return False
            receiver = function.child_by_field_name("argument")
            operator = function.child_by_field_name("operator")
            field = function.child_by_field_name("field")
            if (receiver is None or receiver.type != "identifier" or operator is None
                    or self.text(operator) != "." or field is None):
                return False
            name = self.text(receiver)
            # 只认可 GDB 已识别且构造完成的标准容器，不按方法名猜用户函数。
            methods = {"string": ("size", "length"), "vector": ("size",)}
            return bool(known.get(name) and self.text(field) in methods.get(containers.get(name), ()))
        if node.type == "subscript_expression":
            return all(self.safe_value(child, known, containers) for child in node.named_children)
        if node.type == "subscript_argument_list":
            # tree-sitter-cpp 将 a[i] 的下标包装为独立节点；仍逐项验证下标来源。
            return node.named_child_count == 1 and self.safe_value(node.named_children[0], known, containers)
        if node.type == "unary_expression":
            operator = node.child_by_field_name("operator")
            if operator is None or self.text(operator) not in ("+", "-", "!", "~"):
                return False
        if node.type in ("binary_expression", "unary_expression", "parenthesized_expression",
                         "initializer_list", "cast_expression"):
            return all(self.safe_value(child, known, containers) for child in node.named_children
                       if child.type not in ("type_descriptor", "primitive_type"))
        # 其他函数返回值、指针解引用不推测初始化。
        return False


class SnapshotBuilder:
    def __init__(self, source):
        self.facts = SourceFacts(source)
        self.previous = None
        self.history = []
        self.known = {}
        self.alive = {}
        self.serial = 0

    def build(self, raw, run_id, output, delta, status="paused", motion=None, reason=None):
        previous = self.previous
        frames = raw.get("frames", [])
        frame_keys = {frame["key"] for frame in frames}
        for key in frame_keys:
            if key not in self.alive:
                self.serial += 1
                self.alive[key] = self.serial
        self.alive = {key: value for key, value in self.alive.items() if key in frame_keys}
        for frame in frames:
            frame["id"] = f"{run_id}:f{self.alive[frame['key']]}"
        variables = []
        for item in raw.get("variables", []):
            item = dict(item)
            owner = "global" if item["kind"] == "global" else f"f{self.alive[item['frameKey']]}"
            item["id"] = f"{run_id}:{owner}:{item['scope']}:{item['declaration']}:{item['name']}"
            variables.append(item)
        previous_vars = {item["id"]: item for item in (previous or {}).get("variables", [])}
        # 只有下一步确实离开单条语句，并仍在同一调用帧时，才承认其赋值已完成。
        if previous and previous["status"] == "paused" and frames:
            old_frame = previous["frames"][0]
            current = next((frame for frame in frames if frame["id"] == old_frame["id"]), None)
            if motion in ("next", "step") and current and frames[0]["id"] == old_frame["id"]:
                old_line = old_frame["line"]
                new_line = current["line"]
                actions = self.facts.actions.get(old_line, [])
                # 多条语句同一行不能以源码行推断完成顺序。
                statements = {(action["statement"].start_byte, action["statement"].end_byte) for action in actions}
                for_header = bool(actions and all(action["statement"].parent.type == "for_statement" for action in actions))
                if new_line and old_line and new_line > old_line and (len(statements) == 1 or for_header):
                    known = {item["name"]: item["state"] == "ok"
                             for item in reversed(previous["variables"]) if item.get("visible")}
                    containers = {item["name"]: (item.get("data") or {}).get("kind")
                                  for item in reversed(previous["variables"]) if item.get("visible")
                                  and (item.get("data") or {}).get("state") == "ok"}
                    for action in actions:
                        candidates = [item for item in variables if item["name"] == action["name"]
                                      and item["frameKey"] == old_frame["key"]]
                        if action["kind"] == "declare":
                            candidates = [item for item in candidates if item["declaration"] == old_line]
                        candidates.sort(key=lambda item: item["depth"])
                        if candidates:
                            item = candidates[0]
                            if action["kind"] == "input":
                                # 整条标准输入链成功才确认新值；失败链不能证明后续目标已写入。
                                shadowed = action["stream"] == "cin" and any(
                                    variable["name"] == "cin" and variable.get("visible")
                                    for variable in previous["variables"])
                                scalar = bool(re.fullmatch(
                                    r"(?:(?:signed|unsigned) )?(?:bool|char|short(?: int)?|int|long(?: long)?(?: int)?|float|double|long double)",
                                    item["type"]))
                                if raw.get("inputSucceeded") and not shadowed and (scalar or (item.get("data") or {}).get("kind") == "string"):
                                    self.known[item["id"]] = "ok"
                                continue
                            elif action["kind"] == "declare" and (item.get("data") or {}).get("kind") in ("vector", "string"):
                                # 已观察到类对象构造完成；元素由容器自身的有效长度界定。
                                self.known[item["id"]] = "ok"
                            elif action["value"] is None and action["kind"] == "declare":
                                self.known[item["id"]] = "uninitialized"
                            else:
                                safe = self.facts.safe_value(action["value"], known, containers)
                                if action["kind"] == "update":
                                    safe = safe and known.get(action["name"], False)
                                self.known[item["id"]] = "ok" if safe else "unavailable"
                            known[action["name"]] = self.known[item["id"]] == "ok"
                # GCC 常把 int x; 直接跳过。只跨过同一块内无初始化的声明时，
                # 依据语法树确认声明已到达；不把分支/循环跳行当成顺序执行。
                if new_line and old_line and new_line > old_line:
                    for (decl_line, name), facts in self.facts.declarations.items():
                        node = facts["node"]
                        if not (old_line < decl_line < new_line) or facts["initialized"]:
                            continue
                        siblings = node.parent.named_children
                        before = [sibling for sibling in siblings if sibling.end_point.row + 1 <= old_line]
                        if not before or before[-1].end_point.row + 1 != old_line:
                            continue
                        between = [sibling for sibling in siblings
                                   if old_line < sibling.start_point.row + 1 < new_line and sibling.type != "comment"]
                        if any(sibling.type != "declaration" or any(
                                child.type == "init_declarator" for child in sibling.named_children) for sibling in between):
                            continue
                        for item in variables:
                            if item["frameKey"] == old_frame["key"] and item["declaration"] == decl_line and item["name"] == name:
                                self.known[item["id"]] = "uninitialized"
        # 连续运行可能经过重入作用域与未观察到的声明，清除局部初始化证明。
        if motion in ("continue", "finish"):
            self.known = {}
        visible = set()
        frame_map = {frame["key"]: frame for frame in frames}
        for item in variables:
            identity = item["id"]
            global_scope = item["kind"] == "global"
            frame = frame_map.get(item["frameKey"])
            line = frame["line"] if frame else None
            facts = self.facts.declarations.get((item["declaration"], item["name"]))
            item["state"] = "unavailable"
            item["note"] = "状态未确认：未观察到可证明的初始化"
            if item["readError"]:
                item["note"] = "读取失败：" + item["readError"]
            elif global_scope or item["kind"] == "argument":
                item["state"], item["note"] = "ok", None
            elif item.get("staticStorage") and line and line > item["declaration"]:
                item["state"], item["note"] = "ok", None
            elif identity in self.known:
                item["state"] = self.known[identity]
                item["note"] = {"ok": None, "uninitialized": "已执行声明，尚未初始化",
                                "unavailable": "状态未确认：初始化来源无法证明"}[item["state"]]
            elif line and line <= item["declaration"]:
                item["state"], item["note"] = "out_of_scope", "尚未执行声明"
            elif facts and not facts["initialized"]:
                # 未观察赋值时不能把‘未初始化’当成确定结论。
                item["note"] = "状态未确认：尚未观察到初始化或赋值"
            scope_key = (item["frameKey"], item["name"])
            item["shadowed"] = scope_key in visible
            item["visible"] = (global_scope or item["frame"] == 0) and not item["shadowed"] and item["state"] != "out_of_scope"
            if item["state"] != "out_of_scope":
                visible.add(scope_key)
            item["value"] = item["rawValue"] if item["state"] == "ok" else None
            old = previous_vars.get(identity)
            normalize_data(item, old)
            item["format"] = {"kind": "structured" if item.get("data") else "gdb-raw", "maxElements": 200}
            item["changed"] = bool(old and old["state"] == item["state"] == "ok" and (
                old["value"] != item["value"] or any(element["changed"] for element in (item.get("data") or {}).get("elements", []))))
            item["previousValue"] = old["value"] if item["changed"] else None
            item["stateChanged"] = bool(old and old["state"] != item["state"])
            for key in ("rawValue", "readError", "rawId"):
                item.pop(key, None)
        live_ids = {item["id"] for item in variables}
        self.known = {key: value for key, value in self.known.items() if key in live_ids}
        for identity, old in previous_vars.items():
            if identity not in live_ids and old["state"] != "out_of_scope":
                item = dict(old)
                item.update(state="out_of_scope", value=None, visible=False, changed=False,
                            previousValue=None, stateChanged=True, note="已退出作用域或调用帧")
                item.pop("data", None)
                variables.append(item)
        snapshot = {"runId": run_id, "step": len(self.history),
                    "line": frames[0]["line"] if frames and status == "paused" else None,
                    "frames": frames, "variables": variables, "output": output,
                    "outputDelta": delta, "status": status, "reason": reason}
        snapshot["arrayAccess"] = collect_access(self.facts, previous, frames, motion, status)
        self.previous = deepcopy(snapshot)
        self.history.append(deepcopy(snapshot))
        return snapshot
