"""仅监听回环地址的 HTTP 接口与服务生命周期。"""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import threading
from urllib.parse import urlsplit

from code_lab.config import MAX_BODY, DEFAULT_PORT, EXECUTION_TIMEOUT
from code_lab.paths import ROOT
from code_lab.execution.toolchain import ensure_dependencies
from code_lab.server.sessions import APIError, Sessions
from code_lab.server.static_files import resolve_static


class LabServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, address, timeout=EXECUTION_TIMEOUT):
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
        try:
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
            self.wfile.write(body)
        except ConnectionError:
            # 网页可能已刷新或关闭；响应头和正文都可能断连，不再发送错误响应。
            self.close_connection = True

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
        except ConnectionError:
            self.close_connection = True

    def do_GET(self):
        try:
            self.allowed()
            route = urlsplit(self.path).path
            if route == "/api/health":
                self.respond(200, {"status": "ready", "app": "code-lab", "version": "1.0.0"})
                return
            if route == "/favicon.ico":
                self.respond(204, b"", "image/x-icon")
                return
            resource = resolve_static(route)
            if resource is None:
                raise APIError("页面不存在", 404)
            path, mime = resource
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
        except ConnectionError:
            # 读取请求时断连同样无需向已关闭的连接返回 500。
            self.close_connection = True
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
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=float, default=EXECUTION_TIMEOUT)
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
