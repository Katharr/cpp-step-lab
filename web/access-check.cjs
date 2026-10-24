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
    const output = path.join(__dirname, 'qa', 'visual-update');
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
    assert.deepEqual(errors, []);
    console.log('通过：真实 a/s 双源读取、写入、同值写入、离窗定位、历史还原与最终结果');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
