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
    assert.deepEqual(errors, []);
    console.log('通过：课例异步载入期间锁定执行，完成后代码和输入与项目 JSON 一致');
  } finally {
    release();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
