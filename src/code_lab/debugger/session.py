#!/usr/bin/env python3
"""Spec 02 顺序 GDB/MI 会话；命令行每次操作输出一行 JSON。"""
from __future__ import annotations

import argparse
import codecs
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import shutil
import sys
import subprocess
import tempfile
import threading
import time
import uuid

from code_lab.config import COMPILE_TIMEOUT, EXECUTION_TIMEOUT, OUTPUT_LIMIT, HISTORY_LIMIT, WINDOW_DEFAULT, WINDOW_MAX
from code_lab.paths import ROOT, LOCAL, GDB_AGENT, ascii_temp_base
from code_lab.debugger.mi_transport import Session, save_json
from code_lab.debugger import io_trace
from code_lab.execution.compiler import compile_source
from code_lab.execution.process import kill_process, remove_tree
from code_lab.execution.toolchain import ensure_dependencies, find_compiler, find_gdb


class MIError(RuntimeError):
    pass


class Transport(Session):
    def __init__(self, gdb, directory, cancellation, timeout, output_limit):
        self.cancellation = cancellation
        self.timeout = timeout
        self.output_limit = output_limit
        super().__init__(gdb, directory)

    def command(self, command, motion=False, allow_error=False):
        self.token += 1
        token = self.token
        self.commands.write(f"{token}{command}\n")
        self.commands.flush()
        self.controller.write(f"{token}{command}", read_response=False)
        deadline = time.monotonic() + (self.timeout if motion else 12)
        result = stopped = None
        while time.monotonic() < deadline:
            if self.cancellation.is_set():
                raise InterruptedError("已请求停止")
            if motion:
                total = sum((self.directory / name).stat().st_size for name in ("stdout.txt", "stderr.txt")
                            if (self.directory / name).exists())
                if total > self.output_limit:
                    raise OverflowError("程序输出超过上限")
            records = self.controller.get_gdb_response(timeout_sec=0.1, raise_error_on_timeout=False)
            for record in records:
                self.parsed.write(json.dumps(record, ensure_ascii=False) + "\n")
                if record.get("type") == "result" and record.get("token") == token:
                    result = record
                if record.get("message") == "stopped":
                    stopped = record.get("payload") or {}
            self.parsed.flush()
            if result is not None:
                if result["message"] == "error":
                    if allow_error:
                        return result
                    raise MIError(str(result.get("payload")))
                if not motion:
                    return result.get("payload") or {}
                if stopped is not None:
                    total = sum((self.directory / name).stat().st_size for name in ("stdout.txt", "stderr.txt")
                                if (self.directory / name).exists())
                    if total > self.output_limit:
                        raise OverflowError("程序输出超过上限")
                    return stopped
        raise TimeoutError("连续执行超时" if motion else "等待 GDB 命令超时")

    def close(self):
        # 必须先结束 inferior 再退出 GDB；taskkill /T 复用运行器已有实现。
        try:
            process = self.controller.gdb_process if self.controller else None
            if process and process.poll() is None:
                kill_process(process)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    # taskkill 可能已经结束 inferior，但 GDB 管道仍未及时返回。
                    # 关闭调试会话不能把清理动作升级成测试失败。
                    try:
                        process.kill()
                    except OSError:
                        pass
                    try:
                        process.wait(timeout=2)
                    except (subprocess.TimeoutExpired, OSError):
                        pass
            if self.controller:
                self.controller.exit()
        finally:
            for handle in self.files:
                if not handle.closed:
                    handle.close()


