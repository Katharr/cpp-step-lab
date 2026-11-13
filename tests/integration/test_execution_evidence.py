"""真实检查点驱动的整步验收：源码位置、有效值、访问和历史一同核对。"""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from code_lab.debugger.session import DebugSession
from tests.integration.test_session import variable


class ExecutionEvidenceTests(unittest.TestCase):
    def start(self, code, standard="c++14"):
        directory = tempfile.TemporaryDirectory(prefix="code-lab-evidence-")
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "case.cpp"
        path.write_text(code, encoding="utf-8")
        session = DebugSession(path, standard=standard, log_root=path.parent / "logs")
        self.addCleanup(session.close)
        self.assertEqual(session.start()["status"], "paused", session.history)
        return session

    def until(self, session, line, motion="next"):
        for _ in range(150):
            current = session.history[-1]
            if current["line"] == line:
                return current
            self.assertEqual(current["status"], "paused", current)
            session.execute(motion)
        self.fail(f"没有到达第 {line} 行")

    def test_loop_initialization_is_runtime_evidence_in_both_standards(self):
        code = '''#include <iostream>
int main() {
    int i, j; // i：外层计数；j：内层计数
    for (i = 1; i < 5; i++) {
        for (j = 1; j < i + 1; j++) {
            if (i * j % 10 == 0) {
                break;
            }
        }
        if (j >= i + 1) {
            std::cout << i * j << "#";
        }
    }
    std::cout << i * j;
    return 0;
}
'''
        for standard in ("c++11", "c++14"):
            with self.subTest(standard=standard):
                session = self.start(code, standard)
                final = self.until(session, 15)
                self.assertEqual((variable(final, "i")["value"], variable(final, "j")["value"]), ("5", "5"))
                self.assertEqual(final["output"]["stdout"], "2#6#12#20#25")
                self.assertEqual(final["execution"]["evidence"], "runtime-checkpoints")
                self.assertTrue(all(step["execution"]["spans"] or step["step"] == 0 for step in session.history))
                session.close()

    def test_loop_array_update_and_same_value_write_share_the_step(self):
        session = self.start('''int main() {
    int a[1] = {0}; // a：累加数组
    for (int i = 0; i < 2; a[0]++) { // i：循环计数
        i++;
    }
    a[0] = a[0];
    return 0;
}
''')
        self.until(session, 7)
        updates = []
        same = None
        for step in session.history:
            if not step["execution"]["spans"]:
                continue
            span = step["execution"]["spans"][-1]
            if span["kind"] == "update":
                item = variable(step, "a")
                self.assertTrue(item["data"]["elements"][0]["changed"])
                self.assertEqual(step["arrayAccess"]["writes"], [{"variableId": item["id"], "coordinates": [0]}])
                self.assertEqual(step["arrayAccess"]["line"], span["line"])
                updates.append(item["data"]["elements"][0]["value"])
            if span["line"] == 6:
                same = step
        self.assertEqual(updates, ["1", "2"])
        self.assertFalse(variable(same, "a")["changed"])
        self.assertTrue(same["arrayAccess"]["writes"])

    def test_multiline_function_return_reference_and_finish(self):
        code = '''int f(int &x) { // x：引用参数
    x = 9;
    return x;
}
int main() {
    int a = 1; // a：被修改的值
    int t =
        f(a); // t：函数返回值
    int s = t; int q = s; // s：副本；q：第二副本
    return q;
}
'''
        for motion in ("next", "step"):
            with self.subTest(motion=motion):
                session = self.start(code)
                self.until(session, 7)
                if motion == "step":
                    entered = session.execute("step")
                    self.assertEqual(entered["frames"][0]["function"], "f")
                    self.assertNotEqual(variable(entered, "t", frame=1)["state"], "ok")
                    session.execute("finish")
                final = self.until(session, 10, motion=motion)
                self.assertEqual([variable(final, name)["value"] for name in ("a", "t", "s", "q")], ["9"] * 4)
                session.close()

    def test_window_refresh_does_not_reinterpret_execution_or_mutate_prior_history(self):
        session = self.start('''int main() {
    int a[120] = {}; // a：分窗口数组
    a[80] = 7;
    return 0;
}
''')
        before = self.until(session, 3)
        saved = deepcopy(before)
        after = session.execute("next")
        identity = variable(after, "a")["id"]
        known = deepcopy(session.builder.initialization.known)
        execution = deepcopy(after["execution"])
        count = len(session.history)
        for offset in (70, 0, 70):
            current = session.window(session.run_id, identity, offset, 20)
            self.assertEqual(current["execution"], execution)
            self.assertEqual(current["step"], after["step"])
            self.assertEqual(session.builder.initialization.known, known)
            self.assertEqual(len(session.history), count)
        self.assertEqual(session.history[before["step"]], saved)
        self.assertIn("80", current["observations"][identity])

    def test_normal_completion_and_stop_preserve_last_observation(self):
        code = '''int main() {
    int a[1] = {7}; // a：最后观测的数组
    return 0;
}
'''
        for command in ("next", "stop"):
            with self.subTest(command=command):
                session = self.start(code)
                self.until(session, 3)
                snapshot = session.execute(command)
                self.assertEqual(snapshot["status"], "completed" if command == "next" else "stopped")
                self.assertIsNone(snapshot["line"])
                self.assertEqual(variable(snapshot, "a")["data"]["elements"][0]["value"], "7")
                if command == "stop":
                    self.assertEqual(snapshot["execution"]["spans"], [])
                session.close()

    def test_reference_proof_tracks_individual_array_elements(self):
        session = self.start('''int f(int &x) { // x：引用参数
    return x;
}
int main() {
    int a[2]; // a：部分赋值的数组
    a[1] = 7;
    int t = f(a[1]); // t：已初始化元素的副本
    int q = f(a[0]); // q：未初始化元素的副本
    return 0;
}
''')
        final = self.until(session, 9)
        self.assertEqual(variable(final, "t")["value"], "7")
        self.assertNotEqual(variable(final, "q")["state"], "ok")
        self.assertIsNone(variable(final, "q")["value"])
        elements = variable(final, "a")["data"]["elements"]
        self.assertEqual(elements[0]["state"], "uninitialized")
        self.assertIsNone(elements[0]["value"])
        self.assertEqual(elements[1]["value"], "7")

    def test_fault_captures_scene_and_never_completes_failed_assignment(self):
        session = self.start('''int main() {
    int a = 7; // a：故障前的可信值
    int *p = 0; // p：空指针
    a = *p;
    return 0;
}
''')
        self.until(session, 4)
        snapshot = session.execute("next")
        self.assertEqual(snapshot["status"], "runtime_error")
        self.assertIsNone(snapshot["line"])
        self.assertEqual(variable(snapshot, "a")["value"], "7")
        self.assertFalse(any(span["line"] == 4 for span in snapshot["execution"]["spans"]))
        self.assertEqual(snapshot["execution"]["stateOrigin"], "fault-stop")

    def test_short_circuit_does_not_confirm_unexecuted_write(self):
        session = self.start('''int main() {
    int a; // a：短路右侧未执行
    false && (a = 7);
    return 0;
}
''')
        final = self.until(session, 4)
        self.assertNotEqual(variable(final, "a")["state"], "ok")
        self.assertIsNone(variable(final, "a")["value"])
