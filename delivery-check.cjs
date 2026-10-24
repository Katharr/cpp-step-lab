// 第 06 阶段：本机 Edge + 完整发布包，拦截全部外网请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');
const root = process.env.CODE_LAB_RELEASE || path.join(__dirname, '发布/代码实验台-1.0.0-Windows-x64');
const output = path.join(__dirname, '验收输出');
const base = 'http://127.0.0.1:8765';
const checks = [], errors = [], external = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-first-run', '--disable-background-networking'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (/^(file:|data:|blob:|http:\/\/127\.0\.0\.1:8765\/)/.test(request.url())) request.continue();
    else { external.push(request.url()); request.abort(); }
  });
  async function check(name, fn) {
    const started = Date.now();
    await fn();
    checks.push({ name, seconds: (Date.now() - started) / 1000 });
    console.log('通过：' + name);
  }
  async function action(id, route = '/api/command') {
    await page.$eval('#' + id, (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    const pending = page.waitForResponse((r) => r.url() === base + route && r.request().method() === 'POST');
    await page.click('#' + id);
    const result = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return result;
  }
  async function load(name) {
    if (await page.$eval('#stop', (el) => !el.disabled)) await action('stop');
    await (await page.$('#case-file')).uploadFile(path.join(root, '课例', name + '.json'));
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('课例已载入'));
    assert.equal(await page.$eval('#source', (el) => el.value), JSON.parse(fs.readFileSync(path.join(root, '课例', name + '.json'))).code);
    const result = await action('start', '/api/start');
    assert.equal(result.status, 'paused', JSON.stringify(result));
    return result;
  }
  async function edit(code) {
    if (await page.$eval('#stop', (el) => !el.disabled)) await action('stop');
    await page.click('#edit');
    await page.$eval('#source', (el, code) => { el.value = code; el.dispatchEvent(new Event('input')); }, code);
    return action('start', '/api/start');
  }
  async function finish(snapshot, command = 'next') {
    for (let i = 0; i < 110 && snapshot.status === 'paused'; i++) snapshot = await action(command);
    assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
    return snapshot;
  }
  try {
    await check('发布包中文路径、独立样式与服务连接', async () => {
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#connection').textContent === '本地服务已连接');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#2563c4');
    });
    await check('变量交换：单步、变化值与完整输出', async () => {
      let s = await load('swap');
      s = await action('next');
      assert.equal(await page.$eval('[data-variable="x"] .current-value', (el) => el.textContent), '9007199254740993');
      await finish(s);
      assert.equal((await page.$eval('#stdout', (el) => el.textContent)).trim(), '2 9007199254740993');
    });
    await check('数组求和：课例载入、播放、暂停、历史回看', async () => {
      await load('array');
      await page.select('#speed', '120');
      await page.click('#play');
      await page.waitForFunction(() => Number(document.querySelector('#history-slider').max) >= 3);
      await page.click('#pause');
      await page.waitForFunction(() => !/正在执行/.test(document.querySelector('#status').textContent));
      await sleep(250);
      const count = await page.$eval('#history-count', (el) => el.textContent);
      await sleep(350);
      assert.equal(await page.$eval('#history-count', (el) => el.textContent), count);
      await page.click('#history-prev');
      assert.match(await page.$eval('#history-state', (el) => el.textContent), /回看/);
      await page.click('#history-latest');
      await page.click('#play');
      await page.waitForFunction(() => document.querySelector('#status').textContent === '运行结束');
      assert.equal((await page.$eval('#stdout', (el) => el.textContent)).trim(), '10');
    });
    await check('二维遍历：格子、行列和结果 21', async () => {
      let s = await load('matrix');
      for (let i = 0; i < 4; i++) s = await action('next');
      assert.ok(await page.$('[data-structure="a"] .element'));
      await page.screenshot({ path: path.join(output, 'matrix.png'), fullPage: true });
      await finish(s);
      assert.equal((await page.$eval('#stdout', (el) => el.textContent)).trim(), '21');
    });
    await check('递归：进入函数、独立调用帧、返回结果 3', async () => {
      let s = await load('recursive');
      let sawFrames = false;
      for (let i = 0; i < 90 && s.status === 'paused'; i++) {
        s = await action('step');
        if (s.frames?.length >= 3) sawFrames = true;
      }
      assert.equal(s.status, 'completed', JSON.stringify(s));
      assert.equal(sawFrames, true);
      assert.equal((await page.$eval('#stdout', (el) => el.textContent)).trim(), '3');
    });
    await check('编译失败：提示、行号定位与恢复', async () => {
      const s = await edit('int main() {\n int x = ; // x = 待赋值的数\n}\n');
      assert.equal(s.status, 'compile_error');
      await page.click('#diagnostic-links button');
      assert.equal(await page.$eval('.compile-error', (el) => el.dataset.line), '2');
      await finish(await load('swap'));
    });
    await check('死循环：执行中停止、重新运行', async () => {
      await edit('int main() {\n while (true) { }\n}\n');
      const pending = page.waitForRequest((r) => r.url().endsWith('/api/command'));
      await page.click('#next');
      await pending;
      assert.equal((await action('stop')).status, 'stopped');
      await finish(await load('swap'));
    });
    await check('运行异常与大数组窗口：均可恢复', async () => {
      let s = await edit('int main() {\n int *p = 0; // p = 空指针\n *p = 1;\n}\n');
      for (let i = 0; i < 6 && s.status === 'paused'; i++) s = await action('next');
      assert.equal(s.status, 'runtime_error');
      s = await edit('int a[100000] = {}; // a = 大数组\nint main() {\n a[99999] = 7;\n return 0;\n}\n');
      const a = s.variables.find((v) => v.name === 'a');
      assert.equal(a.data.elements.length, 50);
      const pending = page.waitForResponse((r) => r.url().endsWith('/api/window'));
      await page.click('[data-structure="a"] .window-options > summary');
      await page.$eval('[aria-label="a 窗口起点"]', (el) => { el.value = '99990'; el.form.requestSubmit(); });
      const refreshed = await (await pending).json();
      assert.equal(refreshed.variables.find((v) => v.name === 'a').data.elements.length, 10);
      assert.equal(refreshed.step, s.step);
      await finish(s);
      await finish(await load('swap'));
    });
    await check('窄屏、文件直开及关闭页面', async () => {
      await page.setViewport({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(pathToFileURL(path.join(root, 'web/index.html')).href);
      await page.waitForFunction(() => document.querySelector('#connection').textContent === '本地服务已连接');
      await action('start', '/api/start');
      await action('next');
      await page.close();
      await sleep(600);
    });
    await check('服务未启动提示：双击 start.bat 与重新连接', async () => {
      const offline = await browser.newPage();
      offline.on('pageerror', (error) => errors.push(error.message));
      await offline.setRequestInterception(true);
      offline.on('request', (request) => request.url().includes('/api/') ? request.abort() : request.continue());
      await offline.goto(pathToFileURL(path.join(root, 'web/index.html')).href);
      await offline.waitForFunction(() => document.querySelector('#notice').textContent.includes('无法连接本地服务'));
      assert.match(await offline.$eval('#notice', (el) => el.textContent), /start\.bat/);
      await offline.close();
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } catch (error) {
    if (!page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
      console.error(await page.$eval('body', (el) => el.innerText));
    }
    throw error;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'browser.json'), JSON.stringify({ status: checks.length === 10 && !errors.length ? 'passed' : 'failed',
      checks, pageErrors: errors, externalRequests: external, root }, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
