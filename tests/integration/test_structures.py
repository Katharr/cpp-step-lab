"""Spec 04：真实 GCC/GDB 数据视图验收；窗口刷新不执行程序。"""
from pathlib import Path
import sys
import tempfile
import unittest

from code_lab.debugger.session import DebugSession
from code_lab.snapshots.builder import SnapshotBuilder
from tests.integration.test_session import variable


class StructureTests(unittest.TestCase):
    def test_if_comparison_reads_only_condition_and_restores_history(self):
        session = self.start('''int main() {
    int a[4] = {0, 2, 2, 0}; // a：测试数组
    int i = 2; // i：比较值
    int j = 1; // j：下标
    int s = 0; // s：结果
    if (a[j] == i) {
        s = a[3];
    }
    if (a[j] != i) {
        s = a[0];
    }
    if (a[j] == a[j+1]) {
        s = 1;
    }
    if (a[0] && a[2]) {
        s = 2;
    }
    if (a[1] || a[3]) {
        s = 3;
    }
    if (a[j++] == i) {
        s = 4;
    }
    while (a[0] != 0) {
        s = a[3];
    }
    return s;
}
''')
        saved = None
        for text, indices in (('if (a[j] == i)', [1]), ('if (a[j] != i)', [1]),
                              ('if (a[j] == a[j+1])', [1, 2]), ('if (a[0] &&', [0]),
                              ('if (a[1] ||', [1]), ('if (a[j++]', []), ('while (a[0]', [0])):
            before = self.until(session, text)
            current = session.execute('next')
            expected = {'line': before['line'] if indices else None,
                        'reads': [{'variableId': variable(before, 'a')['id'], 'coordinates': [i]} for i in indices],
                        'writes': []}
            self.assertEqual(current['arrayAccess'], expected)
            if saved is None:
                saved = current
                refreshed = session.window(session.run_id, variable(current, 'a')['id'], 0, 4)
                self.assertEqual(refreshed['arrayAccess'], expected)
        self.assertEqual(session.history[saved['step']]['arrayAccess'], saved['arrayAccess'])

    def test_conditional_accumulation_reads_prefix_array(self):
        self.assert_prefix_accumulation('b[i]>0 ? b[i] : (-1)*b[i]', 'reads')

    def test_function_accumulation_uses_prefix_array(self):
        self.assert_prefix_accumulation('abs(b[i])', 'uses')

    def assert_prefix_accumulation(self, expression, access_kind):
        input_path = self.root / 'input.txt'
        input_path.write_text('6\n3 -5 2 0 4 -9\n', encoding='utf-8')
        session = self.start('''#include<bits/stdc++.h>
using namespace std;
int a[100005], b[100005]; // a：输入数组；b：前缀和
int main() {
    int n; // n：元素数量
    cin >> n;
    for(int i=1; i<=n; i++) { // i：输入下标
        cin >> a[i];
    }
    for(int i=2; i<=n; i++) { // i：前缀和下标
        b[i] = b[i-1] + a[i-1];
    }
    long long s = 0; // s：绝对值之和
    for(int i=2; i<=n; i++) { // i：累加下标
        s += ''' + expression + ''';
    }
    cout << s;
    return 0;
}
''', input_path=input_path)
        for index, expected_sum in zip(range(2, 7), (3, 5, 5, 5, 9)):
            before = self.until(session, 's +=')
            current = session.execute('next')
            b = variable(current, 'b', None)
            expected = {'line': before['line'], 'reads': [], 'writes': []}
            expected[access_kind] = [{'variableId': b['id'], 'coordinates': [index]}]
            self.assertEqual(current['arrayAccess'], expected)
            self.assertEqual(variable(current, 's')['value'], str(expected_sum))
        for _ in range(10):
            current = session.execute('next')
            if current['status'] == 'completed':
                break
        self.assertEqual(current['status'], 'completed')
        self.assertEqual(current['output']['stdout'], '9')

    def test_output_loop_reads_cout_printf_and_multiline(self):
        cases = (("cout << a[i];", 1, '000'), ("cout << a[i] << endl;", 1, '0\n0\n0\n'),
                 ("std::cout << a[i] << ' ';", 1, '0 ' * 3), ('std::printf("%d ", a[i]);', 1, '0 ' * 3),
                 ("std::cout << a[i]\n                  << ' ';", 1, '0 ' * 3),
                 ("std::cout << a[i] << ' ';\n        std::printf(\"%d \", a[i]);\n        std::cout << a[i]\n                  << ' ';", 3, '0 ' * 9))
        for output, repeats, expected_output in cases:
            with self.subTest(output=output):
                session = self.start('''#include <iostream>
#include <cstdio>
using namespace std;
int main() {
    int a[3] = {0, 0, 0}; // a：数组
    for (int i = 0; i < 3; i++) { // i：下标
        ''' + output + '''
    }
    return 0;
}
''')
                current = session.history[-1]
                reads = []
                for _ in range(40):
                    if current['status'] != 'paused':
                        break
                    current = session.execute('next')
                    access = current['arrayAccess']
                    self.assertEqual(access['writes'], [])
                    if access['reads']:
                        a = variable(current, 'a')
                        self.assertEqual(access['reads'][0]['variableId'], a['id'])
                        reads.extend(item['coordinates'] for item in access['reads'])
                        refreshed = session.window(session.run_id, a['id'], 0, 3)
                        self.assertEqual(refreshed['arrayAccess'], access)
                self.assertEqual(reads, [[index] for index in range(3) for _ in range(repeats)])
                self.assertEqual(current['status'], 'completed')
                self.assertEqual(current['output']['stdout'].replace('\r\n', '\n'), expected_output)

    def test_output_arguments_distinguish_use_and_read_and_omit_side_effects(self):
        session = self.start('''#include <iostream>
#include <cstdio>
int f(int x) { // x：参数
    return x;
}
int main() {
    int a[3] = {1, 2, 3}; // a：数组
    int i = 0; // i：下标
    int n = 0; // n：输出数量
    const char *p = "%d"; // p：格式串
    std::printf("%d", f(a[i]));
    std::printf("%d", a[i++]);
    std::printf(p, a[0]);
    std::printf("%d%n", a[0], &n);
    std::cout << (i ? a[0] : a[1]);
    return 0;
}
''')
        self.until(session, 'std::printf("%d", f')
        for index in (0, None, 0, 0, None):
            current = session.execute('next')
            if index is None:
                self.assertEqual(current['arrayAccess'], {'line': None, 'reads': [], 'writes': []})
            else:
                self.assertEqual(current['arrayAccess']['uses'], [
                    {'variableId': variable(current, 'a')['id'], 'coordinates': [index]}])
                self.assertEqual(current['arrayAccess']['reads'], [])
                self.assertEqual(current['arrayAccess']['writes'], [])

    def test_general_function_arguments_and_expression_contexts(self):
        session = self.start('''#include<bits/stdc++.h>
using namespace std;
int f(int x) { // x：传值参数
    return x;
}
void g(int &x) { // x：引用参数
    x = 8;
}
int main() {
    int a[6] = {0, -3, 4, 0, 0, 0}; // a：测试数组
    int i = 1; // i：第一下标
    int j = 2; // j：第二下标
    int s = 0; // s：累加结果
    s += abs(a[i]);
    s += max(a[i], a[j]);
    s += f(abs(a[i]));
    s += int(sqrt(a[j]+2));
    g(a[i]);
    s += f(+a[i]);
    s += a[i]>0 ? abs(a[j]) : abs(a[3]);
    s += 0 && f(a[i]);
    s += a[0] && f(a[i]);
    s += sizeof(a[i]);
    s += f(
        a[i]
    );
    return 0;
}
''')
        self.until(session, 's += abs')
        for reads, uses in (([], [1]), ([], [1, 2]), ([], [1]), ([2], []),
                            ([], [1]), ([1], []), ([1], []), ([], []), ([0], []), ([], [])):
            current = session.execute('next')
            access = current['arrayAccess']
            self.assertEqual([entry['coordinates'] for entry in access['reads']], [[i] for i in reads])
            self.assertEqual([entry['coordinates'] for entry in access.get('uses', [])], [[i] for i in uses])
            self.assertEqual(access['writes'], [])
        # 多行调用可能中途停在实参行，只在整条语句完成后确认。
        for _ in range(6):
            current = session.execute('next')
            if current['arrayAccess'].get('uses'):
                break
        self.assertEqual([entry['coordinates'] for entry in current['arrayAccess'].get('uses', [])], [[1]])

    def test_entering_function_only_marks_arguments_and_caller_identity(self):
        session = self.start('''int f(int x) { // x：参数
    return x;
}
int main() {
    int a[2] = {1, 2}; // a：输入数组
    int b[2] = {}; // b：结果数组
    b[0] = f(a[1]);
    return 0;
}
''')
        before = self.until(session, 'b[0] =')
        current = session.execute('step')
        self.assertEqual(current['frames'][0]['function'], 'f')
        self.assertEqual(current['arrayAccess'], {
            'line': before['line'], 'reads': [], 'writes': [],
            'uses': [{'variableId': variable(before, 'a')['id'], 'coordinates': [1]}]})

    def test_other_calls_cannot_reuse_mutable_index_from_before_the_step(self):
        session = self.start('''int a[4] = {1, 2, 3, 4}; // a：数组
int i = 0; // i：全局下标
int f(int x) { // x：参数
    return x;
}
int g() {
    i = 2;
    return 0;
}
int h(int &x) { // x：引用下标
    x = 2;
    return 0;
}
int main() {
    int j = 0; // j：局部下标
    int s = 0; // s：结果
    s = f(a[i]) + g();
    s = f(a[j]) + h(j);
    s = f(a[0]) + g();
    return 0;
}
''')
        self.until(session, 's = f(a[i])')
        for _ in range(2):
            current = session.execute('next')
            self.assertEqual(current['arrayAccess'], {'line': None, 'reads': [], 'writes': []})
        current = session.execute('next')
        self.assertEqual(current['arrayAccess']['uses'], [
            {'variableId': variable(current, 'a', None)['id'], 'coordinates': [0]}])

    def test_cell_access_prefix_sum_and_refresh(self):
        session = self.start('''#include <string>
int a[100] = {};
int main() {
    std::string s = "101010";
    int i = 0;
    for (; i < 6; i++) {
        a[i+1] = a[i] + (s[i]=='1');
    }
    return 0;
}
''')
        for index in range(6):
            before = self.until(session, "a[i+1] =")
            current = session.execute("next")
            a = variable(current, "a", None)
            s = variable(current, "s")
            expected = {"line": before["line"],
                        "reads": [{"variableId": a["id"], "coordinates": [index]},
                                  {"variableId": s["id"], "coordinates": [index]}],
                        "writes": [{"variableId": a["id"], "coordinates": [index + 1]}]}
            self.assertEqual(current["arrayAccess"], expected)
            refreshed = session.window(session.run_id, a["id"], 50, 20)
            self.assertEqual(refreshed["arrayAccess"], expected)

    def test_cell_access_matrix_compound_and_same_value(self):
        session = self.start('''int main() {
    int a[2][2] = {{1, 2}, {3, 4}};
    int i = 1;
    a[i][0] += a[0][i];
    a[i][0] = 5;
    return 0;
}
''')
        self.until(session, "a[i][0] +=")
        current = session.execute("next")
        self.assertEqual([x["coordinates"] for x in current["arrayAccess"]["reads"]], [[1, 0], [0, 1]])
        self.assertEqual([x["coordinates"] for x in current["arrayAccess"]["writes"]], [[1, 0]])
        current = session.execute("next")
        self.assertFalse(variable(current, "a")["changed"])
        self.assertEqual([x["coordinates"] for x in current["arrayAccess"]["writes"]], [[1, 0]])

    def test_cell_access_side_effects_omitted_and_conditional_write_retained(self):
        session = self.start('''int a[5] = {};
int main() {
    int i = 0;
    a[i++] = a[0];
    a[0] = i ? a[1] : a[2];
    return 0;
}
''')
        self.until(session, "a[i++] =")
        current = session.execute("next")
        self.assertEqual(current["arrayAccess"], {"line": None, "reads": [], "writes": []})
        current = session.execute("next")
        self.assertEqual(current["arrayAccess"]["reads"], [])
        self.assertEqual(current["arrayAccess"]["writes"], [
            {"variableId": variable(current, 'a', None)['id'], "coordinates": [0]}])

    def test_conditional_access_only_marks_guaranteed_cells(self):
        session = self.start('''int main() {
    int a[6] = {2, 3, 4, 5, 6, 7}; // a：测试数组
    int i = 1; // i：第一下标
    int j = 2; // j：第二下标
    int s = 0; // s：结果
    s = a[i]>0 ? a[j] : a[3];
    s = i ? a[1] : a[i];
    s = a[0] ? (i ? a[2] : a[3]) : a[4];
    a[5] = i ? a[1] : a[2];
    s = i ? (j ? a[2] : a[2]) : a[2];
    s = i ? a[1] : a[2];
    (i ? a[1] : a[1]) = 8;
    return s;
}
''')
        self.until(session, 's = a[i]>0')
        for reads, writes in (([1], []), ([1], []), ([0], []), ([], [5]), ([2], []), ([], []), ([], [])):
            current = session.execute('next')
            access = current['arrayAccess']
            self.assertEqual([entry['coordinates'] for entry in access['reads']], [[i] for i in reads])
            self.assertEqual([entry['coordinates'] for entry in access['writes']], [[i] for i in writes])

    def test_cell_access_shadow_uses_local_identity(self):
        session = self.start('''int a[2] = {};
int main() {
    int a[2] = {1, 2};
    a[0] = a[1];
    return 0;
}
''')
        self.until(session, "a[0] = a[1]")
        current = session.execute("next")
        identity = variable(current, "a")["id"]
        self.assertEqual(current["arrayAccess"]["reads"], [{"variableId": identity, "coordinates": [1]}])
        self.assertEqual(current["arrayAccess"]["writes"], [{"variableId": identity, "coordinates": [0]}])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="code-lab-data-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def start(self, code, **kwargs):
        path = self.root / "source.cpp"
        path.write_text(code, encoding="utf-8")
        session = DebugSession(path, log_root=self.root / "logs", **kwargs)
        self.addCleanup(session.close)
        first = session.start()
        self.assertEqual(first["status"], "paused", first)
        return session

    def until(self, session, text, motion="next"):
        target = next(i for i, line in enumerate(session.source.read_text(encoding="utf-8").splitlines(), 1) if text in line)
        for _ in range(90):
            current = session.history[-1]
            if current["line"] == target:
                return current
            current = session.execute(motion)
            self.assertEqual(current["status"], "paused", current)
        self.fail("未到达 " + text)

    def test_matrix_coordinates_and_cell_diff(self):
        session = self.start('''int main() {
    int a[2][3] = {{1,2,3},{4,5,6}};
    a[1][0] = 9;
    return 0;
}
''')
        before = self.until(session, "a[1][0] =")
        data = variable(before, "a")["data"]
        self.assertEqual(data["shape"], [2, 3])
        self.assertEqual([(e["coordinates"], e["value"]) for e in data["elements"]],
                         [([0, 0], "1"), ([0, 1], "2"), ([0, 2], "3"), ([1, 0], "4"), ([1, 1], "5"), ([1, 2], "6")])
        after = session.execute("next")
        changes = [e for e in variable(after, "a")["data"]["elements"] if e["changed"]]
        self.assertEqual([(e["coordinates"], e["previousValue"], e["value"]) for e in changes], [([1, 0], "4", "9")])

    def test_adjacent_swap_compares_each_snapshot(self):
        session = self.start('''int main() {
    int a[3] = {3,1,4};
    int t = a[0];
    a[0] = a[1];
    a[1] = t;
    return 0;
}
''')
        self.until(session, "a[0] = a[1]")
        for coordinate, before, after in [(0, "3", "1"), (1, "1", "3")]:
            current = session.execute("next")
            changed = [e for e in variable(current, "a")["data"]["elements"] if e["changed"]]
            self.assertEqual([(e["index"], e["previousValue"], e["value"]) for e in changed], [(coordinate, before, after)])

    def test_large_window_preserves_step_output_and_diff(self):
        session = self.start('''int a[1000000] = {};
int main() {
    a[4] = 8;
    a[999999] = 7;
    return 0;
}
''')
        initial = variable(session.history[-1], "a", frame=None)
        self.assertEqual((len(initial["data"]["elements"]), initial["data"]["hidden"]), (50, 999950))
        current = session.execute("next")
        saved = (current["step"], current["line"], current["output"], len(session.history))
        item = variable(current, "a", frame=None)
        refreshed = session.window(session.run_id, item["id"], 0, 10)
        self.assertEqual((refreshed["step"], refreshed["line"], refreshed["output"], len(session.history)), saved)
        self.assertEqual([e["index"] for e in variable(refreshed, "a", None)["data"]["elements"] if e["changed"]], [4])
        refreshed = session.window(session.run_id, item["id"], 999995, 200)
        self.assertEqual([e["index"] for e in variable(refreshed, "a", None)["data"]["elements"]], list(range(999995, 1000000)))
        current = session.execute("next")
        self.assertEqual([(e["index"], e["value"]) for e in variable(current, "a", None)["data"]["elements"] if e["changed"]], [(999999, "7")])
        with self.assertRaises(ValueError): session.window("old", item["id"], 0, 50)
        for offset, limit in [(-1, 50), (0, 201), (0, 0), (True, 50), (0, 3.5)]:
            with self.assertRaises(ValueError): session.window(session.run_id, item["id"], offset, limit)
        session.execute("stop")
        with self.assertRaises(ValueError): session.window(session.run_id, item["id"], 0, 50)

    def test_vector_append_and_string_embedded_null(self):
        session = self.start('''#include <vector>
#include <string>
int main() {
    std::vector<int> a = {3,1};
    std::string b = "abc";
    a.push_back(4);
    b[1] = '\\0';
    b[2] = 'x';
    return 0;
}
''')
        current = self.until(session, "a.push_back")
        self.assertEqual(variable(current, "b")["data"]["total"], 3)
        current = session.execute("next")
        self.assertEqual([e["value"] for e in variable(current, "a")["data"]["elements"]], ["3", "1", "4"])
        self.assertFalse(variable(current, "a")["data"]["elements"][2]["changed"])
        current = session.execute("next")
        data = variable(current, "b")["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual([e["index"] for e in data["elements"] if e["changed"]], [1])
        self.assertTrue(data["elements"][1]["value"].startswith("0 "))
        self.assertIn("'c'", data["elements"][2]["value"])
        current = session.execute("next")
        self.assertEqual([e["index"] for e in variable(current, "b")["data"]["elements"] if e["changed"]], [2])

    def test_wide_matrix_window_and_same_value_write(self):
        session = self.start('''int a[2][10000] = {};
int main() {
    a[1][1] = 0;
    return 0;
}
''')
        item = variable(session.history[-1], "a", None)
        refreshed = session.window(session.run_id, item["id"], 9998, 4)
        data = variable(refreshed, "a", None)["data"]
        self.assertEqual([e["coordinates"] for e in data["elements"]], [[0, 9998], [0, 9999], [1, 0], [1, 1]])
        self.assertEqual(data["hidden"], 19996)
        current = session.execute("next")
        self.assertFalse(any(e["changed"] for e in variable(current, "a", None)["data"]["elements"]))

    def test_empty_default_containers_and_unsupported_bool(self):
        session = self.start('''#include <vector>
#include <string>
int main() {
    std::vector<int> a;
    std::string b;
    std::vector<bool> c = {true};
    return 0;
}
''')
        current = self.until(session, "return 0")
        for name in ("a", "b"):
            item = variable(current, name)
            self.assertEqual(item["state"], "ok")
            self.assertEqual((item["data"]["total"], item["data"]["elements"]), (0, []))
        data = variable(current, "c")["data"]
        self.assertEqual(data["state"], "unavailable")
        self.assertIn("vector<bool>", data["note"])
        self.assertEqual(data["elements"], [])

    def test_container_lengths_are_confirmed_after_executed_queries(self):
        session = self.start('''#include <iostream>
#include <string>
#include <vector>
int main() {
    std::string a, b; // a、b：输入的两个字符串
    std::cin >> a >> b;
    int n = a.size(); // n：第一个字符串长度
    int m = b.size(); // m：第二个字符串长度
    std::vector<int> c = {1, 2, 3}; // c：整数容器
    int k = c.size() + b.length(); // k：两个容器长度之和
    n = b.length();
    std::cout << n << ' ' << m << ' ' << k;
    return 0;
}
''')
        for name in ("a", "b"):
            self.assertIsNone(next(v for v in session.history[-1]["variables"] if v["name"] == name)["value"])
        current = self.until(session, "std::vector<int> c")
        for name in ("n", "m"):
            self.assertEqual((variable(current, name)["state"], variable(current, name)["value"]), ("ok", "0"))
        # 相同源码再用非空输入执行，不能靠空字符串的零值凑巧通过。
        session.close()
        input_path = self.root / "input.txt"
        input_path.write_text("12345 678\n", encoding="utf-8")
        session = DebugSession(session.source, input_path=input_path, log_root=self.root / "logs")
        self.addCleanup(session.close)
        session.start()
        current = self.until(session, "std::vector<int> c")
        self.assertEqual((variable(current, "n")["value"], variable(current, "m")["value"]), ("5", "3"))
        current = self.until(session, "n = b.length()")
        self.assertEqual(variable(current, "k")["value"], "6")
        current = session.execute("next")
        self.assertEqual(variable(current, "n")["value"], "3")
        self.assertTrue(variable(current, "n")["changed"])
        self.assertEqual(variable(current, "n")["previousValue"], "5")

    def test_recursion_arrays_do_not_share_identity_or_changes(self):
        session = self.start('''int f(int x) {
    int a[2] = {};
    a[0] = x;
    if (x > 0) {
        a[1] = f(x - 1);
    }
    return a[0] + a[1];
}
int main() {
    int s = 0;
    s = f(2);
    return 0;
}
''')
        for _ in range(70):
            current = session.execute("step")
            arrays = [v for v in current["variables"] if v["name"] == "a" and v["state"] == "ok"]
            if len(arrays) == 3 and all(v["data"]["elements"][0]["value"] == str(i) for i, v in enumerate(arrays)):
                break
        else: self.fail("未捕获三层递归数组")
        self.assertEqual(len({v["id"] for v in arrays}), 3)
        self.assertEqual([v["data"]["elements"][0]["value"] for v in arrays], ["0", "1", "2"])
        self.assertTrue(all(not e["changed"] for v in arrays[1:] for e in v["data"]["elements"]))
        current = self.until(session, "a[0] = x")
        current = session.execute("next")
        self.assertEqual(current["arrayAccess"]["writes"], [{"variableId": arrays[0]["id"], "coordinates": [0]}])
        current = session.window(session.run_id, arrays[1]["id"], 1, 1)
        self.assertEqual([len(variable(current, "a", i)["data"]["elements"]) for i in range(3)], [2, 1, 2])

    def test_uninitialized_arrays_never_expose_stack_values(self):
        session = self.start('''int main() {
    int a[3];
    int x = 1;
    x++;
    return 0;
}
''')
        current = self.until(session, "x++")
        item = variable(current, "a")
        self.assertNotEqual(item["state"], "ok")
        self.assertTrue(all(e["value"] is None and not e["changed"] for e in item["data"]["elements"]))

    def test_unconfirmed_container_masks_length_as_well_as_elements(self):
        builder = SnapshotBuilder("")
        raw = {"frames": [{"key": "main:1", "line": 5}], "variables": [{
            "rawId": "raw", "name": "a", "type": "std::vector<int>", "frameKey": "main:1",
            "frame": 0, "declaration": 1, "scope": "1:9", "kind": "local", "depth": 0,
            "rawValue": None, "readError": None,
            "data": {"kind": "vector", "total": 999999, "shape": [999999], "lowerBounds": [0],
                     "offset": 0, "limit": 50, "hidden": 999998, "state": "ok", "note": None,
                     "elements": [{"index": 0, "coordinates": [0], "state": "ok", "value": "123456", "note": None}]}}]}
        item = builder.build(raw, "run", {}, {})["variables"][0]
        self.assertNotEqual(item["state"], "ok")
        self.assertEqual((item["data"]["shape"], item["data"]["total"], item["data"]["elements"]), ([], 0, []))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    unittest.main(verbosity=2)
