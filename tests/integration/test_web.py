"""真实 HTTP + GCC/GDB 验收；测试服务使用随机本机端口。"""
from concurrent.futures import ThreadPoolExecutor
import json
from io import BytesIO
from email.message import Message
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import socket
import urllib.error
import urllib.request
from urllib.parse import quote
import uuid

from code_lab.server.http_server import Handler, LabServer, ensure_dependencies
from code_lab.paths import ROOT
from tests.support.paths import CPP_CASES


class DisconnectionTests(unittest.TestCase):
    def handler(self):
        handler = Handler.__new__(Handler)
        handler.server = Mock(server_port=8765)
        handler.headers = Message()
        handler.headers["Host"] = "127.0.0.1:8765"
        handler.headers["Content-Type"] = "application/json"
        handler.headers["Content-Length"] = "2"
        handler.rfile = BytesIO(b"{}")
        handler.wfile = Mock()
        handler.connection = Mock()
        handler.request_version = "HTTP/1.1"
        handler.requestline = "POST /api/ping HTTP/1.1"
        handler.command = "POST"
        handler.path = "/api/ping"
        handler.close_connection = False
        return handler

    def test_disconnect_during_headers_or_body_does_not_send_500(self):
        for error in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            for stage in ("headers", "body"):
                with self.subTest(error=error, stage=stage):
                    handler = self.handler()
                    handler.wfile.write.side_effect = (
                        error(10053, "连接已关闭") if stage == "headers"
                        else [None, error(10053, "连接已关闭")])
                    with patch.object(handler, "send_response", wraps=handler.send_response) as response, \
                            patch("code_lab.server.http_server.sys.stderr") as stderr:
                        handler.do_POST()
                    response.assert_called_once_with(200)
                    stderr.write.assert_not_called()
                    self.assertTrue(handler.close_connection)

    def test_disconnect_while_reading_request(self):
        handler = self.handler()
        handler.rfile = Mock()
        handler.rfile.read.side_effect = ConnectionAbortedError(10053, "连接已关闭")
        handler.do_POST()
        handler.wfile.write.assert_not_called()
        handler.server.sessions.entry.assert_not_called()
        self.assertTrue(handler.close_connection)

    def test_unexpected_service_error_is_still_reported(self):
        handler = self.handler()
        handler.server.sessions.entry.side_effect = RuntimeError("测试内部错误")
        with patch.object(handler, "respond") as response, patch("code_lab.server.http_server.sys.stderr") as stderr:
            handler.do_POST()
        self.assertEqual(response.call_args.args[0], 500)
        self.assertIn("RuntimeError", "".join(call.args[0] for call in stderr.write.call_args_list))

    def test_unrelated_write_error_is_not_silenced(self):
        handler = self.handler()
        handler.wfile.write.side_effect = OSError("测试写入错误")
        with self.assertRaises(OSError):
            handler.respond(200, {})


class PortBindingTests(unittest.TestCase):
    def test_second_service_cannot_share_a_listening_port(self):
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        try:
            with self.assertRaises(OSError):
                LabServer(("127.0.0.1", occupied.getsockname()[1]))
        finally:
            occupied.close()


class WebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from code_lab.server import sessions
        cls.logs = tempfile.TemporaryDirectory(prefix="code-lab-http-test-")
        cls.addClassCleanup(cls.logs.cleanup)
        original_session = sessions.DebugSession
        def temporary_session(*args, **kwargs):
            kwargs["log_root"] = Path(cls.logs.name)
            return original_session(*args, **kwargs)
        cls.session_patch = patch.object(sessions, "DebugSession", temporary_session)
        cls.session_patch.start()
        cls.addClassCleanup(cls.session_patch.stop)
        cls.server = LabServer(("127.0.0.1", 0), timeout=2)
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def setUp(self):
        self.identity = uuid.uuid4().hex

    def tearDown(self):
        self.server.sessions.remove(self.identity)

    def request(self, path, data=None, headers=None):
        request = urllib.request.Request(self.base + path,
                                         data=json.dumps(data).encode() if data is not None else None,
                                         headers=headers or ({"Content-Type": "application/json"} if data is not None else {}))
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)

    def start(self, source, **kwargs):
        return self.request("/api/start", {"sessionId": self.identity, "source": source, **kwargs})

    def command(self, snapshot, command):
        return self.request("/api/command", {"sessionId": self.identity, "runId": snapshot["runId"], "command": command})

    def finish(self, snapshot):
        for _ in range(100):
            if snapshot["status"] != "paused":
                return snapshot
            snapshot = self.command(snapshot, "next")
        self.fail("样例未在 100 步内结束")

    def test_static_and_origin(self):
        self.assertEqual(self.request("/api/health")["status"], "ready")
        for route in ("/", "/app.js", "/features/data/cell-access.js", "/features/editor/syntax.js",
                      "/styles/layout.css", "/features/data/access.css", "/styles/base.css"):
            with urllib.request.urlopen(self.base + route) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 0)
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.request("/api/health", headers={"Origin": "https://example.com"})
        self.assertEqual(rejected.exception.code, 403)
        rejected.exception.close()
        request = urllib.request.Request(self.base + "/api/start", method="OPTIONS", headers={"Origin": "null"})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "null")

    def test_lesson_catalog_and_module_resources_are_served_without_source_exposure(self):
        index = self.request(quote("/课例/index.json"))
        self.assertEqual(index["version"], 1)
        self.assertEqual(len({item["id"] for item in index["lessons"]}), len(index["lessons"]))
        for item in index["lessons"]:
            data = self.request(quote("/课例/" + item["file"]))
            expected = json.loads((ROOT / "课例" / item["file"]).read_text(encoding="utf-8"))
            self.assertEqual(data, expected)
            self.assertEqual(data["version"], 1)
        for route in ("/core/state.js", "/features/history/history.js", "/presentation/layout.js"):
            with urllib.request.urlopen(self.base + route) as response:
                self.assertIn("javascript", response.headers["Content-Type"])
                self.assertTrue(response.read())
        for route in ("/src/code_lab/bootstrap.py", "/.local/service.json", "/requirements.txt",
                      "/core/../../launch.py", "/%2e%2e/launch.py", "/%E8%AF%BE%E4%BE%8B/../README.md",
                      "/features/data/renderer.py"):
            with self.subTest(route=route), self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(self.base + route)
            self.assertEqual(rejected.exception.code, 404)
            rejected.exception.close()

    def test_lost_page_lease_releases_debugger_and_files(self):
        self.start("int main() {\n int x = 1;\n return 0;\n}\n")
        entry = self.server.sessions.entry(self.identity)
        process = entry.session.transport.controller.gdb_process
        directory, work = entry.directory, entry.session.work
        self.assertEqual(self.request("/api/ping", {"sessionId": self.identity})["status"], "alive")
        # 模拟浏览器崩溃，没有 pagehide，也没有后续心跳。
        entry.touched = time.monotonic() - 120
        deadline = time.monotonic() + 8
        while self.identity in self.server.sessions.entries and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertNotIn(self.identity, self.server.sessions.entries)
        self.assertIsNotNone(process.poll())
        self.assertFalse(directory.exists())
        self.assertFalse(work.exists())

    def test_window_endpoint_is_bounded_and_does_not_execute(self):
        current = self.start("int a[1000] = {};\nint main() {\n a[999] = 7;\n return 0;\n}\n")
        array = next(v for v in current["variables"] if v["name"] == "a")
        data = {"sessionId": self.identity, "runId": current["runId"], "variableId": array["id"], "offset": 990, "limit": 20}
        refreshed = self.request("/api/window", data)
        self.assertEqual((refreshed["step"], refreshed["line"]), (current["step"], current["line"]))
        array = next(v for v in refreshed["variables"] if v["name"] == "a")
        self.assertEqual([e["index"] for e in array["data"]["elements"]], list(range(990, 1000)))
        self.assertEqual(array["data"]["hidden"], 990)
        current = self.command(current, "next")
        array = next(v for v in current["variables"] if v["name"] == "a")
        self.assertEqual([(e["index"], e["value"]) for e in array["data"]["elements"] if e["changed"]], [(999, "7")])
        for bad in ({"limit": 201}, {"runId": "old"}, {"variableId": "unknown"}, {"offset": -1}):
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                self.request("/api/window", {**data, **bad})
            self.assertEqual(rejected.exception.code, 409)
            rejected.exception.close()
        current = self.start('#include <iostream>\nint a[2] = {};\nint main() {\n std::cout << 7 << std::endl;\n a[1] = 8;\n return 0;\n}\n')
        current = self.command(current, "next")
        self.assertEqual(current["outputDelta"]["stdout"].strip(), "7")
        item = next(v for v in current["variables"] if v["name"] == "a")
        refreshed = self.request("/api/window", {**data, "runId": current["runId"], "variableId": item["id"], "offset": 0, "limit": 1})
        self.assertEqual(refreshed["outputDelta"], current["outputDelta"])
        self.assertEqual(refreshed["output"], current["output"])

    def test_swap_stop_restart_and_stale(self):
        source = (CPP_CASES / "swap.cpp").read_text(encoding="utf-8")
        first = self.start(source, standard="c++11")
        self.assertEqual(first["status"], "paused")
        current = self.command(first, "next")
        self.assertTrue(any(v["value"] == "9007199254740993" for v in current["variables"]))
        self.assertEqual(self.command(current, "stop")["status"], "stopped")
        fresh = self.start(source)
        self.assertNotEqual(first["runId"], fresh["runId"])
        self.assertEqual(self.command(first, "stop")["status"], "stale")
        result = self.finish(fresh)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"]["stdout"].strip(), "2 9007199254740993")

    def test_input_and_two_outputs(self):
        source = (CPP_CASES / "io.cpp").read_text(encoding="utf-8")
        result = self.finish(self.start(source, input="42\n"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual({k: v.replace("\r\n", "\n") for k, v in result["output"].items()},
                         {"stdout": "中文:42\n", "stderr": "error:42\n"})

    def test_compile_failure_runtime_and_recovery(self):
        broken = self.start("int main() {\n    int x = ;\n}\n")
        self.assertEqual(broken["status"], "compile_error")
        self.assertIn(":2:", broken["compile"]["stderr"])
        result = self.finish(self.start("int main() {\n    int *p = 0;\n    *p = 1;\n}\n"))
        self.assertEqual(result["status"], "runtime_error")
        self.assertEqual(self.finish(self.start("int main() {\n    return 0;\n}\n"))["status"], "completed")

    def test_pending_step_rejected_and_stop_interrupts(self):
        first = self.start("int main() {\n    while (true) { }\n}\n")
        with ThreadPoolExecutor(max_workers=2) as pool:
            motion = pool.submit(self.command, first, "next")
            entry = self.server.sessions.entry(self.identity)
            deadline = time.monotonic() + 3
            while not entry.lock.locked() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(entry.lock.locked())
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                self.command(first, "next")
            self.assertEqual(rejected.exception.code, 409)
            rejected.exception.close()
            stopped = self.command(first, "stop")
            self.assertEqual(stopped["status"], "stopped")
            self.assertEqual(motion.result()["status"], "stopped")
        self.assertIsNone(entry.session.transport)
        self.assertIsNone(entry.session.work)

    def test_timeout_and_close_cleanup(self):
        first = self.start("int main() {\n    while (true) { }\n}\n")
        entry = self.server.sessions.entry(self.identity)
        result = self.command(first, "next")
        self.assertEqual(result["status"], "timeout")
        self.request("/api/close", {"sessionId": self.identity})
        self.assertFalse(entry.directory.exists())
        self.assertNotIn(self.identity, self.server.sessions.entries)

    def test_validation_and_independent_tabs(self):
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.start("  ")
        rejected.exception.close()
        first = self.start("int main() {\n    return 0;\n}\n")
        other_id = uuid.uuid4().hex
        try:
            other = self.request("/api/start", {"sessionId": other_id, "source": "int main() {\n    return 0;\n}\n"})
            self.assertNotEqual(first["runId"], other["runId"])
            self.command(first, "stop")
            self.assertEqual(self.server.sessions.entry(other_id).session.status, "paused")
        finally:
            self.server.sessions.remove(other_id)

    def test_service_close_releases_active_debugger(self):
        service = LabServer(("127.0.0.1", 0))
        identity = uuid.uuid4().hex
        try:
            snapshot = service.sessions.start({"sessionId": identity, "source": "int main() {\n    return 0;\n}\n"})
            self.assertEqual(snapshot["status"], "paused")
            session = service.sessions.entry(identity).session
            process = session.transport.controller.gdb_process
            directory = session.work
        finally:
            service.server_close()
        self.assertIsNotNone(process.poll())
        self.assertFalse(directory.exists())
        self.assertFalse(Path(service.sessions.directory.name).exists())


if __name__ == "__main__":
    ensure_dependencies()
    unittest.main(verbosity=2)
