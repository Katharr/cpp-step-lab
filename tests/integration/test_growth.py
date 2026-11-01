"""真实 GCC/GDB：长度变化、新增格子、窗口刷新和历史快照。"""
import unittest

from tests.integration import test_structures
from tests.integration.test_session import variable


class GrowthTests(unittest.TestCase):
    setUp = test_structures.StructureTests.setUp
    start = test_structures.StructureTests.start
    until = test_structures.StructureTests.until

    def test_string_swap_and_history(self):
        for first, second in (("123", "6666"), ("666", "6666"),
                              ("12", "34"), ("", "6666"), ("", "")):
            with self.subTest(first=first, second=second):
                session = self.start('''#include <string>
#include <utility>
int main() {
    std::string a = "''' + first + '''"; // a：第一个字符串
    std::string b = "''' + second + '''"; // b：第二个字符串
    std::swap(a, b);
    int n = 0; // n：暂停位置
    return n;
}
''')
                self.until(session, "std::swap")
                current = session.execute("next")
                for name, before, after in (("a", first, second), ("b", second, first)):
                    data = variable(current, name)["data"]
                    self.assertEqual(data["total"], len(after))
                    self.assertEqual([e["index"] for e in data["elements"] if e["added"]],
                                     list(range(len(before), len(after))))
                    self.assertEqual([e["index"] for e in data["elements"] if e["changed"]],
                                     [i for i in range(min(len(before), len(after))) if before[i] != after[i]])
                    self.assertTrue(all(e["previousValue"] is None for e in data["elements"] if e["added"]))
                refreshed = session.window(session.run_id, variable(current, "a")["id"], 0, 50)
                self.assertEqual(variable(refreshed, "a")["data"]["elements"], variable(current, "a")["data"]["elements"])
                following = session.execute("next")
                self.assertFalse(any(e["added"] for e in variable(following, "a")["data"]["elements"]))
                self.assertEqual(session.history[current["step"]], refreshed)
                session.close()

    def test_growth_outside_previous_window(self):
        session = self.start('''#include <string>
int main() {
    std::string a(80, '6'); // a：超出读取窗口的字符串
    a += "6666666666";
    int n = 0; // n：暂停位置
    return n;
}
''')
        self.until(session, 'a +=')
        current = session.execute("next")
        identity = variable(current, "a")["id"]
        current = session.window(session.run_id, identity, 75, 15)
        elements = variable(current, "a")["data"]["elements"]
        self.assertEqual([e["index"] for e in elements if e["added"]], list(range(80, 90)))
        self.assertFalse(any(e["changed"] for e in elements))
        current = session.execute("next")
        current = session.window(session.run_id, identity, 50, 20)
        self.assertFalse(any(e["added"] or e["changed"] for e in variable(current, "a")["data"]["elements"]))

    def test_vector_append_and_initial_construction(self):
        session = self.start('''#include <vector>
int main() {
    std::vector<int> a = {3, 1}; // a：可增长序列
    a.push_back(4);
    int n = 0; // n：暂停位置
    return n;
}
''')
        before = self.until(session, "a.push_back")
        self.assertFalse(any(e["added"] for e in variable(before, "a")["data"]["elements"]))
        current = session.execute("next")
        elements = variable(current, "a")["data"]["elements"]
        self.assertEqual([(e["index"], e["value"]) for e in elements if e["added"]], [(2, "4")])
        self.assertFalse(any(e["changed"] for e in elements))


if __name__ == "__main__":
    unittest.main(verbosity=2)
