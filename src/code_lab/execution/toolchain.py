"""外部工具查找与调试所需 Python 依赖检查。"""
import os
import shutil


def find_compiler() -> str:
    compiler = os.environ.get("CXX") or shutil.which("g++")
    if not compiler:
        raise RuntimeError("找不到 g++，请把 GCC 的 bin 目录加入 PATH")
    return compiler


def find_gdb():
    executable = shutil.which("gdb")
    if not executable:
        raise RuntimeError("找不到 gdb，请检查项目工具链环境")
    return executable


def ensure_dependencies():
    try:
        import pygdbmi
        import tree_sitter
        import tree_sitter_cpp
    except ImportError as error:
        raise RuntimeError("缺少依赖，请用项目 Python 执行 pip install -r requirements.txt") from error
