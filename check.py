"""使用本项目环境运行已有的真实 GCC/GDB 自动验收。"""
import subprocess
import sys
from pathlib import Path

from launch import configure

ROOT = Path(__file__).resolve().parent


if __name__ == "__main__":
    configure()
    for folder, script in ((".", "test_release.py"),
                           ("调试器", "test_session.py"),
                           ("调试器", "test_structures.py"),
                           ("调试器", "test_io_trace.py"),
                           ("运行器", "test_web.py")):
        result = subprocess.run([sys.executable, script], cwd=ROOT / folder)
        if result.returncode:
            raise SystemExit(result.returncode)
