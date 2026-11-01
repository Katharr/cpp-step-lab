"""单文件 C++ 普通运行流程及命令行入口。"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import tempfile
import uuid

from code_lab.config import EXECUTION_TIMEOUT
from code_lab.paths import LOCAL, ascii_temp_base
from code_lab.execution.compiler import compile_source
from code_lab.execution.process import (atomic_write, json_dump, kill_process, process_alive,
                                        read_json, remove_tree, run_program)
from code_lab.execution.toolchain import find_compiler

STATE_FILE = LOCAL / "runner-state.json"
DEFAULT_TIMEOUT = EXECUTION_TIMEOUT


def clear_state(run_id: str) -> None:
    state = read_json(STATE_FILE)
    if state and state.get("runId") == run_id:
        try:
            STATE_FILE.unlink()
        except FileNotFoundError:
            pass


def result_template(run_id: str | None = None) -> dict:
    return {
        "status": "error",
        "compile": {},
        "stdout": "",
        "stderr": "",
        "runId": run_id,
        "error": None,
    }


def run_once(source: Path, input_path: Path | None, timeout: float, standard: str) -> dict:
    active = read_json(STATE_FILE)
    if active and process_alive(active.get("pid")):
        result = result_template()
        result["status"] = "busy"
        result["error"] = f"已有运行中的会话：{active.get('runId', '未知')}"
        return result
    if active:
        try:
            STATE_FILE.unlink()
        except FileNotFoundError:
            pass
    run_id = uuid.uuid4().hex
    result = result_template(run_id)
    # MSYS2 g++ 的临时编译路径必须是 ASCII；源码可以来自中文工作区。
    work = Path(tempfile.mkdtemp(prefix=f"code-lab-{run_id[:8]}-", dir=ascii_temp_base()))
    try:
        compiler = find_compiler()
        compile_result, executable = compile_source(compiler, source, work, timeout, standard)
        result["compile"] = compile_result
        if executable is None:
            result["status"] = "compile_error" if compile_result["status"] == "failed" else "error"
            result["error"] = (
                "编译失败，请查看 compile.stderr"
                if result["status"] == "compile_error"
                else "编译超时"
            )
            return result
        status, stdout, stderr, returncode, error = run_program(
            executable, input_path, work, run_id, timeout, STATE_FILE
        )
        result.update({"status": status, "stdout": stdout, "stderr": stderr, "error": error})
        result["compile"]["runReturncode"] = returncode
        return result
    except (OSError, RuntimeError, ValueError) as error:
        result["error"] = f"{type(error).__name__}: {error}"
        return result
    finally:
        clear_state(run_id)
        remove_tree(work)


def stop_current() -> dict:
    state = read_json(STATE_FILE)
    result = result_template(state.get("runId") if state else None)
    if not state or not state.get("pid"):
        result.update({"status": "idle", "error": "当前没有运行中的程序"})
        return result
    pid = int(state["pid"])
    if not process_alive(pid):
        try:
            STATE_FILE.unlink()
        except FileNotFoundError:
            pass
        result.update({"status": "idle", "error": "当前没有运行中的程序"})
        return result
    state["stopRequested"] = True
    state["status"] = "stopping"
    atomic_write(STATE_FILE, state)
    kill_process(None, pid)
    result.update({"status": "stop_requested", "error": "已请求停止当前运行"})
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="单文件 C++ 源码")
    parser.add_argument("--input", type=Path, help="标准输入文件，可省略")
    parser.add_argument("--std", choices=("c++11", "c++14"), default="c++14", help="C++ 标准，默认 c++14")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="运行秒数，默认 30")
    parser.add_argument("--stop", action="store_true", help="停止当前运行")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.stop:
        print(json_dump(stop_current()), end="")
        return 0
    result = result_template()
    try:
        if not args.source:
            raise ValueError("运行时必须提供 --source")
        source = args.source.resolve()
        if not source.is_file():
            raise FileNotFoundError(f"源码不存在：{source}")
        input_path = args.input.resolve() if args.input else None
        if input_path and not input_path.is_file():
            raise FileNotFoundError(f"输入文件不存在：{input_path}")
        if args.timeout <= 0:
            raise ValueError("--timeout 必须大于 0")
        result = run_once(source, input_path, args.timeout, args.std)
    except (OSError, ValueError, RuntimeError) as error:
        result["error"] = f"{type(error).__name__}: {error}"
    print(json_dump(result), end="")
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
