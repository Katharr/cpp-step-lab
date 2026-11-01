"""运行源码仓库内的发布包独立运行验收。"""
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    runpy.run_module("tests.delivery.verify_delivery", run_name="__main__")
