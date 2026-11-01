int a = 3;  // a = 全局变量
int main() {
    int s = 7;  // s = 外层变量；@outer_declare
    int x;  // x = 尚未初始化的变量；@uninitialized_declare
    s += 1;  // @uninitialized
    x = 5;  // @assign
    {
        int s = 9;  // s = 内层同名变量；@inner_declare
        s += x;  // @inner
    }
    s += 2;  // @left
    return 0;  // @done
}
