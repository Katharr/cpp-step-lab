// 真实 GCC/GDB 数据流：跨数组读取、同值写入、离窗自动定位与历史还原。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const source = `#include <iostream>
#include <string>
using namespace std;
int a[500005] = {0, 1, 1, 2, 2}; // a：前缀计数数组
int main() {
    string s = "101010"; // s：字符序列
    int i = 4; // i：当前下标
    a[i+1] = a[i] + (s[i]=='1');
    i = 60;
    a[i+1] = a[i] + 1;
    a[i+1] = 1;
    cout << a[5] << ' ' << a[61];
    return 0;
}
`;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const card = (name) => page.locator(`[data-structure="${name}"]`);
  const cell = (name, index) => card(name).locator(`.element[data-coordinates="${index}"]`);
  async function action(id, endpoint = '/api/command') {
    const pending = page.waitForResponse((response) => response.url() === base + endpoint && response.request().method() === 'POST');
    await page.locator('#' + id).click();
    const result = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return result;
  }
  async function until(predicate, value) {
    for (let count = 0; count < 35; count++) {
      if (predicate(value)) return value;
      assert.equal(value.status, 'paused', JSON.stringify(value));
      value = await action('next');
    }
    throw new Error('未观察到目标读写');
  }
  try {
    await page.goto(base);
    await page.locator('#source').fill(source);
    let result = await action('start', '/api/start');
    result = await until((snapshot) => snapshot.arrayAccess?.line === 8, result);
    assert.equal(await cell('a', 4).getAttribute('data-access'), 'read');
    assert.equal(await cell('s', 4).getAttribute('data-access'), 'read');
    assert.equal(await cell('a', 5).getAttribute('data-access'), 'write');
    assert.equal(await cell('a', 5).locator('.element-value').textContent(), '3');
    assert.equal(await cell('s', 4).locator('.element-value').textContent(), "'1'");
    assert.equal(await page.locator('.access-read').count(), 2);
    assert.equal(await page.locator('.access-write').count(), 1);
    assert.equal(await page.locator('.code-line.current').getAttribute('data-line'), String(result.line));
    assert.equal(await page.locator('#pause').isVisible(), false);
    const savedIndex = await page.locator('#history-slider').inputValue();
    const output = path.join(__dirname, '../../验收输出/browser', 'visual-update');
    fs.mkdirSync(output, { recursive: true });
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: path.join(output, 'prefix-access.png') });
    result = await until((snapshot) => snapshot.arrayAccess?.line === 10, result);
    // receive() 会继续请求 /api/window；DOM 必须已呈现新窗口及同一步写入。
    await cell('a', 61).waitFor();
    assert.equal(await cell('a', 60).getAttribute('data-access'), 'read');
    assert.equal(await cell('a', 61).getAttribute('data-access'), 'write');
    assert.equal(await cell('a', 61).locator('.element-value').textContent(), '1');
    assert.equal(await card('s').locator('[data-access]').count(), 0);
    const visible = await cell('a', 61).evaluate((element) => {
      const rect = element.getBoundingClientRect(), bounds = element.closest('.structure-scroll').getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    });
    assert.equal(visible, true, '离窗写入位置自动滚动可见');
    result = await action('next');
    assert.equal(await cell('a', 61).getAttribute('data-access'), 'write', '同值写入仍标记目标');
    assert.equal(await card('a').locator('.access-read').count(), 0);
    assert.equal(await cell('a', 61).evaluate((element) => element.classList.contains('changed')), false);
    await page.locator('#history-slider').evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }, savedIndex);
    assert.equal(await cell('a', 4).getAttribute('data-access'), 'read');
    assert.equal(await cell('s', 4).getAttribute('data-access'), 'read');
    assert.equal(await cell('a', 5).getAttribute('data-access'), 'write');
    assert.equal(await cell('a', 61).count(), 0);
    await page.locator('#history-latest').click();
    result = await until((snapshot) => snapshot.status === 'completed', result);
    assert.equal(result.output.stdout.trim(), '3 1');
    // 相同数值仍须逐个标出真正读取的下标；不依赖下标手工绑定。
    await page.locator('#edit').click();
    await page.locator('#source').fill(`#include <iostream>
