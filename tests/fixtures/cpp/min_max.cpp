#include <algorithm>
#include <iostream>
using namespace std;
int main() {
    int n = 3; // n：第一个长度
    int m = 7; // m：第二个长度
    int mx = max(n, m); // mx：较大长度
    int mn = std::min(n, m); // mn：较小长度
    mx = ::std::max(mn + 1, max(n, m) + 2);
    cout << mx << ' ' << mn << endl;
    return 0;
}
