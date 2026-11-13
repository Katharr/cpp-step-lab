"""初始化证据规则、可靠表达式来源与变量值状态判定。"""
import re


# 初始化证据规则集中维护：参数个数限定到不接收用户谓词/输出指针的重载。
# 这里只证明返回值来源，实际数值始终读取 GCC/GDB，不在 Python 重算库函数。
VALUE_CALLS = {}


def value_calls(names, *arities):
    for name in names.split():
        VALUE_CALLS[name] = frozenset(arities)


value_calls("abs labs llabs imaxabs", 1)
value_calls("sqrt cbrt fabs ceil floor trunc round lround llround nearbyint rint lrint llrint "
            "exp exp2 expm1 log log2 log10 log1p sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh "
            "erf erfc tgamma lgamma isfinite isinf isnan isnormal signbit ilogb logb", 1)
value_calls("pow hypot atan2 fmod remainder copysign fdim fmax fmin nextafter ldexp scalbn scalbln", 2)
value_calls("fma", 3)
# C 数学函数的 float/long double 版本。
for _name, _arities in list(VALUE_CALLS.items()):
    if _name not in ("abs", "labs", "llabs", "imaxabs", "isfinite", "isinf", "isnan", "isnormal", "signbit"):
        for _suffix in ("f", "l"):
            VALUE_CALLS[_name + _suffix] = _arities
value_calls("min max minmax", 1, 2)
value_calls("__gcd", 2)  # GCC C++11/14 的常用扩展；std::gcd/lcm 属于 C++17。
value_calls("strlen atoi atol atoll atof", 1)
value_calls("strcmp strspn strcspn", 2)
value_calls("strncmp memcmp", 3)
value_calls("stoi stol stoll stoul stoull stof stod stold", 1)
value_calls("to_string", 1)
value_calls("make_pair", 2)
value_calls("isalnum isalpha isblank iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper", 1)
value_calls("begin end cbegin cend rbegin rend crbegin crend", 1)
value_calls("distance min_element max_element minmax_element", 2)
value_calls("lower_bound upper_bound binary_search count find equal mismatch", 3)
value_calls("lexicographical_compare", 4)
value_calls("accumulate", 3)
value_calls("inner_product", 4)
value_calls("getchar rand", 0)
value_calls("putchar puts", 1)
for _name in ("popcount", "parity", "clz", "ctz", "ffs", "clrsb"):
    value_calls(" ".join("__builtin_" + _name + suffix for suffix in ("", "l", "ll")), 1)

CONTAINER_QUERIES = {
    "vector": {**dict.fromkeys(("size", "empty", "capacity", "max_size", "front", "back", "data",
                                "begin", "end", "cbegin", "cend", "rbegin", "rend", "crbegin", "crend"), (0,)),
               "at": (1,)},
    "string": {**dict.fromkeys(("size", "length", "empty", "capacity", "max_size", "front", "back", "data", "c_str",
                                "begin", "end", "cbegin", "cend", "rbegin", "rend", "crbegin", "crend"), (0,)),
               "at": (1,), "substr": (0, 1, 2), "compare": (1, 3),
               **dict.fromkeys(("find", "rfind", "find_first_of", "find_last_of", "find_first_not_of", "find_last_not_of"), (1, 2, 3))},
}
for _kind in ("deque", "list", "forward_list", "array", "queue", "stack", "priority_queue",
              "set", "multiset", "map", "multimap", "unordered_set", "unordered_multiset", "unordered_map", "unordered_multimap", "bitset", "pair"):
    CONTAINER_QUERIES[_kind] = {}
for _kind in ("deque", "list", "array"):
    CONTAINER_QUERIES[_kind] = dict(CONTAINER_QUERIES["vector"])
    CONTAINER_QUERIES[_kind].pop("capacity", None)
    if _kind == "list":
        for _method in ("at", "data"):
            CONTAINER_QUERIES[_kind].pop(_method, None)
    if _kind == "deque":
        CONTAINER_QUERIES[_kind].pop("data", None)
for _kind in ("queue", "stack", "priority_queue"):
    CONTAINER_QUERIES[_kind] = {**dict.fromkeys(("size", "empty"), (0,)),
                               **dict.fromkeys(("front", "back") if _kind == "queue" else ("top",), (0,))}
for _kind in ("set", "multiset", "map", "multimap", "unordered_set", "unordered_multiset", "unordered_map", "unordered_multimap"):
    CONTAINER_QUERIES[_kind] = {
        **dict.fromkeys(("size", "empty", "max_size", "begin", "end", "cbegin", "cend"), (0,)),
        **dict.fromkeys(("count", "find", "equal_range"), (1,))}
    if not _kind.startswith("unordered_"):
        CONTAINER_QUERIES[_kind].update(dict.fromkeys(("lower_bound", "upper_bound"), (1,)))
    if _kind in ("map", "unordered_map"):
        CONTAINER_QUERIES[_kind]["at"] = (1,)
