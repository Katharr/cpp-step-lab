#include <cstdio>
int main() {
    long long x = 9007199254740993LL;  // x = 第一个整数
    long long s = 2;  // s = 第二个整数
    long long t = x;  // t = 交换时暂存的整数；@swap
    x = s;
    s = t;
    std::printf("%lld %lld\n", x, s);  // @print
    std::fflush(stdout);
    return 0;  // @done
}
