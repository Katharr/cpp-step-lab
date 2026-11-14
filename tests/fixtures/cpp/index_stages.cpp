#include <iostream>
int main() {
    int a[100] = {}; // a：演示数组
    int n = 3; // n：输入个数
    int i = 0; // i：输入下标
    int j = 75; // j：遍历下标
    int m = 75; // m：手动定位位置
    int t = i; // t：计算依赖干扰变量
    int u; // u：未赋值变量
    for (i = 0; i < n; i++) {
        std::cin >> a[i];
        t++;
    }
    for (j = 0; j < n - 1; j++) {
        a[j+1] = a[j];
        t++;
    }
    i = -1;
    j = 100;
    t++;
    {
        int v = 1; // v：块内手动下标
        t++;
    }
    t++;
    return t;
}
