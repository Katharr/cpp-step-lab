// Spec 04：固定快照先验布局，再验真实 GCC/GDB；使用已有 Edge。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CODE_LAB_PLAYWRIGHT || 'playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const output = path.join(__dirname, 'qa', 'spec04');
const checks = [];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  let page;
  const card = (name) => page.locator(`[data-structure="${name}"]`);
  async function check(name, fn) { await fn(); checks.push(name); console.log('通过：' + name); }
  async function action(id, route = '/api/command') {
    const pending = page.waitForResponse((r) => r.url() === base + route && r.request().method() === 'POST');
    await page.locator('#' + id).evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    await page.locator('#' + id).click();
    const snapshot = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return snapshot;
  }
  async function sample(name) {
    if (await page.locator('#stop').isEnabled()) await action('stop');
    await page.locator('#example').selectOption(name);
    return action('start', '/api/start');
  }
  async function until(snapshot, predicate, motion = 'next') {
    for (let i = 0; i < 100; i++) {
      if (predicate(snapshot)) return snapshot;
      assert.equal(snapshot.status, 'paused', JSON.stringify(snapshot));
      snapshot = await action(motion);
    }
    throw new Error('未在 100 步内满足条件');
  }
  async function finish(snapshot, expected) {
    snapshot = await until(snapshot, (s) => s.status !== 'paused');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.output.stdout.trim(), expected);
  }
  try {
    await check('固定快照：矩阵坐标、读取失败、文本安全与精确越界指示', async () => {
      page = await context.newPage();
      const fixture = { runId: 'fixture', status: 'paused', step: 1, line: 1,
        frames: [{ id: 'f0', level: 0, function: 'main', user: true }], output: {},
        variables: [{ id: 'i', name: 'i', type: 'long long', state: 'ok', value: '9007199254740993', visible: true, kind: 'local', frame: 0 },
          { id: 'a', name: 'a', type: 'int [2][3]', state: 'ok', value: 'matrix · 6 个元素', visible: true, kind: 'local', frame: 0,
            data: { kind: 'matrix', shape: [2, 3], lowerBounds: [0, 0], total: 6, offset: 0, limit: 50, hidden: 0, state: 'ok',
              elements: Array.from({ length: 6 }, (_, i) => ({ index: i, coordinates: [Math.floor(i / 3), i % 3], state: i === 4 ? 'unavailable' : 'ok', value: i === 4 ? null : i === 0 ? '<img src=x onerror=alert(1)>' : String(i + 1), note: i === 4 ? '读取失败：无法访问内存' : null })) } }] };
      await page.route('**/api/**', (route) => route.fulfill({ json: route.request().url().endsWith('/health') ? { status: 'ready' } : fixture }));
      await page.goto(base);
      await action('start', '/api/start');
      assert.equal(await card('a').locator('[data-coordinates="1,0"]').evaluate((e) => e.style.gridRow + '/' + e.style.gridColumn), '3/2');
      assert.match(await card('a').locator('[data-coordinates="1,1"]').getAttribute('title'), /读取失败/);
      assert.equal(await card('a').locator('img').count(), 0);
      await card('a').getByLabel('a 行下标', { exact: true }).selectOption('i');
      assert.match(await card('a').locator('.index-status').textContent(), /9007199254740993.*越界/);
      assert.equal(await card('a').locator('.indexed').count(), 0);
      fixture.variables[0].value = '-1';
      await action('next');
      assert.match(await card('a').locator('.index-status').textContent(), /-1.*越界/);
      assert.equal(await card('a').locator('.indexed').count(), 0);
      // 读取窗口跨越一行末尾，不能把不连续列挤成伪造的相邻坐标。
      fixture.variables[1].data = {
        kind: 'matrix', shape: [4, 100], lowerBounds: [0, 0], total: 400, offset: 198, limit: 4, hidden: 396, state: 'ok',
        elements: [[1, 98], [1, 99], [2, 0], [2, 1]].map((coordinates, index) => ({ index: index + 198, coordinates, state: 'ok', value: String(index + 1) }))
      };
      await action('next');
      assert.deepEqual(await card('a').locator('.element').evaluateAll((elements) => elements.map((element) => element.dataset.coordinates)), ['1,98', '1,99', '2,0', '2,1']);
      assert.ok(await card('a').locator('.axis-gap').count() > 0, '不连续列应明确省略');
      assert.equal(await card('a').locator('.matrix-unread').count(), 4, '未读取交叉坐标不能补零');
      assert.deepEqual(await card('a').locator('.matrix-unread').allTextContents(), ['未读取', '未读取', '未读取', '未读取']);
      const positions = await card('a').locator('.element').evaluateAll((elements) => elements.map((element) => ({ row: element.style.gridRow, column: element.style.gridColumn })));
      assert.deepEqual(positions, [{ row: '2', column: '5' }, { row: '2', column: '6' }, { row: '3', column: '2' }, { row: '3', column: '3' }]);
      await page.close();
    });
    page = await context.newPage(); await page.goto(base);
    await check('二维遍历：行列指示随 i/j 变化，最终输出 21', async () => {
      let s = await sample('matrix');
      s = await until(s, (s) => ['i', 'j'].every((name) => s.variables.some((v) => v.name === name && v.visible && v.state === 'ok')));
      const i = s.variables.find((v) => v.name === 'i' && v.visible);
      const j = s.variables.find((v) => v.name === 'j' && v.visible);
      await card('a').getByLabel('a 行下标', { exact: true }).selectOption(i.id);
      await card('a').getByLabel('a 列下标', { exact: true }).selectOption(j.id);
      assert.equal(await card('a').locator('.indexed').getAttribute('data-coordinates'), `${i.value},${j.value}`);
      assert.equal(await card('a').locator('.element').count(), 6);
      await page.screenshot({ path: path.join(output, 'matrix.png'), fullPage: true });
      await finish(s, '21');
    });
    await check('前缀和：逐格变化与完整结果 0/3/4/8/10/15', async () => {
      let s = await sample('prefix');
      s = await until(s, (s) => s.variables.some((v) => v.name === 'b' && v.data?.elements.at(-1)?.value === '15'));
      assert.deepEqual(await card('b').locator('.element-value').allTextContents(), ['0', '3', '4', '8', '10', '15']);
      assert.equal(await card('b').locator('.element.changed').getAttribute('data-index'), '5');
      await finish(s, '15');
    });
    await check('vector/string：展开收起、追加、字符修改及高亮', async () => {
      let s = await sample('containers');
      s = await until(s, (s) => ['a', 'b'].every((name) => s.variables.some((v) => v.name === name && v.state === 'ok')));
      for (const name of ['a', 'b']) {
        assert.notEqual(await card(name).getAttribute('open'), null);
        await card(name).locator(':scope > summary').click();
        assert.equal(await card(name).getAttribute('open'), null);
        await card(name).locator(':scope > summary').click();
      }
      s = await until(s, (s) => s.variables.some((v) => v.name === 'a' && v.data?.total === 3));
      assert.deepEqual(await card('a').locator('.element-value').allTextContents(), ['3', '1', '4']);
      assert.notEqual(await card('a').getAttribute('open'), null);
      s = await until(s, (s) => s.variables.some((v) => v.name === 'b' && v.data?.elements[1]?.changed));
      assert.match(await card('b').locator('[data-index="1"] .element-value').textContent(), /'x'/);
      assert.equal(await card('b').locator('.element.changed').count(), 1);
      await card('a').locator(':scope > summary').click();
      assert.equal(await card('a').getAttribute('open'), null);
      assert.equal(await page.locator('#locals [data-variable="a"]').count(), 1);
      await page.screenshot({ path: path.join(output, 'containers.png'), fullPage: true });
      await finish(s, '3 axc');
    });
    await check('字符串长度：空输入与非空输入、声明执行后显示及历史回看', async () => {
      for (const [input, expected] of [['', ['0', '0']], ['12345 678\n', ['5', '3']]]) {
        if (await page.locator('#stop').isEnabled()) await action('stop');
        await page.locator('#edit').click();
        await page.locator('#source').fill(`#include <iostream>
#include <string>
int main() {
    std::string a, b; // a、b：输入的两个字符串
    std::cin >> a >> b;
    int n = a.size(); // n：第一个字符串长度
    int m = b.size(); // m：第二个字符串长度
    int c[1005] = {}, d[1005] = {}; // c、d：逆序数字数组
    std::cout << n << ' ' << m;
    return 0;
}
`);
        await page.locator('#stdin').fill(input);
        let s = await action('start', '/api/start');
        s = await until(s, (s) => s.line === 7);
        assert.equal(await page.locator('[data-variable="n"] .current-value').textContent(), expected[0]);
        assert.equal(await page.locator('#locals [data-variable="m"]').count(), 0);
        s = await action('next');
        assert.deepEqual(['n', 'm'].map((name) => s.variables.find((v) => v.name === name).state), ['ok', 'ok']);
        for (const [i, name] of ['n', 'm'].entries()) {
          assert.equal(await page.locator(`[data-variable="${name}"] .current-value`).textContent(), expected[i]);
        }
        await page.locator('#history-prev').click();
        assert.equal(await page.locator('#locals [data-variable="m"]').count(), 0);
        await page.locator('#history-latest').click();
        assert.equal(await page.locator('[data-variable="m"] .current-value').textContent(), expected[1]);
        s = await action('next');
        assert.equal(await card('c').locator('.element').count(), 50);
        assert.doesNotMatch(await page.locator('#locals').textContent(), /状态未确认/);
        await page.screenshot({ path: path.join(output, input ? 'string-length-input.png' : 'string-length-empty.png'), fullPage: true });
        await finish(s, expected.join(' '));
      }
    });
    await check('窗口最大和：数组初始化与区间和赋值后 mx 显示、变化及历史回看', async () => {
      if (await page.locator('#stop').isEnabled()) await action('stop');
      await page.locator('#edit').click();
      await page.locator('#source').fill(fs.readFileSync(path.join(__dirname, '../调试器/cases/window_max.cpp'), 'utf8'));
      await page.locator('#stdin').fill('5 2\n3 1 4 2 5\n');
      let s = await action('start', '/api/start');
      s = await until(s, (s) => s.line === 14);
      assert.equal(await page.locator('#locals [data-variable="mx"]').count(), 0);
      s = await action('next');
      assert.equal(await page.locator('[data-variable="mx"] .current-value').textContent(), '3');
      const observed = ['3'];
      s = await until(s, (snapshot) => {
        const item = snapshot.variables.find((v) => v.name === 'mx' && v.visible);
        assert.equal(item.state, 'ok');
        if (observed.at(-1) !== item.value) observed.push(item.value);
        return snapshot.line === 23;
      });
      assert.deepEqual(observed, ['3', '4', '5', '6', '7']);
      assert.equal(await page.locator('[data-variable="mx"] .current-value').textContent(), '7');
      await page.locator('#history-prev').click();
      assert.equal(await page.locator('[data-variable="mx"] .current-value').textContent(), '7');
      await page.locator('#history-latest').click();
      assert.equal(await page.locator('[data-variable="mx"] .current-value').textContent(), '7');
      await page.screenshot({ path: path.join(output, 'window-max.png'), fullPage: true });
      await finish(s, '7');
    });
    await check('相邻交换：仅真实变化格强调，右侧越界不指向合法格', async () => {
      let s = await sample('adjacent');
      s = await until(s, (s) => s.variables.some((v) => v.name === 'i' && v.state === 'ok'));
      await card('a').getByLabel('a 下标', { exact: true }).selectOption(s.variables.find((v) => v.name === 'i').id);
      assert.equal(await card('a').locator('.indexed').getAttribute('data-index'), '1');
      s = await until(s, (s) => s.variables.some((v) => v.name === 'a' && v.data?.elements[1]?.changed));
      assert.equal(await card('a').locator('.element.changed').getAttribute('data-index'), '1');
      s = await action('next');
      assert.equal(await card('a').locator('.element.changed').getAttribute('data-index'), '2');
      s = await action('next');
      assert.match(await card('a').locator('.index-status').textContent(), /越界/);
      assert.equal(await card('a').locator('.indexed').count(), 0);
      await finish(s, '4 1');
    });
    await check('百万数组：默认 50 格、窗口跳转不执行、隐藏数与窄屏', async () => {
      await page.locator('#edit').click();
      await page.locator('#source').fill('int a[1000000] = {};\nint main() {\n a[999999] = 7;\n return 0;\n}\n');
      const s = await action('start', '/api/start');
      assert.equal(s.variables.find((variable) => variable.name === 'a').data.elements.length, 50);
      assert.equal(await card('a').locator('.repeat-fold[aria-expanded="false"]').count(), 1);
      await card('a').locator('.repeat-fold').click();
      assert.equal(await card('a').locator('.element[data-coordinates]').count(), 50);
      assert.match(await card('a').locator('.window-info').textContent(), /已隐藏 999950/);
      await card('a').locator('.window-options > summary').click();
      const pending = page.waitForResponse((r) => r.url().endsWith('/api/window'));
      await card('a').getByLabel('a 窗口起点').fill('999995');
      await card('a').getByLabel('a 窗口大小').fill('10');
      await card('a').getByRole('button', { name: '应用窗口' }).click();
      const refreshed = await (await pending).json();
      assert.equal(refreshed.step, s.step); assert.equal(refreshed.line, s.line);
      await page.waitForFunction(() => document.querySelector('[data-structure="a"] .window-info').textContent.includes('已隐藏 999995'));
      assert.deepEqual(await card('a').locator('.element-index').allTextContents(), ['[999995]', '[999996]', '[999997]', '[999998]', '[999999]']);
      const after = await action('next');
      assert.equal(after.step, s.step + 1);
      assert.equal(await card('a').locator('.element.changed').getAttribute('data-index'), '999999');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, 'large-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await action('stop');
    });
    await check('递归：三层数组独立，切换调用帧查看局部变量', async () => {
      let s = await sample('recursive');
      s = await until(s, (s) => s.variables.filter((v) => v.name === 'a' && v.state === 'ok').length === 3, 'step');
      const arrays = s.variables.filter((v) => v.name === 'a' && v.state === 'ok');
      assert.equal(new Set(arrays.map((v) => v.id)).size, 3);
      await page.locator('#data-frame').selectOption(s.frames[2].id);
      assert.equal(await card('a').locator('[data-index="0"] .element-value').textContent(), '2');
      assert.equal(await page.locator('#frame-locals [data-variable="x"] .current-value').textContent(), '2');
      await page.locator('#frame-locals').getByRole('button', { name: '查看 a 的数组或容器' }).click();
      assert.equal(await page.locator('#data-frame').inputValue(), s.frames[2].id, '摘要定位保留所选递归帧');
      assert.equal(await card('a').locator('[data-index="0"] .element-value').textContent(), '2');
      await page.locator('#data-frame').selectOption(s.frames[0].id);
      assert.equal(await card('a').locator('[data-index="0"] .element-value').textContent(), '0');
      await page.screenshot({ path: path.join(output, 'recursion.png'), fullPage: true });
      await action('stop');
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: checks.length === 9 && !errors.length ? 'passed' : 'failed', passed: checks.length, checks, pageErrors: errors, checkedAt: new Date().toISOString() }, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
