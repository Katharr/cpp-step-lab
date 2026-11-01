#include <cstdio>
int main() {
    int a[4] = {3, 1, 4, 2};  // a = 待累加的数组
    int s = 0;  // s = 总和
    for (int i = 0; i < 4; i++) {  // i = 当前下标；@loop
        s += a[i];  // @add
    }
    std::printf("%d\n", s);  // @print
    return 0;
}
