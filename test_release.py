"""发布应用清单：只复制受控资源，刷新时回收旧文件并阻止越界路径。"""
import json
from pathlib import Path
import tempfile
import unittest

from build_release import APPLICATION_FILES, ROOT, application, publication_files


class ReleaseFilesTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / ".local"
        base.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="release-check-", dir=base)
        self.addCleanup(self.temporary.cleanup)
        self.target = Path(self.temporary.name) / "中文发布目录"
        self.target.mkdir()

    def test_application_contains_only_allowlisted_files(self):
        application(self.target)
        actual = {path.relative_to(self.target).as_posix() for path in self.target.rglob("*") if path.is_file()}
        self.assertEqual(actual, set(APPLICATION_FILES))
        self.assertIn("调试器/mi_transport.py", actual)
        self.assertFalse(any("探针" in name or "spec-" in name or "test_" in name for name in actual))

    def test_refresh_removes_retired_files_and_preserves_runtime(self):
        old = ("docs/旧开发记录.md", "探针/probe.py", "调试器/verify.py", "故障处理.md", "验收记录.md", "runtime/keep.txt")
        for name in old:
            path = self.target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("previous", encoding="utf-8")
        (self.target / "manifest.json").write_text(json.dumps({"files": [{"path": name} for name in old]}), encoding="utf-8")
        application(self.target)
        for name in old[:-1]:
            self.assertFalse((self.target / name).exists(), name)
        self.assertEqual((self.target / old[-1]).read_text(encoding="utf-8"), "previous")

    def test_refresh_rejects_manifest_path_outside_target(self):
        outside = self.target.parent / "keep.txt"
        outside.write_text("untouched", encoding="utf-8")
        (self.target / "manifest.json").write_text(json.dumps({"files": [{"path": "docs/../../keep.txt"}]}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "目录外"):
            application(self.target)
        self.assertEqual(outside.read_text(encoding="utf-8"), "untouched")

    def test_publication_excludes_local_additions(self):
        application(self.target)
        extras = (".env", "docs/私人记录.txt", "web/local.json", ".local/service.json",
                  "runtime/python/__pycache__/local.pyc")
        for name in (*extras, "runtime/python/python.exe", "wheelhouse/dependency.whl"):
            path = self.target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("local", encoding="utf-8")
        actual = {path.relative_to(self.target).as_posix() for path in publication_files(self.target)}
        self.assertEqual(actual, set(APPLICATION_FILES) | {"runtime/python/python.exe", "wheelhouse/dependency.whl"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
