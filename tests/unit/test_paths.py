"""包与根目录入口从其他工作目录运行时仍定位本项目。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from code_lab.paths import ROOT, ascii_temp_base


class ProjectPathsTests(unittest.TestCase):
    def test_chinese_temp_uses_ascii_fallback(self):
        with tempfile.TemporaryDirectory(prefix="code-lab-temp-test-") as directory:
            chinese = Path(directory) / "中文临时目录"
            chinese.mkdir()
            with patch("tempfile.tempdir", str(chinese)), patch.dict(os.environ, {"PUBLIC": directory}):
                base = ascii_temp_base()
                self.assertTrue(str(base).isascii())
                self.assertEqual(base, Path(directory) / "CodeLabTemp")
                self.assertTrue(base.is_dir())

    def test_launcher_help_from_unrelated_chinese_directory(self):
        with tempfile.TemporaryDirectory(prefix="实验台入口-") as directory:
            result = subprocess.run([sys.executable, str(ROOT / "launch.py"), "--help"],
                                    cwd=directory, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertIn(b"--no-browser", result.stdout)

    def test_package_paths_do_not_depend_on_cwd(self):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ROOT / "src")
        with tempfile.TemporaryDirectory(prefix="实验台模块-") as directory:
            result = subprocess.run([sys.executable, "-X", "utf8", "-c",
                "from code_lab.paths import ROOT, WEB, LESSONS; "
                "assert WEB.is_dir() and LESSONS.is_dir(); print(ROOT)"],
                env=env, cwd=directory, capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(result.stdout.strip()).resolve(), ROOT.resolve())
