"""测试资源定位统一以本项目为基准，不依赖运行测试时的工作目录。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CPP_CASES = ROOT / "tests/fixtures/cpp"
