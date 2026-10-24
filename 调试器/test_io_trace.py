"""真实 GCC/GDB：字符消费、缓冲输出与混合标准 IO。"""
from pathlib import Path
import tempfile
import unittest

from session import DebugSession


class IOTraceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="code-lab-io-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def create(self, code, data=b""):
        source, input_path = self.root / "source.cpp", self.root / "input.txt"
        source.write_text(code, encoding="utf-8")
        input_path.write_bytes(data)
        session = DebugSession(source, input_path, log_root=self.root / "logs")
        self.addCleanup(session.close)
        first = session.start()
        self.assertEqual(first["status"], "paused", first)
        self.assertEqual(first["inputTrace"]["consumed"], 0)
        return session

    def at(self, session, marker):
        line = next(index for index, text in enumerate(session.source.read_text(encoding="utf-8").splitlines(), 1)
                    if "@" + marker in text)
        for _ in range(80):
            current = session.history[-1]
            if current["line"] == line:
                return current
            current = session.execute("next")
            self.assertEqual(current["status"], "paused", current)
        self.fail(marker)

    def assert_consumed(self, snapshot, consumed, start):
        self.assertEqual(snapshot["inputTrace"], {"state": "ok", "consumed": consumed,
                                                "deltaStart": start, "deltaEnd": consumed})

    def test_cpp_utf8_line_get_putback_and_eof(self):
        for synchronize in (True, False):
            with self.subTest(synchronize=synchronize):
                session = self.create('''#include <iostream>
#include <string>
int main() {
    std::ios::sync_with_stdio(%s);
    int n; // n 整数
    std::cin >> n;
    std::string s; // s 文本；@number
    std::getline(std::cin, s);
    std::getline(std::cin, s); // @newline
    char c; // c 字符
    std::cin.get(c); // @line
    std::cin.unget(); // @get
    std::cin.get(c); // @putback
    std::cin.get(c); // @again
    return 0; // @eof
}
''' % ("true" if synchronize else "false"), "12\n中文\nZ".encode("utf-8"))
                self.assert_consumed(self.at(session, "number"), 2, 0)
                self.assert_consumed(self.at(session, "newline"), 3, 2)
                self.assertEqual(self.at(session, "line")["inputTrace"]["consumed"], 10)
                self.assert_consumed(self.at(session, "get"), 11, 10)
                self.assert_consumed(self.at(session, "putback"), 10, 11)
                self.assert_consumed(self.at(session, "again"), 11, 10)
                self.assert_consumed(self.at(session, "eof"), 11, 11)
                session.close()

    def test_array_reads_are_logical_and_failed_extraction_keeps_character(self):
        session = self.create('''#include <iostream>
int main() {
    int a[3] = {}; // a 数组
    for (int i = 0; i < 3; ++i) { // i 下标
        std::cin >> a[i];
    }
    int n; // n 整数
    std::cin >> n; // @done
    std::cin.clear(); // @failed
    char c; // c 字符
    std::cin.get(c);
    return 0; // @get
}
''', b"1 2 3 x")
        self.assertEqual(self.at(session, "done")["inputTrace"]["consumed"], 5)
        self.assertEqual({step["inputTrace"]["consumed"] for step in session.history}, {0, 1, 3, 5})
        current = session.history[-1]
        array = next(item for item in current["variables"] if item["name"] == "a")
        refreshed = session.window(current["runId"], array["id"], 0, 2)
        self.assertEqual(refreshed["inputTrace"], current["inputTrace"])
        self.assertEqual(refreshed["motion"], current["motion"])
        self.assert_consumed(self.at(session, "failed"), 6, 5)
        self.assert_consumed(self.at(session, "get"), 7, 6)

    def test_c_stdio_consumption_including_crlf(self):
        session = self.create('''#include <cstdio>
int main() {
    int n; // n 整数
    std::scanf("%d", &n);
    int c = std::getchar(); // c 字符；@number
    char a[8] = {}; // a 字符数组；@character
    std::fgets(a, 8, stdin);
    std::fread(a, 1, 8, stdin); // @line
    return 0; // @eof
}
''', b" 42 x\r\n")
        self.assert_consumed(self.at(session, "number"), 3, 0)
        self.assert_consumed(self.at(session, "character"), 4, 3)
        self.assertEqual(self.at(session, "line")["inputTrace"]["consumed"], 7)
        self.assert_consumed(self.at(session, "eof"), 7, 7)

    def test_cpp_output_is_visible_without_flushing_and_not_duplicated(self):
        session = self.create('''#include <iostream>
int main() {
    std::ios::sync_with_stdio(false);
    std::cout << "中文";
    std::cout << 'A'; // @first
    std::cout << '\\n'; // @second
    return 0; // @third
}
''')
        self.assertEqual(self.at(session, "first")["outputDelta"]["stdout"], "中文")
        self.assertEqual(self.at(session, "second")["outputDelta"]["stdout"], "A")
        self.assertEqual(self.at(session, "third")["output"]["stdout"].replace("\r\n", "\n"), "中文A\n")
        completed = session.execute("continue")
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["outputDelta"]["stdout"], "")

    def test_mixed_c_cpp_output_preserves_final_text(self):
        session = self.create('''#include <iostream>
#include <cstdio>
int main() {
    std::cout << "A";
    std::printf("B");
    std::cout << "C";
    std::fflush(stdout);
    return 0;
}
''')
        for _ in range(20):
            snapshot = session.execute("next")
            if snapshot["status"] != "paused":
                break
        self.assertEqual(snapshot["status"], "completed")
        self.assertEqual(snapshot["output"]["stdout"], "ABC")

    def test_replaced_input_buffer_is_unavailable(self):
        session = self.create('''#include <iostream>
#include <sstream>
int main() {
    std::istringstream s("9"); // s 临时输入流
    std::cin.rdbuf(s.rdbuf());
    int n; // n 整数
    std::cin >> n; // @replaced
    return 0;
}
''', b"123")
        trace = self.at(session, "replaced")["inputTrace"]
        self.assertEqual(trace["state"], "unavailable")
        self.assertEqual(trace["consumed"], 0)

    def test_unsynchronized_mixed_output_uses_real_final_order(self):
        session = self.create('''#include <iostream>
#include <cstdio>
int main() {
    std::ios::sync_with_stdio(false);
    std::cout << "A";
    std::printf("B"); // @first
    std::fflush(stdout);
    std::cout << "C";
    std::cout.flush();
    return 0;
}
''')
        self.assertEqual(self.at(session, "first")["output"]["stdout"], "A")
        completed = session.execute("continue")
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["output"]["stdout"], "BAC")
        self.assertEqual(completed["outputDelta"]["stdout"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
