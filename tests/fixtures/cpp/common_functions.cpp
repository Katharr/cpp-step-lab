#include <bits/stdc++.h>
using namespace std;
int main() {
    int a[] = {1, 2, 2, 4}; // a：有序数组
    int n = 4; // n：数组长度
    int r = 0; // r：函数返回值
    string s = "123"; // s：数字字符串
    vector<int> v = {2, 5, 8}; // v：整数容器
    char c[] = "abc"; // c：字符数组
    typedef queue<int> Q;
    Q q; // q：队列（验证 GDB 解析类型别名）
    priority_queue<int> h; // h：大根堆
    stack<int> k; // k：栈
    deque<int> d = {2, 4}; // d：双端队列
    set<int> t = {1, 2, 3}; // t：有序集合
    map<int, int> m = {{1, 4}, {2, 5}}; // m：键值映射
    pair<int, int> p = make_pair(3, 8); // p：数对
    bitset<8> b(5); // b：二进制位集合
    array<int, 3> e = {2, 3, 4}; // e：标准定长数组
    q.push(6);
    h.push(7);
    k.push(9);
    r = q.front() + q.back() + q.size(); // @expect 13
    r = h.top() + h.size(); // @expect 8
    r = k.top() + k.size(); // @expect 10
    r = d.front() + d.back(); // @expect 6
    r = t.count(2); // @expect 1
    r = distance(t.begin(), t.lower_bound(3)); // @expect 2
    r = m.at(2); // @expect 5
    r = p.first + p.second; // @expect 11
    r = b.count(); // @expect 2
    r = b.test(2); // @expect 1
    r = b.to_ulong(); // @expect 5
    r = e.front() + e.back(); // @expect 6
    r = abs(-7); // @expect 7
    r = labs(-8L); // @expect 8
    r = llabs(-9LL); // @expect 9
    r = max<int>(n, 7); // @expect 7
    r = std::min({8, n, 6}); // @expect 4
    r = ::std::max<long long>(n, 9); // @expect 9
    r = sqrt(81); // @expect 9
    r = sqrtf(64); // @expect 8
    r = cbrt(27); // @expect 3
    r = pow(2, 5); // @expect 32
    r = ceil(2.3); // @expect 3
    r = floor(2.9); // @expect 2
    r = round(2.8); // @expect 3
    r = trunc(-2.8); // @expect -2
    r = lround(3.6); // @expect 4
    r = log2(8); // @expect 3
    r = log10(100); // @expect 2
    r = exp2(4); // @expect 16
    r = sin(0) + cos(0); // @expect 1
    r = hypot(3, 4); // @expect 5
    r = fmod(7, 3); // @expect 1
    r = fmax(2, 6); // @expect 6
    r = fmin(2, 6); // @expect 2
    r = fma(2, 3, 4); // @expect 10
    r = ldexp(3, 2); // @expect 12
    r = isfinite(1.0); // @expect 1
    r = std::numeric_limits<int>::max(); // @expect 2147483647
    r = std::__gcd(12, 18); // @expect 6
    r = __builtin_popcount(15); // @expect 4
    r = __builtin_popcountll(31LL); // @expect 5
    r = __builtin_ctz(8); // @expect 3
    r = __builtin_ffs(8); // @expect 4
    r = strlen(c); // @expect 3
    r = strcmp(c, "abc"); // @expect 0
    r = strncmp(c, "abd", 2); // @expect 0
    r = atoi("42"); // @expect 42
    r = stoll(s); // @expect 123
    r = int(stod("12.5")); // @expect 12
    r = static_cast<int>(sqrt(49)); // @expect 7
    r = int(sizeof(a) / sizeof(a[0])); // @expect 4
    r = tolower('A'); // @expect 97
    r = toupper('a'); // @expect 65
    r = !!isdigit('5'); // @expect 1
    r = *a; // 不支持指针解引用时应继续保守显示。
    r = accumulate(a, a + n, 0); // @expect 9
    r = inner_product(a, a + n, a, 0); // @expect 25
    r = count(a, a + n, 2); // @expect 2
    r = lower_bound(a, a + n, 2) - a; // @expect 1
    r = upper_bound(a, a + n, 2) - a; // @expect 3
    r = binary_search(a, a + n, 4); // @expect 1
    r = find(a, a + n, 4) - a; // @expect 3
    r = max_element(a, a + n) - a; // @expect 3
    r = min_element(a, a + n) - a; // @expect 0
    r = distance(begin(a), end(a)); // @expect 4
    r = equal(a, a + n, a); // @expect 1
    r = lexicographical_compare(a, a + n, a, a + n); // @expect 0
    r = v.size() + v.front() + v.back(); // @expect 13
    r = v.at(1); // @expect 5
    r = v.empty(); // @expect 0
    r = distance(v.cbegin(), v.cend()); // @expect 3
    r = s.length() + s.size(); // @expect 6
    r = s.find("2"); // @expect 1
    r = s.rfind('3'); // @expect 2
    r = s.compare("123"); // @expect 0
    r = stoi(s.substr(1, 2)); // @expect 23
    r = strlen(s.c_str()); // @expect 3
    cout << r << endl;
    return 0;
}