CONTAINER_QUERIES["forward_list"] = dict.fromkeys(("empty", "front", "max_size", "begin", "end", "cbegin", "cend"), (0,))
CONTAINER_QUERIES["bitset"] = {**dict.fromkeys(("size", "count", "any", "none", "all", "to_ulong", "to_ullong", "to_string"), (0,)), "test": (1,)}


def container_kind(item):
    """仅按 GDB 的真实标准类型识别方法，不将用户类的同名方法当成库函数。"""
    data_kind = (item.get("data") or {}).get("kind")
    if data_kind in CONTAINER_QUERIES:
        return data_kind
    name = item.get("canonicalType", item.get("type", ""))
    match = re.match(r"^(?:const )?std::(?:(?:__cxx11|__debug)::)?(\w+)\s*<", name)
    kind = match[1] if match else None
    return "string" if kind == "basic_string" else kind if kind in CONTAINER_QUERIES else None




def _walk(node):
    yield node
    for child in node.named_children:
        yield from _walk(child)


def safe_value(facts, node, known, containers):
    if node is None:
        return False
    if node.type in ("number_literal", "char_literal", "string_literal", "true", "false", "null"):
        return True
    if node.type == "identifier":
        return known.get(facts.text(node), False)
    if node.type == "call_expression":
        function = node.child_by_field_name("function")
        arguments = node.child_by_field_name("arguments")
        name = re.sub(r"\s+", "", facts.text(function)) if function else ""
        if re.fullmatch(r"(?:::)?std::numeric_limits<(?:bool|char|signedchar|unsignedchar|short|unsignedshort|int|unsignedint|long|unsignedlong|longlong|unsignedlonglong|float|double|longdouble)>::(?:min|max|lowest|epsilon|round_error|infinity|quiet_NaN|signaling_NaN|denorm_min)", name):
            return arguments is not None and arguments.named_child_count == 0
        templates = [child for child in _walk(function) if child.type == "template_function"] if function else []
        if templates:
            template = templates[-1]
            types = template.child_by_field_name("arguments")
            if types is None or not types.named_children or any(
                    not re.fullmatch(r"(?:(?:signed|unsigned)\s+)?(?:bool|char|short|int|long(?:\s+long)?|float|double|long\s+double)", facts.text(child))
                    for child in types.named_children):
                return False
            name = name.replace(re.sub(r"\s+", "", facts.text(template)), facts.text(template.child_by_field_name("name")))
        if ((function and function.type == "primitive_type") or name == "static_cast"):
            return bool(arguments is not None and arguments.named_child_count == 1
                        and facts.safe_value(arguments.named_children[0], known, containers))
        short_name = name.removeprefix("::").removeprefix("std::")
        if short_name in VALUE_CALLS and name in (short_name, "::" + short_name, "std::" + short_name, "::std::" + short_name):
            # 不把同名函数、宏、局部可调用对象当作标准库；拒绝用户谓词重载。
            shadowed = (name in (short_name, "::" + short_name) and short_name in known) or any(
                re.sub(r"\s+", "", candidate).removeprefix("::").removeprefix("std::") == short_name
                for candidate in facts.custom_callables)
            return bool(not shadowed and arguments is not None and arguments.named_child_count in VALUE_CALLS[short_name]
                        and all(facts.safe_value(child, known, containers) for child in arguments.named_children))
        if (function is None or function.type != "field_expression"
                or arguments is None):
            return False
        receiver = function.child_by_field_name("argument")
        operator = function.child_by_field_name("operator")
        field = function.child_by_field_name("field")
        if (receiver is None or receiver.type != "identifier" or operator is None
                or facts.text(operator) != "." or field is None):
            return False
        name = facts.text(receiver)
        # 只认可 GDB 已识别且构造完成的标准容器，不按方法名猜用户函数。
        arities = CONTAINER_QUERIES.get(containers.get(name), {}).get(facts.text(field), ())
        return bool(known.get(name) and arguments.named_child_count in arities
                    and all(facts.safe_value(child, known, containers) for child in arguments.named_children))
    if node.type == "sizeof_expression":
        return True  # C++11/14 的 sizeof 不执行操作数。
    if node.type == "field_expression":
        receiver = node.child_by_field_name("argument")
        field = node.child_by_field_name("field")
        operator = node.child_by_field_name("operator")
        return bool(receiver and receiver.type == "identifier" and field and operator
                    and facts.text(operator) == "." and facts.text(field) in ("first", "second")
                    and known.get(facts.text(receiver)) and containers.get(facts.text(receiver)) == "pair")
    if node.type == "subscript_expression":
        return all(facts.safe_value(child, known, containers) for child in node.named_children)
    if node.type == "subscript_argument_list":
        # tree-sitter-cpp 将 a[i] 的下标包装为独立节点；仍逐项验证下标来源。
        return node.named_child_count == 1 and facts.safe_value(node.named_children[0], known, containers)
    if node.type == "unary_expression":
        operator = node.child_by_field_name("operator")
        if operator is None or facts.text(operator) not in ("+", "-", "!", "~"):
            return False
    if node.type in ("binary_expression", "unary_expression", "parenthesized_expression",
                     "initializer_list", "cast_expression"):
        return all(facts.safe_value(child, known, containers) for child in node.named_children
                   if child.type not in ("type_descriptor", "primitive_type"))
    # 其他函数返回值、指针解引用不推测初始化。
    return False


