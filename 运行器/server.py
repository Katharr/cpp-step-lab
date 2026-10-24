#!/usr/bin/env python3
"""Spec 03：仅监听回环地址的网页与调试接口，不依赖 Web 框架。"""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "调试器"))
from session import DebugSession, ensure_dependencies

MAX_BODY = 512 * 1024


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
    def __init__(self, timeout=30):
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
                         if time.monotonic() - entry.touched > 60]
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
                if len(self.entries) >= 8:
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


class LabServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, address, timeout=30):
        super().__init__(address, Handler)
        self.sessions = Sessions(timeout)
        self.shutdown_token = None

    def server_close(self):
        if hasattr(self, "sessions"):
            # 先取消，再等待请求线程退出。
            for entry in list(self.sessions.entries.values()):
                if entry.session:
                    entry.session.request_stop()
        super().server_close()
        if hasattr(self, "sessions"):
            self.sessions.close()


class Handler(BaseHTTPRequestHandler):
    def allowed(self):
        port = self.server.server_port
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            raise APIError("仅允许本机访问", 403)
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ("null", f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            raise APIError("不允许此网页访问实验台", 403)

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        port = self.server.server_port
        if origin in ("null", f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        try:
            self.allowed()
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "null"))
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except APIError as error:
            self.respond(error.status, {"error": str(error)})

    def do_GET(self):
        try:
            self.allowed()
            route = urlsplit(self.path).path
            if route == "/api/health":
                self.respond(200, {"status": "ready", "app": "code-lab", "version": "1.0.0"})
                return
            files = {"/": (ROOT / "web/index.html", "text/html"),
                     "/index.html": (ROOT / "web/index.html", "text/html"),
                     "/app.js": (ROOT / "web/app.js", "text/javascript"),
                     "/syntax.js": (ROOT / "web/syntax.js", "text/javascript"),
                     "/lab.css": (ROOT / "web/lab.css", "text/css"),
                     "/data-visuals.css": (ROOT / "web/data-visuals.css", "text/css"),
                     "/site.css": (ROOT / "web/site.css", "text/css")}
            if route == "/favicon.ico":
                self.respond(204, b"", "image/x-icon")
                return
            if route not in files:
                raise APIError("页面不存在", 404)
            path, mime = files[route]
            self.respond(200, path.read_bytes(), mime + "; charset=utf-8")
        except APIError as error:
            self.respond(error.status, {"error": str(error)})

    def do_POST(self):
        try:
            self.allowed()
            if self.headers.get_content_type() != "application/json":
                raise APIError("请求须为 JSON 文本", 415)
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise APIError("请求长度无效")
            if not 0 < length <= MAX_BODY:
                raise APIError("代码与输入合计不能超过 512 KB", 413)
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise APIError("请求格式无效")
            route = urlsplit(self.path).path
            if route == "/api/start":
                result = self.server.sessions.start(data)
            elif route == "/api/command":
                result = self.server.sessions.command(data)
            elif route == "/api/window":
                result = self.server.sessions.window(data)
            elif route == "/api/close":
                self.server.sessions.remove(data.get("sessionId"))
                result = {"status": "closed"}
            elif route == "/api/ping":
                self.server.sessions.entry(data.get("sessionId"))
                result = {"status": "alive"}
            elif route == "/api/shutdown":
                if not self.server.shutdown_token or data.get("token") != self.server.shutdown_token:
                    raise APIError("停止口令无效，请使用 stop.bat", 403)
                result = {"status": "stopping"}
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                raise APIError("接口不存在", 404)
            self.respond(200, result)
        except APIError as error:
            self.respond(error.status, {"error": str(error)})
        except (UnicodeError, json.JSONDecodeError, TimeoutError):
            self.respond(400, {"error": "请求文本不完整或格式无效"})
        except Exception as error:
            print(f"请求失败：{type(error).__name__}: {error}", file=sys.stderr)
            self.respond(500, {"error": "本地服务处理失败，请重新运行；详情见服务窗口"})

    def log_message(self, format, *args):
        pass


def main():
    ensure_dependencies()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or args.timeout <= 0:
        parser.error("端口或执行时限无效")
    try:
        server = LabServer(("127.0.0.1", args.port), args.timeout)
    except OSError as error:
        print(f"服务未启动，端口可能已占用：{error}", file=sys.stderr)
        return 1
    print(f"代码实验台已启动：http://127.0.0.1:{args.port}/ （Ctrl+C 关闭并清理）", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
