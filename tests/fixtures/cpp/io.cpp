#include <cstdio>
int a = 0;  // a = 输入的整数，具有静态存储期
int main() {
    std::scanf("%d", &a);
    std::printf("中文:%d\n", a);  // @print
    std::fprintf(stderr, "error:%d\n", a);
    std::fflush(stdout);
    std::fflush(stderr);
    a += 1;  // @flushed
    return 0;
}
