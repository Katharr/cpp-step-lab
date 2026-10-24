// 先用固定快照检查展示，再用真实本地服务完成网页闭环。无需下载浏览器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.CODE_LAB_PLAYWRIGHT || 'playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const file = pathToFileURL(path.join(__dirname, 'index.html')).href;
const output = process.env.CODE_LAB_QA_OUTPUT || path.join(__dirname, 'qa');
const results = [];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  let page;
  async function check(name, fn) { await fn(); results.push(name); console.log('通过：' + name); }
  async function highlight(snapshot) {
    if (snapshot.status === 'paused') {
      const lines = await page.locator('.code-line.current').evaluateAll((rows) => rows.map((r) => Number(r.dataset.line)));
      assert.deepEqual(lines, snapshot.line && snapshot.frames?.[0]?.user !== false ? [snapshot.line] : []);
    } else if (snapshot.status !== 'compile_error') assert.equal(await page.locator('.code-line.current').count(), 0);
  }
  async function action(id, route = '/api/command') {
    const origin = page.url().startsWith('file:') ? 'http://127.0.0.1:8765' : base;
    const response = page.waitForResponse((r) => r.url() === origin + route && r.request().method() === 'POST');
    await reveal(id);
    await page.locator('#' + id).click();
    const snapshot = await (await response).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    await highlight(snapshot);
    return snapshot;
  }
  async function reveal(id) {
    await page.locator('#' + id).evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
  }
  async function begin() { return action('start', '/api/start'); }
  async function restart() { return action('restart', '/api/start'); }
  async function finish(snapshot) {
    for (let i = 0; i < 90 && snapshot.status === 'paused'; i++) snapshot = await action('next');
    assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
    return snapshot;
  }
  async function setCode(source, input = '') {
    if (await page.locator('#stop').isEnabled()) await action('stop');
    if (await page.locator('#dismiss-notice').isVisible()) await page.locator('#dismiss-notice').click();
    await page.locator('#edit').click();
    await page.locator('#source').fill(source);
    await page.locator('#stdin').fill(input);
  }
  try {
    await check('固定快照：大整数、状态屏蔽、变量分帧与文本安全', async () => {
      page = await context.newPage();
      let inLibrary = false;
      await page.route('**/api/**', async (route) => {
        const make = (name, extra) => ({ id: name, name, type: 'long long', frame: 0, kind: 'local', visible: true, state: 'ok', value: '9007199254740993', ...extra });
        const fixture = { runId: 'fixture', step: 0, line: 5, status: 'paused', frames: [{ function: inLibrary ? 'library' : 'main', line: 5, user: !inLibrary }],
          variables: [make('x'), make('s', { state: 'uninitialized', value: '999999', note: '尚未初始化' }),
            make('a', { state: 'unavailable', value: '888888', note: '读取失败' }),
            make('b', { value: '123', frame: 1, visible: false }),
            make('c', { value: '<img src=x onerror=alert(1)>', kind: 'global', frame: null })],
          output: { stdout: '<script>alert(1)</script>', stderr: '错误示例' }, compile: {} };
        await route.fulfill({ json: route.request().url().endsWith('/api/health') ? { status: 'ready' } : fixture });
      });
      await page.goto(base);
      await begin();
      assert.equal(await page.locator('[data-variable="x"] .current-value').textContent(), '9007199254740993');
      assert.equal(await page.locator('[data-variable="s"] .current-value').textContent(), '未赋值');
      assert.doesNotMatch(await page.locator('#locals').textContent(), /999999|888888/);
      assert.equal(await page.locator('#locals [data-variable="b"]').count(), 0);
      assert.equal(await page.locator('#globals img, #stdout script').count(), 0);
      assert.equal(await page.locator('#stdout').textContent(), '<script>alert(1)</script>');
      inLibrary = true;
      await restart();
      assert.match(await page.locator('#position').textContent(), /库函数/);
      assert.equal(await page.locator('.code-line.current').count(), 0);
      await page.close();
    });
    page = await context.newPage();
    await check('HTTP 首屏与投影布局', async () => {
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#connection').textContent === '本地服务已连接');
      for (const id of ['source', 'stdin', 'locals', 'stdout', 'start']) assert.equal(await page.locator('#' + id).isVisible(), true);
      assert.equal(await page.locator('#stderr').isVisible(), false);
      assert.equal(await page.locator('#source').evaluate((e) => getComputedStyle(e).fontSize), '20px');
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ['--accent', '--region-code', '--region-variables', '--region-data', '--region-input', '--region-output', '--region-history', '--state-next', '--state-change', '--state-index', '--state-error'].map((name) => ({ name, value: style.getPropertyValue(name).trim() }));
      });
      for (const token of palette) assert.match(token.value, /^#[0-9a-f]{6}$/i, `${token.name} 应提供有效的本地颜色`);
      assert.equal(new Set(palette.filter((token) => token.name.startsWith('--region-')).map((token) => token.value)).size, 6, '各教学区域应有稳定且不同的颜色身份');
      assert.notEqual(palette.find((token) => token.name === '--state-change').value, palette.find((token) => token.name === '--state-index').value, '值变化与下标关联使用不同状态色');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, '01-ready.png'), fullPage: true });
    });
    await check('交换：精确值、变化前后值、输出、停止与重跑', async () => {
      let snapshot = await begin();
      snapshot = await action('next');
      assert.equal(await page.locator('[data-variable="x"] .current-value').textContent(), '9007199254740993');
      const original = snapshot.runId;
      await action('stop');
      assert.equal(await page.locator('#status').textContent(), '已停止');
      snapshot = await restart();
      assert.notEqual(snapshot.runId, original);
      for (let i = 0; i < 4; i++) snapshot = await action('next');
      assert.equal(await page.locator('[data-variable="x"] .current-value').textContent(), '2');
      assert.equal(await page.locator('[data-variable="x"] .previous-value').textContent(), '9007199254740993');
      assert.equal(await page.locator('[data-variable="x"]').getAttribute('class'), 'changed');
      await page.screenshot({ path: path.join(output, '02-swap.png'), fullPage: true });
      await finish(snapshot);
      assert.equal((await page.locator('#stdout').textContent()).trim(), '2 9007199254740993');
    });
    await check('数组求和：输入、数组格子、逐步与输出', async () => {
      await page.locator('#example').selectOption('array');
      assert.match(await page.locator('#stdin').inputValue(), /3 1 4 2/);
      let snapshot = await begin();
      let sawArray = false;
      for (let i = 0; i < 65 && snapshot.status === 'paused'; i++) {
        snapshot = await action('next');
        if (snapshot.variables.some((v) => v.name === 'a' && v.visible)) {
          sawArray = true;
          const represented = await page.locator('[data-structure="a"]').evaluate((card) => {
            const indices = [...card.querySelectorAll('.element[data-coordinates]')].map((cell) => Number(cell.dataset.index));
            for (const fold of card.querySelectorAll('.repeat-fold[aria-expanded="false"]')) {
              const [first, last] = fold.dataset.foldRange.split(',').map(Number);
              for (let index = first; index <= last; index++) indices.push(index);
            }
            return indices.sort((a, b) => a - b);
          });
          assert.deepEqual(represented, Array.from({ length: 10 }, (_, index) => index));
        }
      }
      assert.equal(sawArray, true);
      assert.equal(snapshot.status, 'completed');
      assert.equal((await page.locator('#stdout').textContent()).trim(), '10');
    });
    await check('函数：进入、当前帧参数、全局变量与跳过调用', async () => {
      await page.locator('#example').selectOption('function');
      let snapshot = await begin();
      for (let i = 0; i < 8 && snapshot.line !== 13; i++) snapshot = await action('next');
      assert.equal(snapshot.line, 13);
      snapshot = await action('step');
      assert.match(await page.locator('#frame').textContent(), /f$/);
      assert.equal(await page.locator('#locals [data-variable="a"]').count(), 0);
      assert.equal(await page.locator('#locals [data-variable="x"] .current-value').textContent(), '5');
      assert.equal(await page.locator('#globals [data-variable="s"] .current-value').textContent(), '0');
      await page.screenshot({ path: path.join(output, '03-function.png'), fullPage: true });
      await finish(snapshot);
      assert.equal((await page.locator('#stdout').textContent()).trim(), '6');
      snapshot = await restart();
      for (let i = 0; i < 8 && snapshot.line !== 13; i++) snapshot = await action('next');
      snapshot = await action('over');
      assert.equal(snapshot.frames[0].function, 'main');
      assert.equal(await page.locator('#globals [data-variable="s"] .current-value').textContent(), '6');
      await action('stop');
    });
    await check('重复点击只发送一个单步；播放与暂停无后续推进', async () => {
      await page.locator('#example').selectOption('swap');
      await begin();
      let requests = 0;
      const count = (request) => { if (request.url().endsWith('/api/command')) requests++; };
      page.on('request', count);
      const response = page.waitForResponse((r) => r.url().endsWith('/api/command'));
      await page.locator('#next').evaluate((button) => { for (let i = 0; i < 12; i++) button.click(); });
      await response;
      await page.waitForFunction(() => document.querySelector('#status').textContent === '已暂停');
      assert.equal(requests, 1);
      await page.locator('#play').click();
      await page.locator('#pause').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent === '已暂停');
      const before = await page.locator('#position').textContent();
      const countBefore = requests;
      await page.waitForTimeout(900);
      assert.equal(await page.locator('#position').textContent(), before);
      assert.equal(requests, countBefore);
      page.off('request', count);
      await action('stop');
    });
    await check('编译错误定位与编辑恢复', async () => {
      await setCode('int main() {\n    int x = ;  // x = 待赋值的数\n}\n');
      const result = await begin();
      assert.equal(result.status, 'compile_error');
      assert.equal(await page.locator('#status').textContent(), '编译失败');
      assert.match(await page.locator('#notice').textContent(), /编译失败/);
      await page.locator('#diagnostic-links button').first().click();
      assert.equal(await page.locator('.compile-error').getAttribute('data-line'), '2');
      await page.screenshot({ path: path.join(output, '04-compile-error.png'), fullPage: true });
      await setCode('int main() {\n    return 0;\n}\n');
      assert.equal(await page.locator('#diagnostics').isVisible(), false);
      await finish(await begin());
    });
    await check('中文标准输入与 stdout/stderr 分离', async () => {
      await setCode('#include <cstdio>\nint main() {\n    int x = 0;  // x = 输入的数\n    std::scanf("%d", &x);\n    std::printf("中文:%d\\n", x);\n    std::fprintf(stderr, "error:%d\\n", x);\n    return 0;\n}\n', '42\n');
      await finish(await begin());
      assert.equal((await page.locator('#stdout').textContent()).trim(), '中文:42');
      assert.equal((await page.locator('#stderr').textContent()).trim(), 'error:42');
    });
    await check('运行异常中文提示与重跑', async () => {
      await setCode('int main() {\n    int *p = 0;  // p = 空指针\n    *p = 1;\n}\n');
      let snapshot = await begin();
      for (let i = 0; i < 6 && snapshot.status === 'paused'; i++) snapshot = await action('next');
      assert.equal(snapshot.status, 'runtime_error');
      assert.match(await page.locator('#notice').textContent(), /运行异常/);
      snapshot = await restart();
      assert.equal(snapshot.status, 'paused');
      await action('stop');
    });
    await check('执行中停止可中断，并能重跑', async () => {
      await setCode('int main() {\n    while (true) { }\n}\n');
      const first = await begin();
      const requested = page.waitForRequest((r) => r.url().endsWith('/api/command'));
      await page.locator('#next').click();
      await requested;
      const result = await action('stop');
      assert.equal(result.status, 'stopped');
      const fresh = await restart();
      assert.notEqual(fresh.runId, first.runId);
      await action('stop');
    });
    await check('服务断开后禁止继续旧会话，重连后重跑', async () => {
      await page.locator('#example').selectOption('swap');
      await begin();
      await page.route('**/api/command', (route) => route.abort());
      await page.locator('#next').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent === '连接中断');
      assert.equal(await page.locator('#next').isDisabled(), true);
      assert.match(await page.locator('#notice').textContent(), /无法连接本地服务/);
      await page.unroute('**/api/command');
      await reveal('reconnect');
      await page.locator('#reconnect').click();
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('开始新的运行'));
      assert.equal((await restart()).status, 'paused');
      await action('stop');
    });
    await check('窄屏无整页横向溢出', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, '05-mobile.png'), fullPage: true });
    });
    await page.close();
    page = await context.newPage();
    await check('直接打开中文路径 web/index.html 可连接与单步', async () => {
      await page.goto(file);
      await page.waitForFunction(() => document.querySelector('#connection').textContent === '本地服务已连接');
      await begin();
      const result = await action('next');
      assert.equal(result.status, 'paused');
      assert.equal(await page.locator('[data-variable="x"] .current-value').textContent(), '9007199254740993');
      await action('stop');
    });
    await page.close();
    page = await context.newPage();
    await check('服务未启动时首屏与开始操作均有中文提示', async () => {
      await page.route('**/api/**', (route) => route.abort());
      await page.goto(file);
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('无法连接本地服务'));
      await page.locator('#start').click();
      await page.waitForFunction(() => !document.querySelector('#start').disabled);
      assert.match(await page.locator('#notice').textContent(), /start\.bat/);
      assert.equal(await page.locator('#source').isVisible(), false);
      assert.equal(await page.locator('#code-view').isVisible(), true);
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: results.length === 14 && !errors.length ? 'passed' : 'failed', checkedAt: new Date().toISOString(), browser: browser.version(), passed: results.length, checks: results, pageErrors: errors }, null, 2));
  }
  console.log(`网页验收全部通过：${results.length} 项，截图：${output}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
