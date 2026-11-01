"""公共数据约定：真实快照构建、数值精度和内置课例格式。"""
import json
import unittest

from code_lab.paths import ROOT, LESSONS
from code_lab.snapshots.builder import SnapshotBuilder


class ContractTests(unittest.TestCase):
    def test_builder_preserves_public_snapshot_fields_and_integer_text(self):
        schema = json.loads((ROOT / "contracts/snapshot.schema.json").read_text(encoding="utf-8"))
        raw = {
            "frames": [{"key": "main:1", "level": 0, "function": "main", "line": 3, "user": True}],
            "variables": [{"rawId": "global:a", "name": "a", "type": "long long", "frameKey": "global",
                           "frame": None, "scope": "global", "declaration": 1, "depth": 0,
                           "kind": "global", "rawValue": "9007199254740993", "readError": None}],
        }
        builder = SnapshotBuilder("long long a = 9007199254740993LL;\nint main() {\n return 0;\n}\n")
        snapshot = builder.build(raw, "contract", {"stdout": "", "stderr": ""}, {"stdout": "", "stderr": ""})
        self.assertTrue(set(schema["required"]).issubset(snapshot))
        self.assertIn(snapshot["status"], schema["properties"]["status"]["enum"])
        variable = snapshot["variables"][0]
        self.assertTrue(set(schema["$defs"]["variable"]["required"]).issubset(variable))
        self.assertEqual(variable["value"], "9007199254740993")
        self.assertIn(variable["state"], schema["$defs"]["variable"]["properties"]["state"]["enum"])
        self.assertTrue(variable["id"].startswith("contract:global:"))
        # 后续窗口或展示层修改不能反向污染已保存的历史。
        snapshot["variables"][0]["value"] = "changed"
        self.assertEqual(builder.history[0]["variables"][0]["value"], "9007199254740993")

    def test_catalog_and_examples_use_version_one_lesson_contract(self):
        schema = json.loads((ROOT / "contracts/lesson.schema.json").read_text(encoding="utf-8"))
        catalog = json.loads((LESSONS / "index.json").read_text(encoding="utf-8"))
        ids = [item["id"] for item in catalog["lessons"]]
        self.assertEqual(len(ids), len(set(ids)))
        files = [LESSONS / item["file"] for item in catalog["lessons"]]
        self.assertEqual(set(files), set(LESSONS.glob("*.json")) - {LESSONS / "index.json"})
        for path in [*files, ROOT / "contracts/examples/lesson.json"]:
            with self.subTest(path=path.name):
                lesson = json.loads(path.read_text(encoding="utf-8"))
                self.assertTrue(set(schema["required"]).issubset(lesson))
                self.assertEqual(lesson["version"], 1)
                self.assertIsInstance(lesson["code"], str)
                self.assertTrue(lesson["code"].strip())
                self.assertIsInstance(lesson["input"], str)
                self.assertIn(lesson["display"]["standard"], ("c++11", "c++14"))

    def test_snapshot_example_has_public_fields(self):
        schema = json.loads((ROOT / "contracts/snapshot.schema.json").read_text(encoding="utf-8"))
        sample = json.loads((ROOT / "contracts/examples/snapshot.json").read_text(encoding="utf-8"))
        self.assertTrue(set(schema["required"]).issubset(sample))
        self.assertIn(sample["status"], schema["properties"]["status"]["enum"])