class InitializationTracker:
    """仅积累实际观察到的初始化证据，跨连续执行清除局部证明。"""

    def __init__(self):
        self.known = {}

    def observe(self, facts, previous, frames, variables, raw, motion, history):
        # 只有下一步确实离开单条语句，并仍在同一调用帧时，才承认其赋值已完成。
        if previous and previous["status"] == "paused" and frames:
            evidence = previous
            # “进入函数”可能经过若干库函数帧；返回调用者后用进入前的快照证明实参来源。
            if (motion in ("next", "step") and previous["frames"][0]["id"] != frames[0]["id"]
                    and any(frame["id"] == frames[0]["id"] for frame in previous["frames"][1:])):
                evidence = next((step for step in reversed(history)
                                 if step["frames"] and step["frames"][0]["id"] == frames[0]["id"]), previous)
            old_frame = evidence["frames"][0]
            current = next((frame for frame in frames if frame["id"] == old_frame["id"]), None)
            if motion in ("next", "step") and current and frames[0]["id"] == old_frame["id"]:
                old_line = old_frame["line"]
                new_line = current["line"]
                actions = facts.actions.get(old_line, [])
                # 多条语句同一行不能以源码行推断完成顺序。
                statements = {(action["statement"].start_byte, action["statement"].end_byte) for action in actions}
                for_header = bool(actions and all(action["statement"].parent.type == "for_statement" for action in actions))
                if new_line and old_line and new_line > old_line and (len(statements) == 1 or for_header):
                    known = {item["name"]: item["state"] == "ok"
                             for item in reversed(evidence["variables"]) if item.get("visible")}
                    containers = {item["name"]: container_kind(item)
                                  for item in reversed(evidence["variables"]) if item.get("visible")
                                  and item["state"] == "ok"}
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
                                    for variable in evidence["variables"])
                                scalar = bool(re.fullmatch(
                                    r"(?:(?:signed|unsigned) )?(?:bool|char|short(?: int)?|int|long(?: long)?(?: int)?|float|double|long double)",
                                    item["type"]))
                                if raw.get("inputSucceeded") and not shadowed and (scalar or (item.get("data") or {}).get("kind") == "string"):
                                    self.known[item["id"]] = "ok"
                                continue
                            elif (action["kind"] == "declare" and container_kind(item)
                                  and container_kind(item) != "array"):
                                # 已观察到类对象构造完成；元素由容器自身的有效长度界定。
                                self.known[item["id"]] = "ok"
                            elif action["value"] is None and action["kind"] == "declare":
                                self.known[item["id"]] = "uninitialized"
                            else:
                                safe = facts.safe_value(action["value"], known, containers)
                                if action["kind"] == "update":
                                    safe = safe and known.get(action["name"], False)
                                self.known[item["id"]] = "ok" if safe else "unavailable"
                            known[action["name"]] = self.known[item["id"]] == "ok"
                # GCC 常把 int x; 直接跳过。只跨过同一块内无初始化的声明时，
                # 依据语法树确认声明已到达；不把分支/循环跳行当成顺序执行。
                if new_line and old_line and new_line > old_line:
                    for (decl_line, name), declaration in facts.declarations.items():
                        node = declaration["node"]
                        if not (old_line < decl_line < new_line) or declaration["initialized"]:
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

    def retain(self, live_ids):
        self.known = {key: value for key, value in self.known.items() if key in live_ids}



def apply_value_state(item, known, line, facts):
    identity = item["id"]
    global_scope = item["kind"] == "global"
    item["state"] = "unavailable"
    item["note"] = "状态未确认：未观察到可证明的初始化"
    if item["readError"]:
        item["note"] = "读取失败：" + item["readError"]
    elif identity in known:
        item["state"] = known[identity]
        item["note"] = {"ok": None, "uninitialized": "已执行声明，尚未初始化",
                        "unavailable": "状态未确认：初始化来源无法证明"}[item["state"]]
    elif global_scope or item["kind"] == "argument":
        item["state"], item["note"] = "ok", None
    elif item.get("staticStorage") and line and line > item["declaration"]:
        item["state"], item["note"] = "ok", None
    elif line and line <= item["declaration"]:
        item["state"], item["note"] = "out_of_scope", "尚未执行声明"
    elif facts and not facts["initialized"]:
        # 未观察赋值时不能把‘未初始化’当成确定结论。
        item["note"] = "状态未确认：尚未观察到初始化或赋值"