#include <cstdio>
using namespace std;
int a[100] = {}; // a：输出数组
int main() {
    for (int i = 60; i < 63; i++) { // i：当前下标
        cout << a[i];
        std::printf("%d ", a[i]);
        std::cout << a[i]
                  << '\\n';
    }
    return 0;
}
`);
    result = await action('start', '/api/start');
    const reads = [];
    let savedOutputIndex;
    for (let count = 0; count < 35 && result.status === 'paused'; count++) {
      result = await action('next');
      const accesses = result.arrayAccess?.reads || [];
      if (!accesses.length) {
        assert.equal(await card('a').locator('.access-read').count(), 0, '无读取的步骤不保留上一步标记');
        continue;
      }
      assert.equal(accesses.length, 1);
      assert.deepEqual(result.arrayAccess.writes, []);
      const coordinate = accesses[0].coordinates[0];
      reads.push(coordinate);
      await cell('a', coordinate).waitFor();
      assert.equal(await cell('a', coordinate).getAttribute('data-access'), 'read');
      assert.equal(await card('a').locator('.access-read').count(), 1);
      assert.equal(await card('a').locator('.access-write').count(), 0);
      const visible = await cell('a', coordinate).evaluate((element) => {
        const rect = element.getBoundingClientRect(), bounds = element.closest('.structure-scroll').getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      });
      assert.equal(visible, true, '循环输出的离窗格子应自动显示');
      if (reads.length === 1) {
        savedOutputIndex = await page.locator('#history-slider').inputValue();
        await page.locator('#variables-two').click();
        await page.screenshot({ path: path.join(output, 'loop-output.png') });
      }
    }
    assert.equal(result.status, 'completed');
    assert.deepEqual(reads, [60, 60, 60, 61, 61, 61, 62, 62, 62]);
    await page.locator('#history-slider').evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }, savedOutputIndex);
    assert.equal(await cell('a', 60).getAttribute('data-access'), 'read');
    assert.equal(await card('a').locator('.access-read').count(), 1);
    assert.equal(await page.locator('#stdout').textContent(), '0');
    // 用户程序：条件判断必读 b[i]，正数、负数和零都应标出一次。
    await page.locator('#history-latest').click();
    await page.locator('#edit').click();
    const accumulation = `#include<bits/stdc++.h>
using namespace std;
int a[100005], b[100005]; // a：输入数组；b：前缀和
int main() {
    int n; // n：元素数量
    cin >> n;
    for(int i=1; i<=n; i++) { // i：输入下标
        cin >> a[i];
    }
    for(int i=2; i<=n; i++) { // i：前缀和下标
        b[i] = b[i-1] + a[i-1];
    }
    long long s = 0; // s：绝对值之和
    for(int i=2; i<=n; i++) { // i：累加下标
        s += b[i]>0 ? b[i] : (-1)*b[i];
    }
    cout << s;
    return 0;
}
`;
    for (const functionCall of [false, true]) {
      if (functionCall) {
        await page.locator('#history-latest').click();
        await page.locator('#edit').click();
      }
      await page.locator('#source').fill(functionCall ? accumulation.replace('b[i]>0 ? b[i] : (-1)*b[i]', 'abs(b[i])') : accumulation);
      await page.locator('#stdin').fill('6\n3 -5 2 0 4 -9\n');
      result = await action('start', '/api/start');
      const accumulationLine = accumulation.split('\n').findIndex((line) => line.includes('s +=')) + 1;
      const accumulatedIndices = [];
      let savedAccumulationIndex;
      for (let count = 0; count < 100 && result.status === 'paused'; count++) {
        result = await action('next');
        if (result.arrayAccess?.line !== accumulationLine) continue;
        const index = accumulatedIndices.length + 2;
        const b = result.variables.find((variable) => variable.name === 'b' && variable.frame === null);
        const accessKind = functionCall ? 'uses' : 'reads';
        const cellKind = functionCall ? 'use' : 'read';
        assert.deepEqual(result.arrayAccess[accessKind], [{ variableId: b.id, coordinates: [index] }]);
        if (functionCall) assert.deepEqual(result.arrayAccess.reads, []);
        assert.deepEqual(result.arrayAccess.writes, []);
        assert.equal(await cell('b', index).getAttribute('data-access'), cellKind);
        assert.equal(await card('b').locator(functionCall ? '.access-use' : '.access-read').count(), 1);
        assert.equal(await card('b').locator('.access-write').count(), 0);
        assert.equal(await card('a').locator('.access-read').count(), 0);
        const expectedSum = [3, 5, 5, 5, 9][accumulatedIndices.length];
        assert.equal(result.variables.find((variable) => variable.name === 's' && variable.frame === 0).value, String(expectedSum));
        accumulatedIndices.push(index);
        if (index === 3) {
          savedAccumulationIndex = await page.locator('#history-slider').inputValue();
          if (functionCall) assert.equal(await card('b').locator('.access-use-note').textContent(), ' · 本步传入函数');
          await page.screenshot({ path: path.join(output, functionCall ? 'function-accumulation.png' : 'conditional-accumulation.png') });
          if (functionCall) {
            await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
            assert.equal(await cell('b', index).evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(57, 43, 82)');
            await page.screenshot({ path: path.join(output, 'function-accumulation-dark.png') });
            await page.evaluate(() => { delete document.documentElement.dataset.theme; });
          }
        }
      }
      assert.equal(result.status, 'completed');
      assert.equal(result.output.stdout, '9');
      assert.deepEqual(accumulatedIndices, [2, 3, 4, 5, 6]);
      await page.locator('#history-slider').evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }, savedAccumulationIndex);
      assert.equal(await cell('b', 3).getAttribute('data-access'), functionCall ? 'use' : 'read');
      assert.equal(await card('b').locator(functionCall ? '.access-use' : '.access-read').count(), 1);
    }
    // 通用调用：不同函数与嵌套调用均走同一规则，零值离窗元素也不能被折叠。
    await page.locator('#history-latest').click();
    await page.locator('#edit').click();
    await page.locator('#source').fill(`#include<bits/stdc++.h>
