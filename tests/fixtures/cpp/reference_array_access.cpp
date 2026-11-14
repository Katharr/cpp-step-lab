int f(const int &x) { // x：只读引用
    return x;
}
void g(int &x) { // x：写入目标
    x = 8;
}
int main() {
    int a[1] = {8}; // a：保持数值不变的数组
    int s = f(a[0]); // s：只读调用结果
    g(a[0]);
    g(a[0]);
    return s;
}
