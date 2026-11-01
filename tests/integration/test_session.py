"""Spec 02 验收：真实 GCC/GDB 集成测试 + 不可信数值屏蔽回归。"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from code_lab.debugger.session import DebugSession, MIError
from code_lab.paths import ROOT
from tests.support.paths import CPP_CASES


def marker(case, name):
    return next(index for index, line in enumerate((CPP_CASES / f"{case}.cpp").read_text(encoding="utf-8").splitlines(), 1)
                if re.search(r"@" + re.escape(name) + r"(?:\s|$)", line))


def variable(snapshot, name, frame=0, declaration=None):
    return next(item for item in snapshot["variables"] if item["name"] == name and item["frame"] == frame
                and (declaration is None or item["declaration"] == declaration)
                and item["state"] != "out_of_scope")


class DebugIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="code-lab-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def session(self, case="scope", code=None, **kwargs):
        source = CPP_CASES / f"{case}.cpp"
        if code is not None:
            source = self.root / f"{case}.cpp"
            source.write_text(code, encoding="utf-8")
        session = DebugSession(source, log_root=self.root / "logs", **kwargs)
        self.addCleanup(session.close)
        return session

    def until(self, session, line, command="next", budget=60):
        for _ in range(budget):
            current = session.history[-1]
            if current["line"] == line and current["status"] == "paused":
                return current
            snapshot = session.execute(command)
            self.assertEqual(snapshot["status"], "paused", snapshot)
        self.fail(f"未到达源码第 {line} 行")

    def test_scope_lifetime_shadow_and_diff(self):
        session = self.session()
        first = session.start()
        self.assertEqual(first["line"], marker("scope", "outer_declare"))
        self.assertEqual(first["status"], "paused")
        self.assertTrue(all(item["value"] is None for item in first["variables"] if item["kind"] == "local"))
        snapshot = self.until(session, marker("scope", "uninitialized"))
        self.assertEqual(variable(snapshot, "x")["state"], "uninitialized")
        self.assertIsNone(variable(snapshot, "x")["value"])
        self.assertEqual(variable(snapshot, "s")["value"], "7")
        snapshot = session.execute("next")
        self.assertTrue(variable(snapshot, "s")["changed"])
        self.assertEqual(variable(snapshot, "s")["previousValue"], "7")
        snapshot = self.until(session, marker("scope", "inner"))
        inner = variable(snapshot, "s", declaration=marker("scope", "inner_declare"))
        outer = variable(snapshot, "s", declaration=marker("scope", "outer_declare"))
        self.assertEqual((inner["value"], outer["value"]), ("9", "8"))
        self.assertTrue(inner["visible"])
        self.assertTrue(outer["shadowed"])
        self.assertNotEqual(inner["id"], outer["id"])
        snapshot = self.until(session, marker("scope", "left"))
        self.assertEqual(variable(snapshot, "s")["id"], outer["id"])
        self.assertTrue(any(item["id"] == inner["id"] and item["state"] == "out_of_scope" for item in snapshot["variables"]))
        # 未知符号产生真实 MI 错误，后续仍能继续单步。
        with self.assertRaises(MIError):
            session.transport.command('-data-evaluate-expression "z"')
        self.assertEqual(session.execute("next")["status"], "paused")
        work, process, log = session.work, session.transport.controller.gdb_process, session.log_dir
        session.execute("stop")
        self.assertFalse(work.exists())
        self.assertIsNotNone(process.poll())
        self.assertTrue((log / "stdout.mi").is_file())
        self.assertTrue((log / "raw-states.jsonl").is_file())

    def test_swap_64_bit_and_output_position(self):
        session = self.session("swap")
        session.start()
        snapshot = self.until(session, marker("swap", "print"))
        self.assertEqual(variable(snapshot, "x")["value"], "2")
        self.assertEqual(variable(snapshot, "s")["value"], "9007199254740993")
        self.assertEqual(snapshot["output"]["stdout"], "")
        snapshot = self.until(session, marker("swap", "done"))
        self.assertEqual(snapshot["output"]["stdout"].strip(), "2 9007199254740993")
        self.assertEqual(sum(bool(step["outputDelta"]["stdout"]) for step in session.history), 1)
        self.assertEqual(session.history[0]["output"]["stdout"], "")

    def test_input_values_and_copies_are_confirmed(self):
        code = '''#include <iostream>
using namespace std;
int main() {
    int n, q; // n：输入数量；q：查询数量
    cin >> n >> q;
    int t = n; // t：输入值的副本
    int s; // s：第二个副本
    s = t + q;
    cout << s << endl;
    return 0;
}
'''
        input_path = self.root / "input.txt"
        input_path.write_text("12 7", encoding="utf-8")
        session = self.session(code=code, input_path=input_path)
        session.start()
        snapshot = self.until(session, 6)
        self.assertEqual((variable(snapshot, "n")["value"], variable(snapshot, "q")["value"]), ("12", "7"))
        snapshot = self.until(session, 9)
        self.assertEqual(variable(snapshot, "t")["value"], "12")
        self.assertEqual(variable(snapshot, "s")["value"], "19")

    def test_window_max_array_reads_are_confirmed(self):
        for text, expected, updates in (("5 2\n3 1 4 2 5\n", "7", ["3", "4", "5", "6", "7"]),
                                         ("3 2\n-8 3 -2\n", "1", ["-8", "-5", "1"])):
            with self.subTest(input=text):
                input_path = self.root / "input.txt"
                input_path.write_text(text, encoding="utf-8")
                session = self.session("window_max", input_path=input_path)
                session.start()
                snapshot = self.until(session, marker("window_max", "print"), budget=120)
                self.assertEqual(variable(snapshot, "mx")["value"], expected)
                observed = []
                for step in session.history:
                    for item in step["variables"]:
                        if item["name"] == "mx" and item["visible"]:
                            self.assertEqual(item["state"], "ok", (step["line"], item))
                            if not observed or observed[-1] != item["value"]:
                                observed.append(item["value"])
                        if item["name"] == "t" and item["declaration"] == 17 and item["visible"]:
                            self.assertEqual(item["state"], "ok", (step["line"], item))
                self.assertEqual(observed, updates)
                work, process = session.work, session.transport.controller.gdb_process
                result = session.execute("continue")
                self.assertEqual(result["output"]["stdout"].strip(), expected)
                session.close()
                if work:
                    self.assertFalse(work.exists())
                self.assertIsNotNone(process.poll())

    def test_failed_input_does_not_confirm_unwritten_values(self):
        code = '''#include <iostream>
int main() {
    int n, q; // n：首个输入；q：第二个输入
    std::cin >> n >> q;
    int t = q; // t：未成功输入的副本
    std::cout << n;
    return 0;
}
'''
        for text in ("bad", "12"):
            with self.subTest(input=text):
                input_path = self.root / "input.txt"
                input_path.write_text(text, encoding="utf-8")
                session = self.session(code=code, input_path=input_path)
                session.start()
                snapshot = self.until(session, 6)
                for name in ("q", "t"):
                    self.assertNotEqual(variable(snapshot, name)["state"], "ok")
                    self.assertIsNone(variable(snapshot, name)["value"])
                session.close()

    def test_standard_min_max_initialization_assignment_and_history(self):
        for standard, motion in (("c++11", "next"), ("c++14", "next"), ("c++14", "step")):
            with self.subTest(standard=standard, motion=motion):
                session = self.session("min_max", standard=standard)
                session.start()
                snapshot = self.until(session, 7, command=motion)
                self.assertFalse(any(item["visible"] for item in snapshot["variables"] if item["name"] == "mx"))
                snapshot = self.until(session, 8, command=motion)
                confirmed = snapshot
                self.assertEqual((variable(snapshot, "mx")["state"], variable(snapshot, "mx")["value"]), ("ok", "7"))
                snapshot = self.until(session, 10, command=motion)
                self.assertEqual(variable(snapshot, "mx")["value"], "9")
                self.assertEqual(variable(snapshot, "mx")["previousValue"], "7")
                self.assertEqual(variable(snapshot, "mn")["value"], "3")
                self.assertEqual(variable(confirmed, "mx")["value"], "7")
                self.assertEqual(session.execute("continue")["output"]["stdout"].strip(), "9 3")
                session.close()

    def test_common_function_results_with_real_gdb(self):
        source = (CPP_CASES / "common_functions.cpp").read_text(encoding="utf-8").splitlines()
        for standard in ("c++11", "c++14"):
            with self.subTest(standard=standard):
                session = self.session("common_functions", standard=standard)
                session.start()
                for line, text in enumerate(source, 1):
                    match = re.search(r"@expect (-?\d+)", text)
                    if match:
                        self.until(session, line)
                        snapshot = session.execute("next")
                        item = variable(snapshot, "r")
                        self.assertEqual((item["state"], item["value"]), ("ok", match[1]), text)
                self.assertEqual(session.execute("continue")["output"]["stdout"].strip(), "3")
                session.close()

    def test_array_loop_and_loop_scope_exit(self):
        session = self.session("array")
        session.start()
        for _ in range(30):
            snapshot = session.execute("next")
            if snapshot["line"] == marker("array", "print"):
                break
            self.assertEqual(snapshot["status"], "paused", snapshot)
        self.assertEqual(variable(snapshot, "s")["value"], "10")
        self.assertEqual([item["value"] for item in variable(snapshot, "a")["data"]["elements"]], ["3", "1", "4", "2"])
        self.assertTrue(any(item["name"] == "i" and item["state"] == "out_of_scope" for item in snapshot["variables"]))
        visits = [variable(step, "i")["value"] for step in session.history if step["line"] == marker("array", "add")]
        self.assertEqual(visits, ["0", "1", "2", "3"])

    def test_recursion_frames_and_finish(self):
        session = self.session("frames")
        session.start()
        for _ in range(30):
            snapshot = session.execute("step")
            if len(snapshot["frames"]) == 4:
                break
            self.assertEqual(snapshot["status"], "paused", snapshot)
        self.assertEqual([frame["function"] for frame in snapshot["frames"]], ["f", "f", "f", "main"])
        self.assertEqual([variable(snapshot, "x", frame)["value"] for frame in range(4)], ["1", "2", "3", "40"])
        self.assertEqual(len({variable(snapshot, "x", frame)["id"] for frame in range(4)}), 4)
        self.assertFalse(any(item["visible"] for item in snapshot["variables"] if item["frame"] not in (0, None)))
        caller_id = snapshot["frames"][1]["id"]
        snapshot = session.execute("finish")
        self.assertEqual(snapshot["status"], "paused", snapshot)
        self.assertEqual(snapshot["frames"][0]["id"], caller_id)
        self.assertEqual(variable(snapshot, "x")["value"], "2")
        self.assertEqual(session.execute("continue")["status"], "completed")

    def test_utf8_stdin_stdout_stderr_and_no_duplicates(self):
        session = self.session("io", input_path=CPP_CASES / "io.in")
        session.start()
        snapshot = self.until(session, marker("io", "flushed"))
        self.assertEqual(snapshot["output"]["stdout"].strip(), "中文:42")
        self.assertEqual(snapshot["output"]["stderr"].strip(), "error:42")
        self.assertEqual(session.execute("next")["outputDelta"], {"stdout": "", "stderr": ""})

    def test_step_into_library_keeps_execution_paused(self):
        session = self.session("io", input_path=CPP_CASES / "io.in")
        session.start()
        self.until(session, marker("io", "print"))
        snapshot = session.execute("step")
        self.assertEqual(snapshot["status"], "paused", snapshot)
        self.assertEqual(snapshot["output"]["stderr"], "")

    def test_stop_while_running_restart_and_stale_commands(self):
        session = self.session(code="int main() {\n    while (true) {\n    }\n}\n", timeout=10)
        first = session.start()
        work = session.work
        process = session.transport.controller.gdb_process
        with ThreadPoolExecutor(max_workers=2) as executor:
            motion = executor.submit(session.execute, "continue", first["runId"])
            # 等待实际命令发出，避免把排队状态当作执行中。
            deadline = time.monotonic() + 3
            while "-exec-continue" not in (work / "commands.txt").read_text(encoding="utf-8"):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            stopped = executor.submit(session.execute, "stop", first["runId"])
            self.assertEqual(motion.result(timeout=5)["status"], "stopped")
            self.assertEqual(stopped.result(timeout=5)["status"], "stopped")
        self.assertFalse(work.exists())
        self.assertIsNotNone(process.poll())
        new = session.execute("restart")
        self.assertEqual(new["step"], 0)
        self.assertNotEqual(first["runId"], new["runId"])
        self.assertEqual(session.execute("next", first["runId"])["status"], "stale")
        self.assertEqual(session.execute("stop", first["runId"])["status"], "stale")
        self.assertFalse(session.cancelled.is_set())
        self.assertEqual(session.status, "paused")
        self.assertEqual(len(session.history), 1)

    def test_concurrent_steps_are_serialized(self):
        session = self.session("swap")
        session.start()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: session.execute("next"), range(2)))
        self.assertEqual(sorted(result["step"] for result in results), [1, 2])
        self.assertEqual([step["step"] for step in session.history], [0, 1, 2])

    def test_restart_interrupts_current_execution(self):
        session = self.session(code="int main() {\n    while (true) {\n    }\n}\n", timeout=10)
        old = session.start()
        work = session.work
        with ThreadPoolExecutor(max_workers=2) as executor:
            motion = executor.submit(session.execute, "continue", old["runId"])
            deadline = time.monotonic() + 3
            while "-exec-continue" not in (work / "commands.txt").read_text(encoding="utf-8"):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            restarted = executor.submit(session.execute, "restart", old["runId"])
            self.assertEqual(motion.result(timeout=5)["status"], "stopped")
            fresh = restarted.result(timeout=5)
        self.assertEqual(fresh["status"], "paused", fresh)
        self.assertNotEqual(fresh["runId"], old["runId"])
        self.assertFalse(work.exists())
        self.assertEqual(len(session.history), 1)

    def test_static_zero_initialization(self):
        session = self.session(code="int main() {\n    static int x; // x = 静态整数\n    x += 1;\n    return 0;\n}\n")
        snapshot = session.start()
        self.assertEqual(variable(snapshot, "x")["value"], "0")
        snapshot = session.execute("next")
        self.assertEqual(variable(snapshot, "x")["value"], "1")

    def test_split_utf8_output_is_decoded_once(self):
        session = self.session()
        session.status = "paused"
        session.work = self.root / "output"
        session.work.mkdir()
        path = session.work / "stdout.txt"
        data = "中文".encode("utf-8")
        path.write_bytes(data[:2])
        output, delta = session._output()
        self.assertEqual(output["stdout"], "")
        self.assertEqual(delta["stdout"], "")
        with path.open("ab") as handle:
            handle.write(data[2:])
        output, delta = session._output()
        self.assertEqual(output["stdout"], "中文")
        self.assertEqual(delta["stdout"], "中文")

    def test_short_lived_excessive_output_is_not_completed(self):
        session = self.session(code='#include <cstdio>\nint main() {\n    for (int i = 0; i < 1000; i++) { // i = 输出次数\n        std::puts("0123456789");\n    }\n}\n', output_limit=1024)
        self.assertEqual(session.start()["status"], "paused")
        self.assertEqual(session.execute("continue")["status"], "output_limit")

    def test_limits_compilation_errors_and_recovery(self):
        timeout = self.session(code="int main() {\n    while (true) {\n    }\n}\n", timeout=0.4)
        timeout.start()
        self.assertEqual(timeout.execute("continue")["status"], "timeout")
        self.assertIsNone(timeout.work)
        limited = self.session("loud", code='#include <cstdio>\nint main() {\n while (true) {\n std::puts("0123456789");\n }\n}\n', output_limit=1024)
        limited.start()
        result = limited.execute("continue")
        self.assertEqual(result["status"], "output_limit")
        self.assertLessEqual(len(result["output"]["stdout"].encode()), 1024)
        bad = self.session("bad", code="int main( {\n")
        result = bad.start()
        self.assertEqual(result["status"], "compile_error")
        self.assertTrue(result["compile"]["stderr"])
        self.assertIsNone(bad.work)
        bad.source.write_text("int main() {\n    return 0;\n}\n", encoding="utf-8")
        self.assertEqual(bad.execute("restart")["status"], "paused")
        bounded = self.session(max_steps=2)
        bounded.start()
        self.assertEqual(bounded.execute("next")["status"], "step_limit")

    def test_runtime_failure_and_cpp11(self):
        broken = self.session(code="int main() {\n    int *p = 0; // p = 空指针\n    *p = 1;\n}\n")
        broken.start()
        self.assertEqual(broken.execute("continue")["status"], "runtime_error")
        session = self.session("swap", standard="c++11")
        session.start()
        result = session.execute("continue")
        self.assertEqual(result["status"], "completed")
        self.assertIn("9007199254740993", result["output"]["stdout"])

    def test_cli_from_chinese_directory(self):
        directory = self.root / "中文启动目录"
        directory.mkdir()
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ROOT / "src")
        process = subprocess.Popen([sys.executable, "-m", "code_lab.debugger.session", "--source", str(CPP_CASES / "scope.cpp"),
                                    "--log-root", str(self.root / "cli-logs")],
                                   cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8")
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        rows = [json.loads(process.stdout.readline())]
        for command in ("next", "stop", "restart", "next", "stop"):
            process.stdin.write(command + "\n")
            process.stdin.flush()
            rows.append(json.loads(process.stdout.readline()))
        process.stdin.close()
        self.assertEqual(process.wait(timeout=10), 0, process.stderr.read())
        for stream in (process.stdout, process.stderr):
            stream.close()
        self.assertEqual([row["status"] for row in rows], ["paused", "paused", "stopped", "paused", "paused", "stopped"])
        self.assertNotEqual(rows[0]["runId"], rows[3]["runId"])




if __name__ == "__main__":
    unittest.main(verbosity=2)
