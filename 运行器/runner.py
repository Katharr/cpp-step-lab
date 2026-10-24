#!/usr/bin/env python3
"""代码实验台 Spec 01：单文件 C++ 编译、运行、停止和重跑。

输出始终是一个 JSON 对象，便于命令行、后续服务和网页共用同一结果字段。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / ".runner-state.json"
MAX_OUTPUT_BYTES = 1024 * 1024
DEFAULT_TIMEOUT = 30.0
CHUNK_SIZE = 64 * 1024


def now_ms() -> int:
    return int(time.time() * 1000)


def json_dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def atomic_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json_dump(value), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None


def process_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return str(pid) in result.stdout
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def kill_process(process: subprocess.Popen[bytes] | None, pid: int | None = None) -> None:
    """结束本次运行所属进程树，兼容 Windows 和 POSIX。"""
    target = pid or (process.pid if process is not None else None)
    if not target:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(target), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif process is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                process.kill()
            except (OSError, ProcessLookupError):
                pass


def remove_tree(path: Path | None) -> None:
    if path is None:
        return
    try:
        shutil.rmtree(path, ignore_errors=True)
    except OSError:
        pass


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


def find_compiler() -> str:
    compiler = os.environ.get("CXX") or shutil.which("g++")
    if not compiler:
        raise RuntimeError("找不到 g++，请把 GCC 的 bin 目录加入 PATH")
    return compiler


def compile_source(
    compiler: str, source: Path, work: Path, timeout: float, standard: str,
    extra_flags: tuple[str, ...] = (), cancellation=None,
) -> tuple[dict, Path | None]:
    source_copy = work / "main.cpp"
    executable = work / ("main.exe" if os.name == "nt" else "main")
    source_copy.write_bytes(source.read_bytes())
    command = [compiler, f"-std={standard}", "-g", "-O0", *extra_flags, str(source_copy), "-o", str(executable)]
    started = time.monotonic()
    process = None
    try:
        process = subprocess.Popen(
            command,
            cwd=work,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            **({"start_new_session": True} if os.name != "nt" else {}),
        )
        while True:
            if cancellation is not None and cancellation.is_set():
                raise InterruptedError("编译已停止")
            if time.monotonic() - started > timeout:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                stdout, stderr = process.communicate(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                continue
        compile_result = {
            "status": "success" if process.returncode == 0 else "failed",
            "command": command,
            "returncode": process.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "durationMs": round((time.monotonic() - started) * 1000),
        }
        return compile_result, executable if process.returncode == 0 else None
    except subprocess.TimeoutExpired as error:
        return {
            "status": "timeout",
            "command": command,
            "returncode": None,
            "stdout": decode_output(error.stdout),
            "stderr": decode_output(error.stderr),
            "durationMs": round((time.monotonic() - started) * 1000),
        }, None
    finally:
        if process is not None:
            if process.poll() is None:
                kill_process(process)
            process.communicate()


def decode_output(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def reader(stream, stream_name: str, messages: queue.Queue[tuple[str, bytes | None]]) -> None:
    try:
        while True:
            chunk = stream.read(CHUNK_SIZE)
            if not chunk:
                break
            messages.put((stream_name, chunk))
    finally:
        messages.put((stream_name, None))


def run_program(
    executable: Path,
    input_path: Path | None,
    work: Path,
    run_id: str,
    timeout: float,
) -> tuple[str, str, str, int | None, str | None]:
    input_handle = input_path.open("rb") if input_path else open(os.devnull, "rb")
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    popen_kwargs = {
        "cwd": work,
        "stdin": input_handle,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "creationflags": creationflags,
    }
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True
    process = None
    # 限制队列，避免高速输出在监控循环处理前无限占用内存。
    messages: queue.Queue[tuple[str, bytes | None]] = queue.Queue(maxsize=16)
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    ended = {"stdout": False, "stderr": False}
    over_limit = False
    timed_out = False
    try:
        process = subprocess.Popen([str(executable)], **popen_kwargs)
        atomic_write(
            STATE_FILE,
            {
                "runId": run_id,
                "pid": process.pid,
                "startedAt": now_ms(),
                "workDir": str(work),
                "status": "running",
                "stopRequested": False,
            },
        )
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            threading.Thread(target=reader, args=(stream, name, messages), daemon=True).start()
        started = time.monotonic()
        while True:
            try:
                name, chunk = messages.get(timeout=0.05)
                if chunk is None:
                    ended[name] = True
                else:
                    remaining = MAX_OUTPUT_BYTES - len(buffers["stdout"]) - len(buffers["stderr"])
                    if remaining <= 0:
                        over_limit = True
                    else:
                        buffers[name].extend(chunk[:remaining])
                        if len(chunk) > remaining:
                            over_limit = True
            except queue.Empty:
                pass
            state = read_json(STATE_FILE) or {}
            if state.get("runId") == run_id and state.get("stopRequested"):
                kill_process(process)
            if time.monotonic() - started > timeout and process.poll() is None:
                timed_out = True
                kill_process(process)
            if over_limit and process.poll() is None:
                kill_process(process)
            if process.poll() is not None and ended["stdout"] and ended["stderr"]:
                break
        returncode = process.wait(timeout=5)
        state = read_json(STATE_FILE) or {}
        if timed_out:
            status, error = "timeout", f"运行超过 {timeout:g} 秒，已自动停止"
        elif over_limit:
            status, error = "output_limit", "程序输出超过 1 MB，已停止并截断输出"
        elif state.get("runId") == run_id and state.get("stopRequested"):
            status, error = "stopped", "已按请求停止运行"
        elif returncode == 0:
            status, error = "completed", None
        else:
            status, error = "runtime_error", f"程序退出码为 {returncode}"
        return status, bytes(buffers["stdout"]).decode("utf-8", errors="replace"), bytes(buffers["stderr"]).decode("utf-8", errors="replace"), returncode, error
    finally:
        if process is not None and process.poll() is None:
            kill_process(process)
            try:
                process.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                pass
        input_handle.close()


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
    temporary_parent = Path(tempfile.gettempdir())
    if not str(temporary_parent).isascii():
        temporary_parent = Path("C:/code-lab-temp")
    temporary_parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"code-lab-{run_id[:8]}-", dir=temporary_parent))
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
            executable, input_path, work, run_id, timeout
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
