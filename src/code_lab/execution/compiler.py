"""GCC 编译、诊断结果与取消处理。"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time

from code_lab.execution.process import decode_output, kill_process


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
