"""独立页面会话、操作串行化、取消与超时回收。"""
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time

from code_lab.config import MAX_SESSIONS, SESSION_TTL, EXECUTION_TIMEOUT
from code_lab.debugger.session import DebugSession


class APIError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Entry:
    def __init__(self, directory):
        self.directory = directory
        self.lock = threading.Lock()
        self.session = None
        self.closed = False
        self.touched = time.monotonic()


class Sessions:
    def __init__(self, timeout=EXECUTION_TIMEOUT):
        self.timeout = timeout
        self.directory = tempfile.TemporaryDirectory(prefix="code-lab-web-")
        self.entries = {}
        self.lock = threading.Lock()
        self.closed = False
        self.finished = threading.Event()
        self.reaper = threading.Thread(target=self.reap, daemon=True)
        self.reaper.start()

    def reap(self):
        while not self.finished.wait(5):
            with self.lock:
                stale = [identity for identity, entry in self.entries.items()
                         if time.monotonic() - entry.touched > SESSION_TTL]
            for identity in stale:
                self.remove(identity)

    def entry(self, identity, create=False):
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{32}", identity):
            raise APIError("会话标识无效，请刷新页面")
        with self.lock:
            if self.closed:
                raise APIError("服务正在关闭", 503)
            entry = self.entries.get(identity)
            if entry is None and create:
                if len(self.entries) >= MAX_SESSIONS:
                    raise APIError("打开的实验台过多，请关闭多余页面后重试", 409)
                directory = Path(self.directory.name) / identity
                directory.mkdir()
                entry = self.entries[identity] = Entry(directory)
            if entry is None:
                raise APIError("会话已结束，请重新运行", 404)
            entry.touched = time.monotonic()
            return entry

    def start(self, data):
        source, stdin = data.get("source"), data.get("input", "")
        standard = data.get("standard", "c++14")
        if not isinstance(source, str) or not source.strip() or not isinstance(stdin, str):
            raise APIError("请填写 C++ 代码，标准输入须为文本")
        if standard not in ("c++11", "c++14"):
            raise APIError("仅支持 C++11 和 C++14")
        entry = self.entry(data.get("sessionId"), create=True)
        if not entry.lock.acquire(blocking=False):
            raise APIError("上一个操作尚未完成，请稍候", 409)
        try:
            if entry.closed:
                raise APIError("会话已结束，请重新运行", 409)
            if entry.session:
                entry.session.close()
            source_path, input_path = entry.directory / "source.cpp", entry.directory / "input.txt"
            source_path.write_text(source, encoding="utf-8")
            input_path.write_text(stdin, encoding="utf-8")
            entry.session = DebugSession(source_path, input_path, standard, self.timeout,
                                         log_root=entry.directory / "logs")
            return entry.session.start()
        finally:
            entry.lock.release()

    def command(self, data):
        command, run_id = data.get("command"), data.get("runId")
        if command not in ("next", "step", "finish", "stop"):
            raise APIError("不支持的调试操作")
        if not isinstance(run_id, str) or not run_id:
            raise APIError("缺少运行标识，请重新运行")
        entry = self.entry(data.get("sessionId"))
        if command == "stop":
            # 停止可越过前台执行锁，先取消正在等待 GDB 的单步。
            if entry.session:
                entry.session.request_stop(run_id)
            with entry.lock:
                if entry.closed or not entry.session:
                    raise APIError("尚未开始运行", 409)
                return entry.session.execute("stop", run_id)
        if not entry.lock.acquire(blocking=False):
            raise APIError("上一个操作尚未完成，请勿重复点击", 409)
        try:
            if entry.closed or not entry.session:
                raise APIError("尚未开始运行", 409)
            return entry.session.execute(command, run_id)
        finally:
            entry.lock.release()

    def remove(self, identity):
        try:
            entry = self.entry(identity)
        except APIError as error:
            if error.status == 404:
                return
            raise
        if entry.session:
            entry.session.request_stop()
        with entry.lock:
            entry.closed = True
            if entry.session:
                entry.session.close()
            with self.lock:
                self.entries.pop(identity, None)
            shutil.rmtree(entry.directory, ignore_errors=True)

    def window(self, data):
        entry = self.entry(data.get("sessionId"))
        if not entry.lock.acquire(blocking=False):
            raise APIError("上一个操作尚未完成，请稍候", 409)
        try:
            if entry.closed or not entry.session:
                raise APIError("尚未开始运行", 409)
            try:
                return entry.session.window(data.get("runId"), data.get("variableId"),
                                            data.get("offset"), data.get("limit"))
            except ValueError as error:
                raise APIError(str(error), 409)
        finally:
            entry.lock.release()

    def close(self):
        self.finished.set()
        self.reaper.join()
        for identity in list(self.entries):
            self.remove(identity)
        self.closed = True
        self.directory.cleanup()
