"""从源码或便携包启动实验台，统一引导 src 包路径。"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from code_lab.bootstrap import main


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"启动失败：{error}", file=sys.stderr)
        raise SystemExit(1)
