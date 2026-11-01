"""统一定位安装资源；调用者不依赖当前工作目录。"""
from pathlib import Path
import os
import tempfile

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / ".local"
WEB = ROOT / "web"
LESSONS = ROOT / "课例"
STATE = LOCAL / "service.json"
GDB_AGENT = Path(__file__).resolve().parent / "debugger/gdb_agent"


def ascii_temp_base():
    """为 GCC/GDB 选择可写的 ASCII 临时根目录，支持中文安装路径。"""
    base = Path(tempfile.gettempdir())
    if not str(base).isascii():
        base = Path(os.environ.get("PUBLIC", "C:/Users/Public")) / "CodeLabTemp"
    if not str(base).isascii():
        raise RuntimeError("系统临时目录和 PUBLIC 均含非 ASCII 字符，请将 TEMP 设置为可写的英文路径。")
    base.mkdir(parents=True, exist_ok=True)
    return base
