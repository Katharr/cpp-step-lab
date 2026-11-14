int f(int n) { // n：递归层数
    int a[3] = {}; // a：本层数组
    int i = n; // i：本层下标
    a[i] = n;
    if (n > 0) {
        a[i] = f(n - 1);
    }
    return a[i];
}
int main() {
    int s = 0; // s：返回值
    s = f(2);
    return s;
}
