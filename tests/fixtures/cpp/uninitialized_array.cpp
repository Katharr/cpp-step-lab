int main() {
    int a[120]; // a：部分赋值的数组
    int x = 1; // x：执行位置标记
    x++;
    a[80] = 7;
    x++;
    return x;
}