using namespace std;
int f(int x) { // x：参数
    return x;
}
int a[100] = {}; // a：零值数组
int main() {
    int s = 0; // s：累加结果
    for (int i=60; i<63; i++) { // i：离窗下标
        s += f(abs(a[i]));
        s += max(a[i], a[i+1]);
    }
    cout << s;
    return 0;
}
`);
    await page.locator('#stdin').fill('');
    result = await action('start', '/api/start');
    const functionUses = [];
    for (let count = 0; count < 40 && result.status === 'paused'; count++) {
      result = await action('next');
      const uses = result.arrayAccess?.uses || [];
      if (!uses.length) {
        assert.equal(await card('a').locator('.access-use').count(), 0);
        continue;
      }
      functionUses.push(uses.map((entry) => entry.coordinates[0]));
      assert.equal(await card('a').locator('.access-use').count(), uses.length);
      for (const use of uses) {
        const target = cell('a', use.coordinates[0]);
        assert.equal(await target.getAttribute('data-access'), 'use');
        assert.equal(await target.isVisible(), true);
        assert.equal(await target.evaluate((element) => {
          const rect = element.getBoundingClientRect(), bounds = element.closest('.structure-scroll').getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right;
        }), true);
      }
    }
    assert.equal(result.status, 'completed');
    assert.deepEqual(functionUses, [[60], [60,61], [61], [61,62], [62], [62,63]]);
    // if 比较的真假路径都读取 a[j]；零值离窗格子要展开并保留历史标记。
    await page.locator('#edit').click();
    const comparison = `#include <iostream>
int a[100] = {}; // a：待比较数组
int main() {
    int i = 0; // i：比较值
    int s = 0; // s：相等次数
    for (int j = 60; j < 63; j++) { // j：比较下标
        if (a[j] == i) {
            s++;
        }
        if (a[j] != i) {
            s += a[0];
        }
    }
    std::cout << s;
    return 0;
}
`;
    await page.locator('#source').fill(comparison);
    result = await action('start', '/api/start');
    const comparisonLines = comparison.split('\n').flatMap((line, index) => line.includes('if (') ? [index + 1] : []);
    const compared = [];
    let savedComparisonIndex;
    for (let count = 0; count < 65 && result.status === 'paused'; count++) {
      result = await action('next');
      if (!comparisonLines.includes(result.arrayAccess?.line)) continue;
      const index = 60 + Math.floor(compared.length / 2);
      assert.deepEqual(result.arrayAccess.reads, [{ variableId: result.variables.find((v) => v.name === 'a').id, coordinates: [index] }]);
      assert.deepEqual(result.arrayAccess.writes, []);
      await cell('a', index).waitFor();
      assert.equal(await cell('a', index).getAttribute('data-access'), 'read');
      assert.equal(await card('a').locator('.access-read').count(), 1);
      assert.equal(await cell('a', index).evaluate((element) => {
        const rect = element.getBoundingClientRect(), bounds = element.closest('.structure-scroll').getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      }), true, '比较引用的离窗零值格子自动展开并显示');
      compared.push(index);
      if (compared.length === 1) {
        savedComparisonIndex = await page.locator('#history-slider').inputValue();
        await page.screenshot({ path: path.join(output, 'if-comparison.png') });
        result = await action('next');
        assert.equal(await card('a').locator('.access-read').count(), 0, '进入分支后清除条件读取标记');
      }
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.output.stdout, '3');
    assert.deepEqual(compared, [60, 60, 61, 61, 62, 62]);
    await page.locator('#history-slider').evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }, savedComparisonIndex);
    assert.equal(await cell('a', 60).getAttribute('data-access'), 'read');
    assert.equal(await card('a').locator('.access-read').count(), 1);
    assert.deepEqual(errors, []);
    console.log('通过：真实数组读写、循环输出、三元/abs 累加、函数实参与 if 比较的高亮、离窗定位与历史还原');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
