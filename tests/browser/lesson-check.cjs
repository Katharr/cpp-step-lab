// 内置课例按需载入：网络延迟时不执行上一份代码，完成后与 JSON 内容一致。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.route('**/array.json', async (route) => { await pending; await route.continue(); });
    await page.locator('#example').selectOption('array');
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await page.locator('#source').isEditable(), false);
    release();
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    const lesson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../课例/array.json'), 'utf8'));
    assert.equal(await page.locator('#source').inputValue(), lesson.code);
    assert.equal(await page.locator('#stdin').inputValue(), lesson.input);
    assert.equal(await page.locator('#source').isEditable(), true);
    await page.evaluate(() => {
      window.__originalFileText = File.prototype.text;
      File.prototype.text = async function () {
        await new Promise((resolve) => { window.__releaseFileText = resolve; });
        return window.__originalFileText.call(this);
      };
    });
    const loaded = { ...lesson, code: 'int main() {\n    return 0;\n}\n', display: { ...lesson.display, mode: 'view' } };
    await page.locator('#case-file').setInputFiles({ name: '旧模式课例.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(loaded)) });
    await page.waitForFunction(() => typeof window.__releaseFileText === 'function');
    assert.equal(await page.locator('#start').isDisabled(), true, '读取文件期间不能运行上一份代码');
    assert.equal(await page.locator('#source').isEditable(), false, '读取文件期间禁止编辑被加载结果覆盖');
    await page.evaluate(() => window.__releaseFileText());
    await page.waitForFunction((code) => document.querySelector('#source').value === code && !document.querySelector('#source').readOnly, loaded.code);
    await page.evaluate(() => { File.prototype.text = window.__originalFileText; delete window.__originalFileText; delete window.__releaseFileText; });
    const started = page.waitForResponse((response) => response.url().endsWith('/api/start'));
    await page.locator('#start').click();
    await started;
    await page.waitForFunction(() => document.querySelector('#status').textContent === '已暂停');
    await page.locator('#case-file').setInputFiles({ name: '运行中不得替换.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(lesson)) });
    assert.equal(await page.locator('#source').inputValue(), loaded.code, '隐藏文件输入也不能绕过运行锁定');
    const stopped = page.waitForResponse((response) => response.url().endsWith('/api/command'));
    await page.locator('#stop').click();
    await stopped;
    assert.deepEqual(errors, []);
    console.log('通过：课例网络／文件异步载入锁定、旧模式兼容与运行中载入防护');
  } finally {
    release();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
