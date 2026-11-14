"""将真实调试状态组装为稳定快照并维护可靠差异基线。"""
from copy import deepcopy

from code_lab.config import WINDOW_MAX
from code_lab.snapshots.access_trace import collect_access
from code_lab.snapshots.identity import FrameIdentities
from code_lab.snapshots.initialization import InitializationTracker, apply_value_state
from code_lab.snapshots.source_facts import SourceFacts


def normalize_data(item, old):
    data = item.get("data")
    if not data:
        return
    item["dataKey"] = item["rawId"]
    old_data = (old or {}).get("data") or {}
    before = {tuple(element["coordinates"]): element
              for element in old_data.get("elements", [])}
    comparable_length = (old is not None and old["state"] == item["state"] == "ok"
                         and old_data.get("state") == data["state"] == "ok"
                         and data["kind"] in ("vector", "string")
                         and old_data.get("kind") == data["kind"])
    for element in data["elements"]:
        if item["state"] != "ok":
            element.update(state=item["state"], value=None, note=item["note"])
        prior = before.get(tuple(element["coordinates"]))
        # 旧窗口未读取不等于旧元素不存在；仅用已确认的旧长度判断新增。
        element["added"] = bool(comparable_length and element["state"] == "ok"
                                and old_data["total"] <= element["index"] < data["total"])
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


class SnapshotBuilder:
    def __init__(self, source):
        self.facts = SourceFacts(source)
        self.index_links = {}
        self.index_colors = {}
        self.previous = None
        self.history = []
        self.initialization = InitializationTracker()
        self.identities = FrameIdentities()

    def refresh(self, raw):
        """暂停观测只补充窗口，不重放执行归因或初始化规则。"""
        snapshot = deepcopy(self.history[-1])
        baseline = {item["id"]: item for item in self.history[-2]["variables"]} if len(self.history) > 1 else {}
        incoming = self.identities.annotate(raw["frames"], raw["variables"], snapshot["runId"])
        by_id = {item["id"]: item for item in incoming}
        observations = snapshot.setdefault("observations", {})
        for item in snapshot["variables"]:
            observed = by_id.get(item["id"])
            if observed and observed.get("data"):
                item["data"] = deepcopy(observed["data"])
                item["rawId"] = observed["rawId"]
                normalize_data(item, baseline.get(item["id"]))
                cache = observations.setdefault(item["id"], {})
                cache.update({','.join(map(str, element["coordinates"])): deepcopy(element)
                              for element in item["data"]["elements"]})
                item.pop("rawId", None)
        self.previous = deepcopy(snapshot)
        self.history[-1] = deepcopy(snapshot)
        return snapshot

    def build(self, raw, run_id, output, delta, status="paused", motion=None, reason=None):
        previous = self.previous
        frames = raw.get("frames", [])
        variables = self.identities.annotate(frames, raw.get("variables", []), run_id)
        previous_vars = {item["id"]: item for item in (previous or {}).get("variables", [])}
        if "execution" not in raw:
            self.initialization.observe(self.facts, previous, frames, variables, raw, motion, self.history)
        visible = set()
        frame_map = {frame["key"]: frame for frame in frames}
        for item in variables:
            identity = item["id"]
            global_scope = item["kind"] == "global"
            frame = frame_map.get(item["frameKey"])
            line = frame["line"] if frame else None
            facts = self.facts.declarations.get((item["declaration"], item["name"]))
            apply_value_state(item, self.initialization.known, line, facts)
            scope_key = (item["frameKey"], item["name"])
            item["shadowed"] = scope_key in visible
            item["visible"] = (global_scope or item["frame"] == 0) and not item["shadowed"] and item["state"] != "out_of_scope"
            if item["state"] != "out_of_scope":
                visible.add(scope_key)
            item["value"] = item["rawValue"] if item["state"] == "ok" else None
            old = previous_vars.get(identity)
            normalize_data(item, old)
            item["format"] = {"kind": "structured" if item.get("data") else "gdb-raw", "maxElements": WINDOW_MAX}
            item["changed"] = bool(old and old["state"] == item["state"] == "ok" and (
                old["value"] != item["value"] or any(element["changed"] for element in (item.get("data") or {}).get("elements", []))))
            item["previousValue"] = old["value"] if item["changed"] else None
            item["stateChanged"] = bool(old and old["state"] != item["state"])
            for key in ("rawValue", "readError", "rawId"):
                item.pop(key, None)
        live_ids = {item["id"] for item in variables}
        self.initialization.retain(live_ids)
        for identity, old in previous_vars.items():
            if identity not in live_ids and (old["state"] != "out_of_scope" or any(identity in links for links in self.index_links.values())):
                item = dict(old)
                item.update(state="out_of_scope", value=None, visible=False, changed=False,
                            previousValue=None, stateChanged=True, note="已退出作用域或调用帧")
                item.pop("data", None)
                variables.append(item)
        snapshot = {"runId": run_id, "step": len(self.history),
                    "line": frames[0]["line"] if frames and status == "paused" else None,
                    "frames": frames, "variables": variables, "output": output,
                    "outputDelta": delta, "status": status, "reason": reason}
        active_relationships = {frame["key"]: self.facts.index_relationships(frame.get("line"), raw.get("indexLocations", {}).get(frame["key"]))
                                if frame.get("line") and frame.get("user", True) else {} for frame in frames}
        self.index_links = {}
        for item in variables:
            if not item.get("data") and item["id"] not in self.index_colors:
                self.index_colors[item["id"]] = len(self.index_colors)
            if item["id"] in self.index_colors:
                item["indexColor"] = self.index_colors[item["id"]]
            if (item.get("data") or {}).get("kind") != "array":
                continue
            links = self.index_links.setdefault(item["id"], [])
            for candidate in variables:
                owner = candidate["frameKey"]
                if candidate["kind"] == "global":
                    owner = item["frameKey"] if item["kind"] != "global" else frames[0]["key"] if frames else None
                relationships = active_relationships.get(owner, {})
                related = relationships.get((item["declaration"], item["name"]), set())
                if ((candidate["declaration"], candidate["name"]) in related
                        and not candidate.get("data") and candidate["state"] != "out_of_scope"
                        and (candidate["kind"] == "global" or candidate["frameKey"] == item["frameKey"] or item["kind"] == "global" and candidate["frame"] == 0)
                        and candidate["id"] not in links):
                    links.append(candidate["id"])
        snapshot["indexAssociations"] = deepcopy(self.index_links)
        snapshot["indexPreviousValues"] = {identity: item["value"] for identity, item in previous_vars.items()}
        snapshot["observations"] = {item["id"]: {','.join(map(str, element["coordinates"])): deepcopy(element)
                                                for element in item["data"]["elements"]}
                                    for item in variables if item.get("data")}
        if "execution" in raw:
            snapshot["execution"] = deepcopy(raw["execution"])
            snapshot["arrayAccess"] = deepcopy(raw["execution"]["access"])
        else:
            snapshot["arrayAccess"] = collect_access(self.facts, previous, frames, motion, status)
        self.previous = deepcopy(snapshot)
        self.history.append(deepcopy(snapshot))
        return snapshot
