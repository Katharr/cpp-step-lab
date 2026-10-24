#include<bits/stdc++.h>
using namespace std;

long long a[200005]; // a：前缀和数组

int main() {
    int n, m; // n：元素数量；m：窗口长度
    cin >> n >> m;
    for(int i=1; i<=n; i++) { // i：当前元素下标
        int t; // t：输入元素
        cin >> t;
        a[i] = a[i-1] + t;
    }
    long long mx = a[1]; // mx：最大窗口和
    int p = 1; // p：最大窗口起点
    for(int i=1; i<=n-m+1; i++) { // i：窗口起点
        long t = a[i+m-1]-a[i-1]; // t：当前窗口和
        if(t > mx) {
            mx = t;
            p = i;
        }
    }
    cout << mx; // @print
    return 0;
}
