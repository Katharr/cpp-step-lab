    int a[100] = {}; // a：演示数组
    int b[100] = {}; // b：第二个数组
int main() {
    int l = 0; // l：左边界
    int r = 99; // r：右边界
    int m = (l + r) / 2; // m：中间下标
    int t = 3; // t：干扰值
    int u; // u：未赋值变量
    m = l;
    r = l;
    l = -1;
    r = 100;
    m = 75;
    a[m] = b[m];
    {
        int v = 1; // v：手动关联的块内变量
        t++;
    }
    t++;
    t++;
    return t;
}
