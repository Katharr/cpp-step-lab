int main() {
    int a[8] = {1, 3, 5, 7, 9, 11, 13, 15}; // a：有序数组
    int l = 0; // l：左边界
    int r = 7; // r：右边界
    int t = 9; // t：查找目标
    int s = 0; // s：比较次数
    while (l <= r) {
        int m = (l + r) / 2; // m：中间下标
        s++;
        if (a[m] < t) {
            l = m + 1;
        } else {
            r = m - 1;
        }
    }
    return s;
}
