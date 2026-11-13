"""以实际到达的检查点统一执行完成、初始化证明与访问归因。"""
from copy import deepcopy
import re

from code_lab.snapshots.initialization import apply_value_state, container_kind, safe_value
from code_lab.snapshots.source_facts import walk
from code_lab.snapshots.access_trace import collect_access


class ExecutionEvidence:
    def __init__(self, plan, builder, run_id):
        self.plan, self.builder, self.run_id = plan, builder, run_id
        self.pending = {}
        self.seen_frames = set()
        self.storage = {}
        self.element_defaults = {}
        self.access = {"line": None, "reads": [], "writes": []}
        self.spans = []
        self.last_raw = None

    def begin_step(self):
        frames = (self.last_raw or {}).get("frames", [])
        self.origin = deepcopy(frames[0]) if frames else None
        self.access = {"line": None, "reads": [], "writes": []}
        self.spans = []

    def _view(self, raw):
        frames = raw["frames"]
        items = self.builder.identities.annotate(frames, raw["variables"], self.run_id)
        frame_map = {frame["key"]: frame for frame in frames}
        visible = set()
        for item in items:
            if item.get("data"):
                item["data"] = deepcopy(item["data"])
            address = item.get("storageAddress")
            if (not item.get("data") and address in self.storage
                    and (item["id"] in self.builder.initialization.known or item["kind"] == "argument")):
                self.builder.initialization.known[item["id"]] = self.storage[address]
            frame = frame_map.get(item["frameKey"])
            apply_value_state(item, self.builder.initialization.known, frame["line"] if frame else None,
                              self.plan.facts.declarations.get((item["declaration"], item["name"])))
            key = (item["frameKey"], item["name"])
            item["shadowed"] = key in visible
            item["visible"] = (item["frame"] == 0 or item["kind"] == "global") and not item["shadowed"] and item["state"] != "out_of_scope"
            if item["state"] != "out_of_scope":
                visible.add(key)
            item["value"] = item["rawValue"] if item["state"] == "ok" else None
            if item.get("data") and item["state"] == "ok":
                default = self.element_defaults.get(item["rawId"], "ok")
                for element in item["data"]["elements"]:
                    state = self.storage.get(element.get("storageAddress"), default)
                    if state != "ok":
                        element.update(state=state, value=None, note="尚未确认此元素的初始化")
        return {"status": "paused", "line": frames[0]["line"], "frames": deepcopy(frames), "variables": items}

    def _known(self, view):
        items = [item for item in reversed(view["variables"]) if item.get("visible")]
        return ({item["name"]: item["state"] == "ok" for item in items},
                {item["name"]: container_kind(item) for item in items if item["state"] == "ok"})

    def _safe(self, node, before, calls):
        known, containers = self._known(before)
        evidence = self

        class Sources:
            custom_callables = evidence.plan.facts.custom_callables

            def text(self, value):
                return evidence.plan.facts.text(value)

            def safe_value(self, value, known_values, kinds):
                if value is not None and value.type == "subscript_expression":
                    cell = evidence._cell(value, before)
                    if cell:
                        item, _, address = cell
                        return evidence.storage.get(address, evidence.element_defaults.get(item["rawId"], "ok" if item["kind"] == "global" else "unavailable")) == "ok"
                    return False
                if value is not None and value.type == "call_expression" and value.start_byte in calls:
                    return calls[value.start_byte]
                if value is not None and value.type == "assignment_expression":
                    operator = self.text(value.child_by_field_name("operator"))
                    return (self.safe_value(value.child_by_field_name("right"), known_values, kinds)
                            and (operator == "=" or self.safe_value(value.child_by_field_name("left"), known_values, kinds)))
                if value is not None and value.type == "update_expression":
                    return self.safe_value(value.child_by_field_name("argument"), known_values, kinds)
                if value is not None and value.type == "conditional_expression":
                    return all(self.safe_value(child, known_values, kinds) for child in value.named_children)
                return safe_value(self, value, known_values, kinds)

        return Sources().safe_value(node, known, containers)

    def _set(self, item, state):
        data = item.get("data")
        if data:
            self.element_defaults[item["rawId"]] = state
        self.builder.initialization.known[item["id"]] = "ok" if data and state == "uninitialized" else state
        if item.get("storageAddress"):
            self.storage[item["storageAddress"]] = state

    def _cell(self, node, before):
        """只解析已确认的纯整数下标；不向 inferior 额外求值。"""
        values = {item["name"]: item for item in reversed(before["variables"]) if item.get("visible")}

        def integer(value):
            if value.type in ("parenthesized_expression", "subscript_argument_list"):
                return integer(value.named_children[0])
            text = self.plan.facts.text(value)
            if value.type == "number_literal":
                return int(re.sub(r"[uUlL]+$", "", text), 0 if text.startswith(("0x", "0X")) else 10)
            if value.type == "identifier" and values.get(text, {}).get("state") == "ok":
                return int(values[text]["value"])
            if value.type == "binary_expression":
                left = integer(value.child_by_field_name("left"))
                right = integer(value.child_by_field_name("right"))
                operator = self.plan.facts.text(value.child_by_field_name("operator"))
                if operator == "+":
                    return left + right
                if operator == "-":
                    return left - right
                if operator == "*":
                    return left * right
            raise ValueError()

        coordinates = []
        try:
            while node.type == "subscript_expression":
                coordinates.insert(0, integer(node.child_by_field_name("indices")))
                node = node.child_by_field_name("argument")
            item = values.get(self.plan.facts.text(node)) if node.type == "identifier" else None
            data = (item or {}).get("data") or {}
            if item is None or item["state"] != "ok" or len(coordinates) != len(data.get("shape", [])):
                return None
            index = 0
            for coordinate, size, lower in zip(coordinates, data["shape"], data["lowerBounds"]):
                if not lower <= coordinate < lower + size:
                    return None
                index = index * size + coordinate - lower
            address = str(int(data["storageBase"]) + index * data["elementSize"])
            return item, coordinates, address
        except (ValueError, TypeError, KeyError, AttributeError):
            return None

    def _merge_access(self, access):
        for kind in ("reads", "writes", "uses"):
            for entry in access.get(kind, []):
                if entry not in self.access.setdefault(kind, []):
                    self.access[kind].append(entry)
                    self.access["line"] = access["line"]
        if not self.access.get("uses"):
            self.access.pop("uses", None)

    def _enter(self, view):
        self.seen_frames.intersection_update(frame["key"] for frame in view["frames"])
        frame = view["frames"][0]
        if frame["key"] in self.seen_frames:
            return
        self.seen_frames.add(frame["key"])
        caller = view["frames"][1]["key"] if len(view["frames"]) > 1 else None
        pending = next((value for (owner, _), value in reversed(list(self.pending.items())) if owner == caller), None)
        arguments = []
        if pending:
            matching = [node for node in walk(pending["node"]) if node.type == "call_expression"
                        and self.plan.facts.text(node.child_by_field_name("function")).split("::")[-1] == frame["function"].split("(")[0].split("::")[-1]]
            if len(matching) == 1:
                pending["callNode"] = matching[0]
                arguments = matching[0].child_by_field_name("arguments").named_children
            self._merge_access(collect_access(self.plan.facts, pending["before"], view["frames"], "step", "paused", pending["node"]))
        parameters = [item for item in view["variables"] if item["frame"] == 0 and item["kind"] == "argument"]
        for index, item in enumerate(parameters):
            if "&" in item["type"]:
                state = self.storage.get(item.get("storageAddress"), "unavailable")
                if state == "unavailable":
                    for candidate in view["variables"]:
                        data = candidate.get("data") or {}
                        if data.get("storageBase") and data.get("elementSize") and item.get("storageAddress"):
                            offset = int(item["storageAddress"]) - int(data["storageBase"])
                            if 0 <= offset < data["total"] * data["elementSize"] and offset % data["elementSize"] == 0:
                                state = self.element_defaults.get(candidate["rawId"], "ok" if candidate["kind"] == "global" else "unavailable")
                                break
            else:
                state = "ok" if pending and index < len(arguments) and self._safe(arguments[index], pending["before"], pending["calls"]) else "unavailable"
            self._set(item, state)

    def observe(self, raw):
        checkpoint = raw["checkpoint"]
        site_id, phase = checkpoint["site"], checkpoint["phase"]
        site = self.plan.sites[site_id]
        if not raw["frames"]:
            return
        raw["frames"][0]["line"] = site["line"]
        view = self._view(raw)
        frame = view["frames"][0]
        self._enter(view)
        if phase == 0 and site["node"].type == "declaration":
            names = set()
            for declarator in site["node"].children_by_field_name("declarator"):
                base = declarator.child_by_field_name("declarator") if declarator.type == "init_declarator" else declarator
                while base is not None and base.type != "identifier":
                    base = base.child_by_field_name("declarator")
                if base:
                    names.add(self.plan.facts.text(base))
            for item in view["variables"]:
                if item["name"] in names and item["frameKey"] == frame["key"] and item["declaration"] == site["line"] and not item.get("staticStorage"):
                    self.builder.initialization.known.pop(item["id"], None)
                    if "&" not in item["type"]:
                        self.storage.pop(item.get("storageAddress"), None)
                    data = item.get("data") or {}
                    if data.get("storageBase") and data.get("elementSize"):
                        low = int(data["storageBase"])
                        high = low + data["total"] * data["elementSize"]
                        self.storage = {address: state for address, state in self.storage.items() if address is None or not low <= int(address) < high}
        view = self._view(raw)
        key = (frame["key"], site_id)
        if phase == 0:
            self.pending[key] = {"node": site["node"], "before": deepcopy(view), "calls": {}}
        else:
            pending = self.pending.pop(key, None)
            # for 初始化的完成探针位于条件入口；后续条件重入不重复提交初始化。
            if pending:
                self._complete(site, pending, view, raw)
        raw["execution"] = {"spans": deepcopy(self.spans), "access": deepcopy(self.access)}
        self.last_raw = deepcopy(raw)

    def _complete(self, site, pending, view, raw):
        node, before = pending["node"], pending["before"]
        frame = view["frames"][0]
        self.spans.append({"line": site["line"], "endLine": site["end"], "frameId": frame["id"], "kind": site["kind"],
                           "completion": "return-value-ready" if node.type == "return_statement" else "completed"})
        if node.type == "return_statement":
            expression = next(iter(node.named_children), None)
            valid = self._safe(expression, before, pending["calls"])
            caller = view["frames"][1]["key"] if len(view["frames"]) > 1 else None
            for (owner, _), outer in reversed(list(self.pending.items())):
                if owner == caller and outer.get("callNode"):
                    outer["calls"][outer["callNode"].start_byte] = valid
                    break
        items = [item for item in view["variables"] if item["frameKey"] == frame["key"] or item["kind"] == "global"]

        def target(name, declaration=None):
            candidates = [item for item in items if item["name"] == name and (declaration is None or item["declaration"] == declaration)]
            return min(candidates, key=lambda item: (item["kind"] == "global", item["depth"])) if candidates else None

        if node.type == "declaration":
            for declarator in node.children_by_field_name("declarator"):
                base = declarator.child_by_field_name("declarator") if declarator.type == "init_declarator" else declarator
                while base is not None and base.type != "identifier":
                    base = base.child_by_field_name("declarator")
                item = target(self.plan.facts.text(base), node.start_point.row + 1) if base else None
                if item:
                    value = declarator.child_by_field_name("value")
                    state = ("ok" if (container_kind(item) not in (None, "array", "matrix") or
                                      self._safe(value, before, pending["calls"])) else "uninitialized" if value is None else "unavailable")
                    self._set(item, state)
                    # 同一声明的 declarator 按源码顺序完成，后面的初始化可以引用前面的值。
                    for prior in before["variables"]:
                        if prior["id"] == item["id"]:
                            prior.update(state=state, visible=True, value=item["rawValue"] if state == "ok" else None)
        else:
            def constant_truth(expression):
                """只求值不会产生副作用的明显常量，用来排除未执行分支。"""
                if expression is None:
                    return None
                text = self.plan.facts.text(expression).strip()
                if text in ("false", "0"):
                    return False
                if text in ("true", "1"):
                    return True
                if expression.type == "parenthesized_expression" and expression.named_children:
                    return constant_truth(expression.named_children[0])
                if expression.type == "identifier":
                    for item in reversed(before["variables"]):
                        if item.get("visible") and item["name"] == text and item.get("state") == "ok":
                            value = item.get("rawValue") or item.get("value")
                            if value in ("0", "false"):
                                return False
                            if value in ("1", "true"):
                                return True
                return None

            def definitely_unexecuted(action):
                parent = action.parent
                child = action
                while parent is not None:
                    if parent.type == "binary_expression":
                        operator = self.plan.facts.text(parent.child_by_field_name("operator"))
                        right = parent.child_by_field_name("right")
                        if child is right or (right and right.start_byte <= action.start_byte < right.end_byte):
                            truth = constant_truth(parent.child_by_field_name("left"))
                            if (operator == "&&" and truth is False) or (operator == "||" and truth is True):
                                return True
                    if parent.type == "conditional_expression":
                        truth = constant_truth(parent.child_by_field_name("condition"))
                        consequence = parent.child_by_field_name("consequence")
                        in_consequence = consequence and consequence.start_byte <= action.start_byte < consequence.end_byte
                        if truth is not None and ((truth and not in_consequence) or (not truth and in_consequence)):
                            return True
                    child, parent = parent, parent.parent
                return False

            for action in walk(node):
                if action.type not in ("assignment_expression", "update_expression"):
                    continue
                if definitely_unexecuted(action):
                    continue
                left = action.child_by_field_name("left" if action.type == "assignment_expression" else "argument")
                if left and left.type == "identifier":
                    item = target(self.plan.facts.text(left))
                    if item:
                        operator = action.child_by_field_name("operator")
                        update = action.type == "update_expression" or self.plan.facts.text(operator) != "="
                        value = left if action.type == "update_expression" else action.child_by_field_name("right")
                        valid = self._safe(value, before, pending["calls"])
                        if update:
                            valid = valid and self._known(before)[0].get(item["name"], False)
                        self._set(item, "ok" if valid else "unavailable")
                        if "&" in item["type"] and item.get("storageAddress"):
                            address = int(item["storageAddress"])
                            for candidate in view["variables"]:
                                data = candidate.get("data") or {}
                                if not data.get("storageBase") or not data.get("elementSize"):
                                    continue
                                offset = address - int(data["storageBase"])
                                if 0 <= offset < data["total"] * data["elementSize"] and offset % data["elementSize"] == 0:
                                    index = offset // data["elementSize"]
                                    coordinates = ([index // data["shape"][1] + data["lowerBounds"][0], index % data["shape"][1] + data["lowerBounds"][1]]
                                                   if len(data["shape"]) == 2 else [index + data["lowerBounds"][0]])
                                    self._merge_access({"line": site["line"], "writes": [{"variableId": candidate["id"], "coordinates": coordinates}]})
                elif left and left.type == "subscript_expression":
                    cell = self._cell(left, before)
                    if cell:
                        item, coordinates, address = cell
                        update = action.type == "update_expression" or self.plan.facts.text(action.child_by_field_name("operator")) != "="
                        valid = self._safe(left if action.type == "update_expression" else action.child_by_field_name("right"), before, pending["calls"])
                        if update:
                            valid = valid and self.storage.get(address, self.element_defaults.get(item["rawId"], "unavailable")) == "ok"
                        self.storage[address] = "ok" if valid else "unavailable"
        # 标准输入以本次真实流状态确认，不把失败链后续目标当作已赋值。
        if raw.get("inputSucceeded"):
            expression = node.named_children[0] if node.type == "expression_statement" and node.named_child_count == 1 else None
            targets = []
            while expression and expression.type == "binary_expression":
                operator = expression.child_by_field_name("operator")
                right = expression.child_by_field_name("right")
                if self.plan.facts.text(operator) != ">>" or right.type not in ("identifier", "subscript_expression"):
                    break
                targets.append(right)
                expression = expression.child_by_field_name("left")
            if expression and self.plan.facts.text(expression).replace(" ", "") in ("cin", "std::cin", "::std::cin"):
                for value in targets:
                    if value.type == "identifier":
                        item = target(self.plan.facts.text(value))
                        if item:
                            self._set(item, "ok")
                    else:
                        cell = self._cell(value, before)
                        if cell:
                            item, coordinates, address = cell
                            self.storage[address] = "ok"
                            self._merge_access({"line": site["line"], "writes": [{"variableId": item["id"], "coordinates": coordinates}]})
        self._merge_access(collect_access(self.plan.facts, before, view["frames"], "next", "paused", node))

    def decorate(self, raw, motion, status="paused"):
        raw = deepcopy(raw)
        if raw.get("frames"):
            raw["variables"] = self._view(raw)["variables"]
        raw["execution"] = {"spans": deepcopy(self.spans), "access": deepcopy(self.access),
                            "motion": motion, "evidence": "runtime-checkpoints",
                            "from": deepcopy(getattr(self, "origin", None)),
                            "to": deepcopy(raw["frames"][0]) if raw.get("frames") else None,
                            "stateOrigin": "current-stop" if status == "paused" else "fault-stop" if status == "runtime_error" else "last-observed"}
        return raw
