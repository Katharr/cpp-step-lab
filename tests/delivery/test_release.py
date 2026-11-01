"""发布应用清单：只复制受控资源，刷新时回收旧文件并阻止越界路径。"""
import json
from pathlib import Path
import re
import tempfile
import unittest

from scripts.release.build import APPLICATION_FILES, ROOT, application, publication_files


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
        self.assertIn("src/code_lab/debugger/mi_transport.py", actual)
        self.assertIn("web/features/data/cell-access.js", actual)
        self.assertIn("课例/index.json", actual)
        self.assertIn('type="module"', (self.target / "web/index.html").read_text(encoding="utf-8"))
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

    def test_packaged_page_has_all_local_module_and_style_dependencies(self):
        application(self.target)
        page = self.target / "web/index.html"
        pending = [page]
        visited = set()
        while pending:
            path = pending.pop().resolve()
            if path in visited:
                continue
            visited.add(path)
            self.assertTrue(path.is_relative_to(self.target.resolve()), path)
            self.assertTrue(path.is_file(), path)
            text = path.read_text(encoding="utf-8")
            if path.suffix == ".html":
                references = re.findall(r'(?:src|href)=[\"\']([^\"\']+)[\"\']', text)
            elif path.suffix == ".js":
                references = re.findall(r'(?:from\s*|import\s*)[\"\']([^\"\']+)[\"\']', text)
            else:
                references = re.findall(r'@import\s+[\"\']([^\"\']+)[\"\']', text)
            for reference in references:
                self.assertNotRegex(reference, r"^(?:https?:)?//", "发布页面必须使用本地资源")
                dependency = (self.target / "web" / reference.lstrip("/") if reference.startswith("/")
                              else path.parent / reference)
                pending.append(dependency)


if __name__ == "__main__":
    unittest.main(verbosity=2)