class DebugSession:
    MOTIONS = {"next": "-exec-next", "step": "-exec-step", "continue": "-exec-continue",
               "finish": "-exec-finish"}

    def __init__(self, source, input_path=None, standard="c++14", timeout=EXECUTION_TIMEOUT,
                 output_limit=OUTPUT_LIMIT, max_steps=HISTORY_LIMIT, log_root=None):
        if standard not in ("c++11", "c++14") or timeout <= 0 or output_limit <= 0 or max_steps < 2:
            raise ValueError("调试参数无效")
        self.source = Path(source).resolve()
        self.input_path = Path(input_path).resolve() if input_path else None
        self.standard, self.timeout = standard, timeout
        self.output_limit, self.max_steps = output_limit, max_steps
        self.log_root = Path(log_root or LOCAL / "debugger")
        self.lock = threading.RLock()
        self.control_lock = threading.Lock()
        self.cancelled = threading.Event()
        self.transport = self.work = self.builder = None
        self.run_id = None
        self.status = "idle"
        self.compile = {}
        self.offsets = {"stdout": 0, "stderr": 0}
        self.output_bytes = {"stdout": b"", "stderr": b""}
        self.output_text = {"stdout": "", "stderr": ""}
        self.decoders = {name: codecs.getincrementaldecoder("utf-8")(errors="replace")
                         for name in ("stdout", "stderr")}
        self.log_dir = None
        self.windows = {}
        self.input_consumed = 0
        self.evidence = None
        self._pending_raw = None

    @property
    def history(self):
        return self.builder.history if self.builder else []

    def request_stop(self, expected_run_id=None):
        with self.control_lock:
            if expected_run_id is None or expected_run_id == self.run_id:
                self.cancelled.set()

    def _cleanup(self):
        try:
            if self.transport:
                self.transport.close()
        finally:
            self.transport = None
            if self.work:
                if self.log_dir:
                    for name in ("stdout.mi", "stderr.mi", "commands.txt", "parsed.jsonl"):
                        source = self.work / name
                        if source.exists():
                            shutil.copyfile(source, self.log_dir / name)
                remove_tree(self.work)
            self.work = None

    def _output(self):
        delta = {}
        remaining = self.output_limit - sum(len(data) for data in self.output_bytes.values())
        for name in ("stdout", "stderr"):
            data = b""
            replaced = False
            path = self.work / f"{name}.txt" if self.work else None
            if path and path.exists():
                with path.open("rb") as handle:
                    observed = handle.read(self.output_limit)
                if name == "stdout":
                    traced = self.work / "stdout-trace.txt"
                    unavailable = self.work / "stdout-trace-unavailable.txt"
                    if traced.exists() and not unavailable.exists():
                        with traced.open("rb") as handle:
                            logical = handle.read(self.output_limit)
                        if logical.startswith(observed):
                            observed = logical
                # C 输出可能仍在原 FILE 缓冲；保留已经确认接收的 C++ 前缀。
                if observed.startswith(self.output_bytes[name]):
                    data = observed[self.offsets[name]:self.offsets[name] + max(0, remaining)]
                elif self.status == "completed":
                    # 关闭同步后 C/C++ 可真实重排；终态以文件为准，不伪造追加事件。
                    previous_size = len(self.output_bytes[name])
                    observed = observed[:remaining + previous_size]
                    self.output_bytes[name] = observed
                    self.offsets[name] = len(observed)
                    self.output_text[name] = observed.decode("utf-8", errors="replace")
                    self.decoders[name] = codecs.getincrementaldecoder("utf-8")(errors="replace")
                    remaining += previous_size - len(observed)
                    replaced = True
                self.offsets[name] += len(data)
                self.output_bytes[name] += data
                remaining -= len(data)
            delta[name] = "" if replaced else self.decoders[name].decode(data, final=self.status != "paused")
            self.output_text[name] += delta[name]
        return dict(self.output_text), delta

    def _input_trace(self, raw):
        path = self.work / "input-trace.txt" if self.work else None
        state, consumed = "unavailable", self.input_consumed
        try:
            supported, observed = map(int, path.read_text(encoding="ascii").split())
            if supported and raw.get("inputTraceAvailable", True):
                state, consumed = "ok", observed
        except (AttributeError, OSError, ValueError):
            pass
        trace = {"state": state, "consumed": consumed,
                 "deltaStart": self.input_consumed, "deltaEnd": consumed}
        if state != "ok":
            trace["note"] = "当前输入流无法可靠跟踪"
        self.input_consumed = consumed
        return trace

    def _collect(self):
        (self.work / "windows.json").write_text(json.dumps(self.windows), encoding="utf-8")
        self.transport.command(
            f'-interpreter-exec console "python collect(\'state.json\', '
            f'default_limit={WINDOW_DEFAULT}, max_elements={WINDOW_MAX})"')
        raw = json.loads((self.work / "state.json").read_text(encoding="utf-8"))
        with (self.log_dir / "raw-states.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(raw, ensure_ascii=False) + "\n")
        return raw

    def _advance(self, motion, starting=False):
        origin_raw = self._pending_raw or {}
        origin = origin_raw.get("frames", [])
        owner = origin[0]["key"] if origin else None
        deadline = time.monotonic() + self.timeout
        self.evidence.begin_step()
        if motion == "continue":
            # CLI 连续运行不展开内部步骤；保留最后观测，而非宣称恢复未记录的终态。
            self.transport.command("-break-disable 2")
            stop = self.transport.command("-exec-continue", motion=True)
            self.status = self._stop_status(stop)
            if self.status == "paused":
                self.transport.command("-break-enable 2")
                self._pending_raw = self._collect()
            elif self.status == "runtime_error" and self.evidence.last_raw:
                # 故障点可能停在不可安全求值的帧；沿用最后一个可信暂停点。
                self._pending_raw = deepcopy(self.evidence.last_raw)
            return stop
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("连续执行超时")
            sizes = {name: (self.work / name).stat().st_size if (self.work / name).exists() else 0 for name in ("stdout.txt", "stdout-trace.txt", "stderr.txt")}
            if max(sizes["stdout.txt"], sizes["stdout-trace.txt"]) + sizes["stderr.txt"] > self.output_limit:
                raise OverflowError("程序输出超过上限")
            stop = self.transport.command("-exec-continue", motion=True)
            self.status = self._stop_status(stop)
            if self.status != "paused":
                if self.evidence.last_raw:
                    self._pending_raw = deepcopy(self.evidence.last_raw)
                return stop
            raw = self._collect()
            checkpoint = raw.get("checkpoint")
            if not checkpoint:
                self._pending_raw = raw
                return stop
            self.evidence.observe(raw)
            self._pending_raw = raw
            if checkpoint["phase"] != 0:
                continue
            keys = {frame["key"] for frame in raw["frames"]}
            current = raw["frames"][0]["key"] if raw["frames"] else None
            same_site = origin_raw.get("checkpoint") == raw.get("checkpoint")
            if (not starting and motion == "next" and same_site
                    and all(span["kind"] == "condition" for span in self.evidence.spans)
                    and [(item["rawId"], item["rawValue"], item.get("data")) for item in origin_raw.get("variables", [])]
                    == [(item["rawId"], item["rawValue"], item.get("data")) for item in raw.get("variables", [])]):
                continue
            if starting or motion == "step" or (motion == "next" and (current == owner or owner not in keys)) or (motion == "finish" and owner not in keys):
                return stop

    def _snapshot(self, motion=None, reason=None, refresh=False):
        raw = {"frames": [], "variables": []}
        if self.evidence:
            raw = self._collect() if refresh else self._pending_raw or raw
            raw = self.evidence.decorate(raw, motion, self.status)
        elif self.status == "paused":
            raw = self._collect()
        if refresh and self.evidence:
            return self.builder.refresh(raw)
        if refresh:
            current = self.builder.history[-1]
            output, delta = deepcopy(current["output"]), deepcopy(current["outputDelta"])
            reason = current["reason"]
            self.builder.history.pop()
            self.builder.previous = deepcopy(self.builder.history[-1]) if self.builder.history else None
        else:
            output, delta = self._output()
        snapshot = self.builder.build(raw, self.run_id, output, delta, self.status, motion, reason)
        snapshot["motion"] = current.get("motion") if refresh else motion
        if refresh:
            snapshot["arrayAccess"] = deepcopy(current["arrayAccess"])
        snapshot["inputTrace"] = deepcopy(current["inputTrace"]) if refresh else self._input_trace(raw)
        snapshot["compile"] = self.compile
        snapshot["error"] = reason if self.status not in ("paused", "completed", "stopped") else None
        self.builder.previous = deepcopy(snapshot)
        self.builder.history[-1] = deepcopy(snapshot)
        if self.log_dir:
            with (self.log_dir / "snapshots.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(snapshot, ensure_ascii=False) + "\n")
        if self.status != "paused":
            self._cleanup()
        return snapshot

    def window(self, run_id, variable_id, offset, limit):
        with self.lock:
            if run_id != self.run_id or self.status != "paused":
                raise ValueError("运行已变化或未暂停，请重新运行")
            if (type(offset) is not int or type(limit) is not int or
                    not 0 <= offset <= 2 ** 53 - 1 or not 1 <= limit <= WINDOW_MAX):
                raise ValueError("窗口起点须为非负整数，大小须为 1–200")
            item = next((item for item in self.history[-1]["variables"]
                         if item["id"] == variable_id and item.get("data")
                         and item["state"] != "out_of_scope"), None)
            if item is None:
                raise ValueError("此变量当前无法展开")
            self.windows[item["dataKey"]] = {"offset": offset, "limit": limit}
            try:
                return self._snapshot(refresh=True)
            except (Exception, KeyboardInterrupt) as error:
                return self._failure(error)

    def _terminal(self, status, reason):
        self.status = status
        if self.evidence and status in ("stopped", "step_limit"):
            self.evidence.begin_step()
        # 先终止再收集文件，保证末尾输出固定，避免删除仍在写入的文件。
        if self.transport:
            self.transport.close()
            self.transport = None
        return self._snapshot(reason=reason)

    def start(self):
        self.request_stop()
        with self.lock:
            self._cleanup()
            with self.control_lock:
                self.cancelled = threading.Event()
                self.run_id = uuid.uuid4().hex
            self.status, self.compile = "starting", {}
            self.evidence = self._pending_raw = None
            self.windows = {}
            self.input_consumed = 0
            self.offsets = {"stdout": 0, "stderr": 0}
            self.output_bytes = {"stdout": b"", "stderr": b""}
            self.output_text = {"stdout": "", "stderr": ""}
            self.decoders = {name: codecs.getincrementaldecoder("utf-8")(errors="replace")
                             for name in ("stdout", "stderr")}
            from code_lab.snapshots.builder import SnapshotBuilder
            self.builder = SnapshotBuilder("")
            self.log_dir = self.log_root / self.run_id
            self.log_dir.mkdir(parents=True)
            try:
                source_bytes = self.source.read_bytes()
                self.builder = SnapshotBuilder(source_bytes.decode("utf-8-sig"))
                from code_lab.debugger.execution_plan import ExecutionPlan
                from code_lab.snapshots.execution import ExecutionEvidence
                plan = ExecutionPlan(source_bytes.decode("utf-8-sig"))
                self.evidence = ExecutionEvidence(plan, self.builder, self.run_id)
                source_snapshot = self.log_dir / "source.cpp"
                source_snapshot.write_bytes(source_bytes)
                observed_source = self.log_dir / "observed.cpp"
                observed_source.write_text(plan.generate(), encoding="utf-8", newline="\n")
                self.work = Path(tempfile.mkdtemp(prefix="code-lab-debug-", dir=ascii_temp_base()))
                (self.work / "io_trace.hpp").write_text(io_trace.HEADER, encoding="utf-8")
                self.compile, executable = compile_source(
                    find_compiler(), observed_source, self.work, COMPILE_TIMEOUT, self.standard,
                    ("-gdwarf-4", "-fno-omit-frame-pointer", "-finput-charset=UTF-8", "-fexec-charset=UTF-8",
                     "-include", str(self.work / "io_trace.hpp"), *io_trace.LINK_FLAGS),
                    cancellation=self.cancelled)
                save_json(self.log_dir / "compile.json", self.compile)
                if executable is None:
                    return self._terminal("compile_error", "编译失败或超时，请查看 compile.stderr")
                (self.work / "input.txt").write_bytes(self.input_path.read_bytes() if self.input_path else b"")
                for name in ("stdout.txt", "stderr.txt"):
                    (self.work / name).touch()
                shutil.copyfile(GDB_AGENT / "gdb_state.py", self.work / "gdb_state.py")
                shutil.copyfile(GDB_AGENT / "structures.py", self.work / "structures.py")
                gdb = find_gdb()
                self.transport = Transport(gdb, self.work, self.cancelled, self.timeout, self.output_limit)
                for command in ("-gdb-set pagination off", "-gdb-set confirm off", f"-gdb-set print elements {WINDOW_MAX}",
                                "-gdb-set step-mode off", "-environment-cd " + json.dumps(self.work.as_posix()),
                                "-file-exec-and-symbols " + json.dumps(executable.as_posix()),
                                '-interpreter-exec console "source gdb_state.py"', "-break-insert -t main",
                                "-break-insert code_lab_trace::checkpoint"):
                    self.transport.command(command)
                stop = self.transport.command(
                    '-interpreter-exec console "run < input.txt > stdout.txt 2> stderr.txt"', motion=True)
                self.status = self._stop_status(stop)
                if self.status == "paused":
                    stop = self._advance("next", starting=True)
                return self._snapshot(reason=stop)
            except (Exception, KeyboardInterrupt) as error:
                return self._failure(error)

    def _stop_status(self, stop):
        reason = stop.get("reason", "")
        if reason == "exited-normally":
            return "completed"
        if reason.startswith("exited"):
            return "runtime_error"
        if reason == "signal-received":
            return "runtime_error"
        return "paused"

    def _failure(self, error):
        status = ("stopped" if isinstance(error, (InterruptedError, KeyboardInterrupt)) else
                  "timeout" if isinstance(error, TimeoutError) else
                  "output_limit" if isinstance(error, OverflowError) else "error")
        return self._terminal(status, f"{type(error).__name__}: {error}")

    def execute(self, command, expected_run_id=None):
        if command in ("stop", "start", "restart", "rerun"):
            # 取消标记属于独立的一次运行；旧请求不能中断新运行。
            self.request_stop(expected_run_id)
        with self.lock:
            if expected_run_id is not None and expected_run_id != self.run_id:
                return {"status": "stale", "runId": self.run_id, "error": "已忽略旧会话命令"}
            if command in ("start", "restart", "rerun"):
                return self.start()
            if command == "stop":
                if self.status != "paused":
                    return self.history[-1] if self.history else {"status": "idle", "runId": self.run_id}
                return self._terminal("stopped", "人工停止")
            if command not in self.MOTIONS:
                return {"status": "invalid_command", "runId": self.run_id, "error": f"未知命令：{command}"}
            if self.status != "paused":
                return {"status": "invalid_state", "runId": self.run_id, "error": "当前未暂停，请重跑"}
            if len(self.history) >= self.max_steps - 1:
                return self._terminal("step_limit", "快照步数达到上限")
            try:
                stop = self._advance(command) if self.evidence else self.transport.command(self.MOTIONS[command], motion=True)
                # main 返回后 GDB 可能停进 CRT；让其自然退出，不向课堂暴露库源码行。
                frame = stop.get("frame") or {}
                if (stop.get("reason") == "end-stepping-range" and frame
                        and frame.get("func") in ("__tmainCRTStartup", "mainCRTStartup", "__libc_start_call_main",
                                                  "__libc_start_main", "__scrt_common_main_seh")
                        and self.builder.previous and self.builder.previous["frames"]
                        and self.builder.previous["frames"][0]["function"] == "main"):
                    stop = self.transport.command("-exec-continue", motion=True)
                self.status = self._stop_status(stop)
                return self._snapshot(motion=command, reason=stop)
            except MIError as error:
                # 例如 main 中 finish 不合法；拒绝操作但保留可继续的暂停状态。
                return {"status": "command_error", "runId": self.run_id, "error": str(error)}
            except (Exception, KeyboardInterrupt) as error:
                return self._failure(error)

    def close(self):
        self.request_stop()
        with self.lock:
            self._cleanup()
            self.status = "closed"

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def main():
    ensure_dependencies()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--std", choices=("c++11", "c++14"), default="c++14")
    parser.add_argument("--timeout", type=float, default=EXECUTION_TIMEOUT)
    parser.add_argument("--log-root", type=Path, help="调试日志目录，默认写入本项目 .local/debugger")
    args = parser.parse_args()
    session = DebugSession(args.source, args.input, args.std, args.timeout, log_root=args.log_root)

    def display(command):
        print(json.dumps(session.execute(command), ensure_ascii=False), flush=True)

    try:
        display("start")
        executor = ThreadPoolExecutor(max_workers=1)
        abort_queue = False
        try:
            for line in sys.stdin:
                command = line.strip()
                if command in ("quit", "exit"):
                    session.request_stop()
                    abort_queue = True
                    break
                if command == "stop":
                    session.request_stop()
                if command:
                    executor.submit(display, command)
        except KeyboardInterrupt:
            session.request_stop()
            abort_queue = True
        finally:
            if abort_queue:
                executor.shutdown(wait=True, cancel_futures=True)
            else:
                executor.shutdown(wait=True)
    except KeyboardInterrupt:
        session.request_stop()
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
