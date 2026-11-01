int f(int x) {  // x = 本层参数
    int s = x;  // s = 本层局部变量
    if (x > 1) {
        s += f(x - 1);  // @recurse
    }
    return s;  // @return
}
int main() {
    int x = 40;  // x = main 中的变量
    int t = f(3);  // t = 递归结果；@call
    return 0;  // @done
}
