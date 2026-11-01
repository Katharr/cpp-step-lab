// 真实 GCC/GDB 网页验收：新增格子的颜色、提示、清除及历史还原。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const source = `#include <string>
#include <utility>
int main() {
    std::string a = "123"; // a：第一个字符串
    std::string b = "6666"; // b：第二个字符串
    std::swap(a, b);
    int n = 0; // n：暂停位置
    return n;
}
`;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const card = (name) => page.locator(`[data-structure="${name}"]`);
  const cell = (index) => card('a').locator(`.element[data-index="${index}"]`);
  async function action(id, endpoint = '/api/command') {
    const pending = page.waitForResponse((response) => response.url() === base + endpoint && response.request().method() === 'POST');
    await page.locator('#' + id).click();
    const result = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return result;
  }
  try {
    await page.goto(base);
    await page.locator('#source').fill(source);
    let result = await action('start', '/api/start');
    for (let step = 0; result.line !== 6 && step < 12; step++) {
      assert.equal(result.status, 'paused');
      result = await action('next');
    }
    assert.equal(result.line, 6);
    await action('next');
    assert.equal(await card('a').locator('.element.changed').count(), 4);
    assert.equal(await card('b').locator('.element.changed').count(), 3);
    assert.match(await cell(3).getAttribute('title'), /本步新增；当前：/);
    assert.doesNotMatch(await cell(3).getAttribute('title'), /上一步|未赋值/);
    assert.equal(await cell(3).evaluate((element) => getComputedStyle(element).backgroundColor),
      await cell(0).evaluate((element) => getComputedStyle(element).backgroundColor));
    const history = await page.locator('#history-slider').inputValue();
    const output = path.join(__dirname, 'qa', 'growth');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'string-swap.png') });
    await action('next');
    assert.equal(await card('a').locator('.element.changed').count(), 0);
    await page.locator('#history-slider').evaluate((slider, value) => {
      slider.value = value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, history);
    assert.equal(await card('a').locator('.element.changed').count(), 4);
    assert.match(await cell(3).getAttribute('title'), /本步新增/);
    assert.deepEqual(errors, []);
    console.log('通过：字符串交换全部变化格子高亮、新增提示、下一步清除和历史还原');
  } finally {
    try { if (await page.locator('#stop').isEnabled()) await action('stop'); }
    finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
