"""不可信数值屏蔽、初始化证据与语法事实的纯逻辑回归。"""
import unittest

from code_lab.snapshots.builder import SnapshotBuilder
from code_lab.snapshots.source_facts import SourceFacts


class ConservativeStateTests(unittest.TestCase):
    def test_common_functions_reject_unknown_inputs_callbacks_and_user_methods(self):
        for expression, known, kinds, prefix in (
                ("sqrt(a)", {"a": False}, {}, ""),
                ("abs(f())", {}, {}, ""),
                ("pow(a++, 2)", {"a": True}, {}, ""),
                ("sqrt(a)", {"a": True}, {}, "double sqrt(double);\n"),
                ("std::abs(a)", {"a": True}, {}, "#define abs(x) f(x)\n"),
                ("accumulate(a, a + 3, 0, f)", {"a": True, "f": True}, {}, ""),
                ("count_if(a, a + 3, f)", {"a": True, "f": True}, {}, ""),
                ("lower_bound(a, a + 3, 1, f)", {"a": True, "f": True}, {}, ""),
                ("a.top()", {"a": True}, {}, ""),
                ("a.at(i)", {"a": True, "i": False}, {"a": "vector"}, ""),
                ("a.size()", {"a": False}, {"a": "queue"}, ""),
                ("a.pop()", {"a": True}, {"a": "stack"}, ""),
                ("a.first", {"a": True}, {}, ""),
                ("other::sqrt(a)", {"a": True}, {}, "")):
            with self.subTest(expression=expression, prefix=prefix):
                facts = SourceFacts(prefix + f"int main() {{\n int r = {expression}; // r：返回值\n}}\n")
                value = next(fact["value"] for (_, name), fact in facts.declarations.items() if name == "r")
                self.assertFalse(facts.safe_value(value, known, kinds))

    def test_default_std_array_does_not_prove_element_initialization(self):
        session_source = "#include <array>\nint main() {\n std::array<int, 2> x; // x：尚未赋值的数组\n return 0;\n}\n"
        builder = SnapshotBuilder(session_source)
        raw = self.raw(3)
        raw["variables"][0].update(type="std::array<int, 2>", canonicalType="std::array<int, 2>", declaration=3)
        builder.build(raw, "run", {}, {})
        raw["frames"][0]["line"] = 4
        snapshot = builder.build(raw, "run", {}, {}, motion="next")
        self.assertEqual(snapshot["variables"][0]["state"], "uninitialized")
        self.assertIsNone(snapshot["variables"][0]["value"])

    def test_min_max_requires_known_arguments_and_standard_function(self):
        for expression, known, prefix, expected in (
                ("max(a, b)", {"a": True, "b": True}, "", True),
                ("std::max(a, b)", {"a": True, "b": True}, "", True),
                ("::std::min(a, max(b, 2))", {"a": True, "b": True}, "", True),
                ("max(a, b)", {"a": True, "b": False}, "", False),
                ("max(a, b)", {"a": True}, "", False),
                ("max(a++, b)", {"a": True, "b": True}, "", False),
                ("max(f(), b)", {"b": True}, "", False),
                ("max(a, b, f)", {"a": True, "b": True, "f": True}, "", False),
                ("max(a, b)", {"a": True, "b": True, "max": True}, "", False),
                ("::max(a, b)", {"a": True, "b": True, "max": True}, "", False),
                ("max(a, b)", {"a": True, "b": True}, "int max(int, int);\n", False),
                ("max(a, b)", {"a": True, "b": True}, "#define max(a,b) 0\n", False),
                ("other::max(a, b)", {"a": True, "b": True}, "", False)):
            with self.subTest(expression=expression, known=known, prefix=prefix):
                facts = SourceFacts(prefix + f"int main() {{\n int n = {expression}; // n：取值结果\n}}\n")
                value = next(fact["value"] for (_, name), fact in facts.declarations.items() if name == "n")
                self.assertEqual(facts.safe_value(value, known, {}), expected)

    def test_array_subscripts_require_confirmed_dependencies(self):
        for expression, known, expected in (
                ("a[1]", {"a": True}, True),
                ("a[i+m-1]-a[i-1]", {"a": True, "i": True, "m": True}, True),
                ("a[i]", {"a": True, "i": False}, False),
                ("a[1]", {"a": False}, False),
                ("a[f()]", {"a": True}, False),
                ("a[i++]", {"a": True, "i": True}, False)):
            with self.subTest(expression=expression, known=known):
                facts = SourceFacts(f"int main() {{\n int n = {expression}; // n：数组读取结果\n}}\n")
                self.assertEqual(facts.safe_value(facts.declarations[(2, "n")]["value"], known, {}), expected)

    def test_length_query_requires_confirmed_standard_container(self):
        for expression, kinds, known, expected in (
                ("a.size()", {"a": "string"}, {"a": True}, True),
                ("a.length() + 1", {"a": "string"}, {"a": True}, True),
                ("a.size()", {"a": "vector"}, {"a": True}, True),
                ("a.size()", {}, {"a": True}, False),
                ("a.size()", {"a": "string"}, {"a": False}, False),
                ("a.length()", {"a": "vector"}, {"a": True}, False),
                ("a.size(1)", {"a": "string"}, {"a": True}, False),
                ("a->size()", {"a": "string"}, {"a": True}, False),
                ("a.clear()", {"a": "string"}, {"a": True}, False),
                ("f()", {}, {}, False)):
            with self.subTest(expression=expression, kinds=kinds, known=known):
                facts = SourceFacts(f"int main() {{\n int n = {expression}; // n：查询结果\n}}\n")
                value = facts.declarations[(2, "n")]["value"]
                self.assertEqual(facts.safe_value(value, known, kinds), expected)

    def raw(self, line, error=None):
        return {"frames": [{"key": "main:fp", "level": 0, "line": line, "user": True}],
                "variables": [{"rawId": "x", "name": "x", "type": "int", "frameKey": "main:fp", "frame": 0,
                               "declaration": 2, "scope": "1:20", "depth": 0, "kind": "local",
                               "rawValue": "123456789", "readError": error}]}

    def build(self, builder, line, **kwargs):
        return builder.build(self.raw(line, kwargs.pop("error", None)), "run", {"stdout": "", "stderr": ""},
                             {"stdout": "", "stderr": ""}, **kwargs)

    def test_read_failure_never_exposes_raw_slot(self):
        builder = SnapshotBuilder("int main() {\n int x = 1; // x = 待观察值\n return x;\n}\n")
        self.build(builder, 2)
        snapshot = self.build(builder, 3, motion="next", error="Cannot access memory")
        item = snapshot["variables"][0]
        self.assertEqual(item["state"], "unavailable")
        self.assertIsNone(item["value"])
        self.assertNotIn("rawValue", item)
        self.assertIn("读取失败", item["note"])

    def test_conditional_assignment_is_not_initialization_evidence(self):
        builder = SnapshotBuilder("int main() {\n int x; // x = 未赋值的整数\n if (false) { x = 5; }\n return 0;\n}\n")
        self.build(builder, 3)
        snapshot = self.build(builder, 4, motion="next")
        self.assertIsNone(snapshot["variables"][0]["value"])
        self.assertNotEqual(snapshot["variables"][0]["state"], "ok")

    def test_continue_hides_unobserved_initialization(self):
        builder = SnapshotBuilder("int main() {\n int x = 1; // x = 待观察值\n return x;\n}\n")
        self.build(builder, 2)
        snapshot = self.build(builder, 3, motion="continue")
        self.assertEqual(snapshot["variables"][0]["state"], "unavailable")
        self.assertIsNone(snapshot["variables"][0]["value"])
