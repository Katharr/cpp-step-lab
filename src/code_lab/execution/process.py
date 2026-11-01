"""所属进程树的生命周期、输出限额与运行状态文件操作。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading
import time

from code_lab.config import OUTPUT_LIMIT

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
    state_file: Path,
    output_limit: int = OUTPUT_LIMIT,
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
            state_file,
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
                    remaining = output_limit - len(buffers["stdout"]) - len(buffers["stderr"])
                    if remaining <= 0:
                        over_limit = True
                    else:
                        buffers[name].extend(chunk[:remaining])
                        if len(chunk) > remaining:
                            over_limit = True
            except queue.Empty:
                pass
            state = read_json(state_file) or {}
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
        state = read_json(state_file) or {}
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
