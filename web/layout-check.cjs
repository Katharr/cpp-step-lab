// 同屏布局、字符高亮与真实单步闭环。浏览器及依赖均由本项目管理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const output = path.join(__dirname, 'qa', 'layout');
const checks = [];
const measurements = [];
const errors = [];
const onlyMock = process.argv.includes('--mock');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  let page = await context.newPage();
  async function check(name, run) { await run(); checks.push(name); console.log('通过：' + name); }
  async function action(id, endpoint = '/api/command') {
    await page.locator('#' + id).evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    const pending = page.waitForResponse((response) => response.url() === base + endpoint && response.request().method() === 'POST');
    await page.locator('#' + id).click();
    const snapshot = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return snapshot;
  }
  async function layout(label, minimumLines = 24) {
    const result = await page.evaluate(() => {
      const selectors = ['.source-panel', '.variables-panel', '.data-panel', '.input-panel', '.output-panel'];
      const panels = selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      });
      const code = document.querySelector(document.querySelector('#code-view').hidden ? '#source' : '#code-view');
      const style = getComputedStyle(code);
      const usableHeight = code.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return {
        viewport: { width: innerWidth, height: innerHeight }, panels,
        scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        fontSize: style.fontSize, lines: Math.floor(usableHeight / parseFloat(style.lineHeight))
      };
    });
    for (const panel of result.panels) {
      assert.ok(panel.width > 80 && panel.height > 80, `${label}: ${JSON.stringify(panel)}`);
      assert.ok(panel.x >= 0 && panel.y >= 0 && panel.right <= result.viewport.width + 1 && panel.bottom <= result.viewport.height + 1, `${label}: 面板溢出 ${JSON.stringify(panel)}`);
    }
    assert.ok(result.scrollWidth <= result.viewport.width, `${label}: 整页横向滚动`);
    assert.ok(result.scrollHeight <= result.viewport.height, `${label}: 整页纵向滚动`);
    assert.equal(result.fontSize, '20px');
    assert.ok(result.lines >= minimumLines, `${label}: 仅可见 ${result.lines} 行`);
    assert.ok(result.panels[0].height > result.panels[1].height, `${label}: 代码未通高`);
    assert.ok(result.panels[3].x < result.panels[4].x, `${label}: 输入输出未并排`);
    measurements.push({ label, ...result });
  }
  async function history(index) {
    await page.locator('#history-slider').evaluate((slider, value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, index);
  }
  async function ioState() {
    return page.evaluate(() => ({
      input: document.querySelector('#stdin-view').textContent,
      output: document.querySelector('#stdout').textContent,
      inputChanged: [...document.querySelectorAll('#stdin-view mark.io-changed')].map((mark) => mark.textContent).join(''),
      outputChanged: [...document.querySelectorAll('#stdout mark.io-changed')].map((mark) => mark.textContent).join('')
    }));
  }
  try {
    const input = '甲🙂 <img>\n';
    const prefix = Buffer.byteLength('甲🙂');
    const consumed = Buffer.byteLength('甲🙂 <img>');
    const unsafeOutput = '<script>甲🙂</script>';
    let fixtureStep = 0;
    const fixture = () => ({
      runId: 'layout-fixture', status: 'paused', step: fixtureStep, line: fixtureStep + 3,
      frames: [{ id: 'f0', level: 0, function: 'main', user: true, line: fixtureStep + 3 }],
      variables: [
        { id: 's', name: 's', type: 'const char *', frame: 0, kind: 'local', visible: true, state: 'ok', value: ('0x1234 "这是一段很长的课堂变量文本，需要在列表内部查看完整内容，同时不能覆盖相邻变量"').repeat(3) },
        { id: 'x', name: 'x', type: 'int', frame: 0, kind: 'local', visible: true, state: 'ok', value: String(fixtureStep) },
        { id: 'a', name: 'a', type: 'int [3]', frame: 0, kind: 'local', visible: true, state: 'ok', value: '{3, 1, 4}',
          data: { kind: 'array', shape: [3], lowerBounds: [0], total: 3, offset: 0, limit: 50, hidden: 0, state: 'ok',
            elements: [3, 1, 4].map((value, index) => ({ index, coordinates: [index], state: 'ok', value: String(value) })) } }
      ],
      inputTrace: fixtureStep === 3 ? { state: 'unavailable', note: '读取位置未确认' } : {
        state: 'ok', consumed: fixtureStep === 0 ? 0 : fixtureStep === 1 ? prefix : consumed,
        deltaStart: fixtureStep < 2 ? 0 : prefix, deltaEnd: fixtureStep === 0 ? 0 : fixtureStep === 1 ? prefix : consumed
      },
      output: { stdout: fixtureStep === 0 ? '' : unsafeOutput + (fixtureStep >= 2 ? '\n' : ''), stderr: '' },
      outputDelta: { stdout: fixtureStep === 1 ? unsafeOutput : fixtureStep === 2 ? '\n' : '', stderr: '' }, compile: {}
    });
    await page.route('**/api/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint === '/api/start') fixtureStep = 0;
      if (endpoint === '/api/command') fixtureStep++;
      const snapshot = fixture();
      if (endpoint === '/api/window') {
        snapshot.inputTrace = { ...snapshot.inputTrace, deltaStart: snapshot.inputTrace.consumed, deltaEnd: snapshot.inputTrace.consumed };
        snapshot.outputDelta = { stdout: '', stderr: '' };
      }
      await route.fulfill({ json: endpoint === '/api/health' ? { status: 'ready' } : snapshot });
    });
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const source = '// 同屏长代码验收\n' + Array.from({ length: 78 }, (_, index) => '// 第 ' + (index + 2) + ' 行').join('\n');
    await page.locator('#source').fill(source);
    await page.locator('#stdin').fill(input);
    await action('start', '/api/start');
    await check('三种桌面尺寸：四类信息同屏、代码至少 24 行、页面无滚动', async () => {
      const regions = await page.evaluate(() => {
        const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map((channel) => {
          const value = Number(channel) / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        return ['.source-panel', '.variables-panel', '.data-panel', '.input-panel', '.output-panel'].map((selector) => {
          const panel = document.querySelector(selector);
          const background = getComputedStyle(panel.querySelector('.panel-head')).backgroundColor;
          const marker = getComputedStyle(panel.querySelector('h2'), '::before').backgroundColor;
          const color = getComputedStyle(panel.querySelector('h2')).color;
          const values = [luminance(color), luminance(background)].sort((a, b) => a - b);
          return { selector, marker, background, contrast: (values[1] + .05) / (values[0] + .05) };
        });
      });
      assert.equal(new Set(regions.map((region) => region.marker)).size, 5, '五类面板通过标题色标定位');
      for (const region of regions) assert.ok(region.contrast >= 4.5, `${region.selector} 标题对比度不足：${region.contrast}`);
      for (const size of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
        await page.setViewportSize(size);
        await layout(`${size.width}×${size.height}`, size.height >= 1080 ? 36 : size.height >= 900 ? 30 : 24);
        const longValue = await page.locator('#locals [data-variable="s"]').evaluate((card) => {
          const value = card.querySelector('.value-cell');
          const bounds = card.getBoundingClientRect();
          const content = value.getBoundingClientRect();
          value.scrollLeft = value.scrollWidth;
          return { cardRight: bounds.right, contentRight: content.right, neighborTop: card.nextElementSibling.getBoundingClientRect().top, rowBottom: bounds.bottom,
            overflow: getComputedStyle(value).overflowX, scrollable: value.scrollWidth > value.clientWidth, moved: value.scrollLeft > 0 };
        });
        assert.ok(longValue.contentRight <= longValue.cardRight + 1 && longValue.rowBottom <= longValue.neighborTop + 1, '长值区域应限定在列表内，不得覆盖相邻变量');
        assert.equal(longValue.overflow, 'auto');
        assert.ok(longValue.scrollable && longValue.moved, '长值应能在列表内部横滚查看：' + JSON.stringify(longValue));
        for (const selector of ['#code-view', '#locals .current-value', '[data-structure="a"] .element', '#stdin-view', '#stdout']) {
          assert.equal(await page.locator(selector).first().isVisible(), true, selector);
        }
        await page.screenshot({ path: path.join(output, `${size.width}x${size.height}.png`) });
      }
    });
    await check('UTF-8 中文与 emoji 高亮、文本安全、历史还原与未知位置', async () => {
      await action('next');
      const first = await ioState();
      assert.deepEqual(first, { input, output: unsafeOutput, inputChanged: '甲🙂', outputChanged: unsafeOutput });
      assert.equal(await page.locator('#stdin-view img, #stdout script').count(), 0);
      await page.locator('[data-structure="a"] .window-options > summary').click();
      const windowResponse = page.waitForResponse((response) => response.url().endsWith('/api/window'));
      await page.locator('[data-structure="a"]').getByRole('button', { name: '应用窗口' }).click();
      await windowResponse;
      await page.waitForFunction(() => !document.querySelector('#next').disabled);
      assert.deepEqual(await ioState(), first, '仅更换数组窗口时应保留本步 I/O 高亮');
      await action('next');
      assert.equal((await ioState()).inputChanged, ' <img>');
      assert.equal((await ioState()).outputChanged, '\n');
      assert.equal(await page.locator('#stdin-view .io-consumed').textContent(), '甲🙂');
      await history(1);
      assert.deepEqual(await ioState(), first);
      await page.locator('#history-latest').click();
      await action('next');
      assert.equal((await ioState()).input, input);
      assert.equal((await ioState()).inputChanged, '');
      assert.match(await page.locator('#stdin-view').getAttribute('title'), /未确认/);
    });
    await check('分隔线键盘、拖动、边界与刷新后恢复', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('#code-splitter').press('ArrowRight');
      assert.equal(await page.locator('#code-splitter').getAttribute('aria-valuenow'), '46');
      await page.locator('#io-splitter').press('ArrowDown');
      assert.equal(await page.locator('#io-splitter').getAttribute('aria-valuenow'), '77');
      const rect = await page.locator('#code-splitter').boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + 50, rect.y + rect.height / 2, { steps: 6 });
      await page.mouse.up();
      const width = await page.locator('#code-splitter').getAttribute('aria-valuenow');
      assert.ok(Number(width) > 46);
      await page.reload();
      assert.equal(await page.locator('#code-splitter').getAttribute('aria-valuenow'), width);
      assert.equal(await page.locator('#io-splitter').getAttribute('aria-valuenow'), '77');
      for (let i = 0; i < 12; i++) await page.locator('#code-splitter').press('Shift+ArrowRight');
      assert.equal(await page.locator('#code-splitter').getAttribute('aria-valuenow'), '65');
      await layout('分隔线边界');
      await page.locator('#code-splitter').dblclick();
      await page.locator('#io-splitter').dblclick();
      assert.equal(await page.locator('#code-splitter').getAttribute('aria-valuenow'), '45');
      assert.equal(await page.locator('#io-splitter').getAttribute('aria-valuenow'), '76');
      const initial = await page.locator('.variables-panel').boundingBox();
      await page.locator('#variables-splitter').press('ArrowDown');
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), '142');
      assert.ok((await page.locator('.variables-panel').boundingBox()).height > initial.height);
      const divider = await page.locator('#variables-splitter').boundingBox();
      await page.mouse.move(divider.x + divider.width / 2, divider.y + 4);
      await page.mouse.down();
      await page.mouse.move(divider.x + divider.width / 2, divider.y + 44, { steps: 5 });
      await page.mouse.up();
      const variablesHeight = await page.locator('#variables-splitter').getAttribute('aria-valuenow');
      assert.ok(Number(variablesHeight) > 142);
      await page.reload();
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), variablesHeight);
      for (let i = 0; i < 20; i++) await page.locator('#variables-splitter').press('Shift+ArrowDown');
      await layout('变量分隔线上限');
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), await page.locator('#variables-splitter').getAttribute('aria-valuemax'));
      for (let i = 0; i < 20; i++) await page.locator('#variables-splitter').press('Shift+ArrowUp');
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), '84');
      await page.locator('#variables-splitter').dblclick();
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), '134');
    });
    await check('课例保存载入保留代码、输入及布局比例', async () => {
      await page.locator('#source').fill(source);
      await page.locator('#stdin').fill(input);
      await page.locator('#code-splitter').press('Shift+ArrowLeft');
      await page.locator('#io-splitter').press('Shift+ArrowDown');
      await page.locator('#variables-splitter').press('ArrowDown');
      await page.locator('.more-menu > summary').click();
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#save-case').click();
      const download = await downloadPromise;
      const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.equal(saved.code, source);
      assert.equal(saved.input, input);
      assert.deepEqual(saved.display.layout, { codeWidth: 40, stateHeight: 80, variablesHeight: 142 });
      await page.locator('#case-file').setInputFiles({ name: '课例.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已载入'));
      assert.equal(await page.locator('#source').inputValue(), source);
      assert.equal(await page.locator('#stdin').inputValue(), input);
      assert.equal(await page.locator('#code-splitter').getAttribute('aria-valuenow'), '40');
      assert.equal(await page.locator('#io-splitter').getAttribute('aria-valuenow'), '80');
      assert.equal(await page.locator('#variables-splitter').getAttribute('aria-valuenow'), '142');
      await page.locator('#variables-splitter').dblclick();
      await download.delete();
    });
    await page.close();
    await check('一维数组：6/30/200 格永不折行，长数字、内部横滚与刷新位置保留', async () => {
      page = await context.newPage();
      let count = 6;
      let step = 0;
      const strip = (name) => ({ id: name, name, type: `long long [${count}]`, frame: 0, kind: 'local', visible: true, state: 'ok', value: 'array',
        data: { kind: 'array', shape: [count], lowerBounds: [0], total: count, offset: 0, limit: count, hidden: 0, state: 'ok',
          elements: Array.from({ length: count }, (_, index) => ({ index, coordinates: [index], state: 'ok', value: index === 0 ? String(9000000000000000 + step) : String(index), changed: step > 0 && index === 0, previousValue: '9000000000000000' })) } });
      await page.route('**/api/**', async (route) => {
        const endpoint = new URL(route.request().url()).pathname;
        const stopped = endpoint === '/api/command' && route.request().postDataJSON()?.command === 'stop';
        if (endpoint === '/api/start') step = 0;
        if (endpoint === '/api/command') step++;
        await route.fulfill({ json: endpoint === '/api/health' ? { status: 'ready' } : {
          runId: 'strip-fixture', status: stopped ? 'stopped' : 'paused', step, line: step + 1, frames: [{ id: 'f0', level: 0, function: 'main', user: true }], output: {},
          variables: [{ id: 'i', name: 'i', type: 'int', value: '0', state: 'ok', visible: true, kind: 'local', frame: 0 }, strip('a'), strip('b')]
        } });
      });
      await page.goto(base);
      for (const length of [6, 30, 200]) {
        if (await page.locator('#stop').isEnabled()) await action('stop');
        count = length;
        await action('start', '/api/start');
        for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1093, height: 614 }]) {
          await page.setViewportSize(size);
          const geometry = await page.evaluate(() => [...document.querySelectorAll('.data-card')].map((card) => {
            const cells = [...card.querySelectorAll('.element')];
            const scroll = card.querySelector('.structure-scroll');
            return { rows: new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top))).size, count: cells.length,
              scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
              readable: cells.every((cell) => { const value = cell.querySelector('.element-value'); return value.scrollWidth <= value.clientWidth + 1 && parseFloat(getComputedStyle(value).fontSize) >= 20; }) };
          }));
          assert.equal(geometry.length, 2, '两个数组各自独立显示');
          for (const result of geometry) {
            assert.equal(result.rows, 1, `${length} 格在 ${size.width}px 下发生折行`);
            assert.equal(result.count, length);
            assert.equal(result.readable, true, '长数字完整显示且至少 20px');
            if (length >= 30) assert.ok(result.scrollWidth > result.clientWidth, '长数组应在内部横滚');
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '整页不能横向溢出');
        }
        await page.locator('[data-structure="a"] .structure-scroll').evaluate((element) => { element.scrollLeft = 80; });
        const position = await page.locator('[data-structure="a"] .structure-scroll').evaluate((element) => element.scrollLeft);
        await action('next');
        assert.equal(await page.locator('[data-structure="a"] .structure-scroll').evaluate((element) => element.scrollLeft), position, '单步保留横滚位置');
        await page.locator('[data-structure="a"]').getByLabel('a 下标', { exact: true }).selectOption('i');
        assert.equal(await page.locator('[data-structure="a"] .structure-scroll').evaluate((element) => element.scrollLeft), position, '下标设置保留横滚位置');
        assert.equal(await page.locator('[data-structure="a"] .element.changed.indexed').count(), 1, '变化与下标状态可以同时呈现');
        assert.match(await page.locator('[data-structure="a"] .index-status').textContent(), /i = 0/);
      }
      await page.screenshot({ path: path.join(output, 'array-strips.png') });
    });
    await check('动效偏好：尊重系统减少动态，关闭后保留变化标记及历史', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.more-menu > summary').click();
      await page.locator('#motion').selectOption('standard');
      assert.equal(await page.locator('html').getAttribute('data-motion'), 'reduced');
      await page.locator('#motion').selectOption('off');
      await action('next');
      assert.equal(await page.locator('html').getAttribute('data-motion'), 'off');
      assert.equal(await page.locator('[data-structure="a"] .element.changed.indexed').count(), 1);
      assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length), 0, '关闭后不能仍有动画播放');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('#motion').evaluate((select) => { select.closest('details').open = true; });
      await page.locator('#motion').selectOption('standard');
      await page.locator('#motion').evaluate((select) => { select.closest('details').open = false; });
      await page.evaluate(() => {
        window.__feedbackCalls = [];
        window.__originalAnimate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          window.__feedbackCalls.push({ value: this.matches('.element-value') && Boolean(this.closest('.changed')), code: Boolean(this.closest('.code-line.current')) });
          return window.__originalAnimate.apply(this, args);
        };
      });
      try {
        await action('next');
        const feedback = await page.evaluate(() => window.__feedbackCalls);
        assert.ok(feedback.some((call) => call.value), '标准模式单步必须触发真实变化格的动画');
        assert.ok(feedback.some((call) => call.code), '标准模式必须反馈下一条执行位置');
      } finally {
        await page.evaluate(() => { Element.prototype.animate = window.__originalAnimate; delete window.__originalAnimate; delete window.__feedbackCalls; });
      }
      await page.locator('#speed').selectOption('120');
      const played = page.waitForResponse((response) => response.url() === base + '/api/command' && response.request().method() === 'POST');
      await page.locator('#play').click();
      await played;
      await page.locator('#pause').click();
      await page.waitForFunction(() => !/正在执行/.test(document.querySelector('#status').textContent));
      assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running' && animation.effect?.target?.closest('.element, .current-value, .code-line, .moving-pointer')).length), 0, '120ms 快播放不能叠加教学位移动效');
      await history(0);
      assert.match(await page.locator('#history-state').textContent(), /回看/);
      assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running' && animation.effect?.target?.closest('.element, .current-value, .code-line, .moving-pointer')).length), 0, '回看立即呈现快照');
      await page.locator('#motion').evaluate((select) => { select.closest('details').open = true; });
      await page.locator('#motion').selectOption('off');
      await page.reload();
      assert.equal(await page.locator('#motion').inputValue(), 'off', '偏好刷新后保留');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.close();
    });
    if (!onlyMock) {
      await check('真实大数组：未确认变量完整显示、两组数组同屏与摘要定位', async () => {
        page = await context.newPage();
        await page.goto(base);
        await page.locator('#code-splitter').dblclick();
        await page.locator('#io-splitter').dblclick();
        const source = '#include <iostream>\nusing namespace std;\n\nint a[100005], b[100005]; // a：计数数组；b：前缀和数组\n\nint main() {\n\n    int n, q; // n：输入数量；q：查询数量\n    cin >> n >> q;\n    for (int i = 1; i <= n; i++) { // i：输入序号\n        int t; // t：当前输入值\n        cin >> t;\n        a[t]++;\n    }\n    for (int i = 1; i <= 100000; i++) { // i：当前下标\n        b[i] = b[i - 1] + a[i];\n    }\n    while (q--) {\n        int l, r; // l：左端点；r：右端点\n        cin >> l >> r;\n        cout << b[r] - b[l - 1] << endl;\n    }\n    return 0;\n}\n';
        await page.locator('#source').fill(source);
        await page.locator('#stdin').fill('3 1\n1 2 2\n1 2\n');
        let snapshot = await action('start', '/api/start');
        for (let i = 0; i < 6 && snapshot.line !== 9; i++) snapshot = await action('next');
        assert.equal(snapshot.line, 9);
        for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2559, height: 1345 }]) {
          await page.setViewportSize(size);
          const geometry = await page.evaluate(() => {
            const body = document.querySelector('.data-body').getBoundingClientRect();
            const variables = document.querySelector('.variables-body');
            return {
              arrays: [...document.querySelectorAll('.data-card')].map((card) => {
                const rect = card.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, visible: rect.top >= body.top && rect.bottom <= body.bottom };
              }),
              values: [...document.querySelectorAll('#locals .current-value')].map((value) => {
                const cell = value.closest('td');
                return { text: value.textContent, full: cell.scrollWidth <= cell.clientWidth + 1 };
              }),
              variableOverflow: variables.scrollWidth > variables.clientWidth,
              ioRatio: document.querySelector('.io-grid').getBoundingClientRect().height / document.querySelector('.inspector').getBoundingClientRect().height
            };
          });
          assert.equal(geometry.arrays.length, 2);
          assert.ok(geometry.arrays.every((array) => array.visible), JSON.stringify({ size, geometry }));
          assert.equal(geometry.values.length, 2);
          assert.ok(geometry.values.every((value) => value.full && /待确认|未赋值/.test(value.text)), JSON.stringify(geometry));
          assert.equal(geometry.variableOverflow, false);
          assert.ok(geometry.ioRatio < .26);
          await page.screenshot({ path: path.join(output, `large-arrays-${size.width}.png`) });
        }
        await page.getByRole('button', { name: '查看 b 的数组或容器' }).click();
        assert.equal(await page.locator('[data-structure="b"] > summary').evaluate((summary) => summary === document.activeElement), true);
        assert.equal(await page.locator('[data-structure="b"]').getAttribute('open'), '');
        const read = await action('next');
        assert.equal(read.variables.find((variable) => variable.name === 'n').value, '3');
        assert.equal(read.variables.find((variable) => variable.name === 'q').value, '1');
        assert.equal(await page.locator('#locals [data-variable="n"] .current-value').textContent(), '3');
        assert.equal(await page.locator('#locals [data-variable="q"] .current-value').textContent(), '1');
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.screenshot({ path: path.join(output, 'input-confirmed.png') });
        await action('stop');
        await page.close();
      });
      page = await context.newPage();
      await page.goto(base);
      await page.locator('#source').fill('#include <iostream>\n#include <string>\nusing namespace std;\nint main() {\n    int x = 0; // x = 输入的数\n    string s; // s = 输入的文字\n    int a[2] = {3, 1}; // a = 数组\n    cin >> x;\n    cin >> s;\n    a[0] = x;\n    cout << s << endl;\n    cout << a[0] << endl;\n    return 0;\n}\n');
      await page.locator('#stdin').fill('12 甲🙂\n');
      await check('真实 GCC/GDB：输入消费、新增输出高亮、数组变化与历史同步', async () => {
        let snapshot = await action('start', '/api/start');
        const states = [{ snapshot, io: await ioState() }];
        let sawArray = false;
        let sawArrayChange = false;
        while (snapshot.status === 'paused' && states.length < 40) {
          snapshot = await action('next');
          states.push({ snapshot, io: await ioState() });
          const array = snapshot.variables.find((variable) => variable.name === 'a' && variable.visible && variable.data);
          if (array) {
            sawArray = true;
            assert.equal(await page.locator('[data-structure="a"] .element').count(), 2);
            sawArrayChange ||= array.data.elements[0].changed === true;
          }
          await layout('真实单步');
        }
        assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
        assert.equal(snapshot.output.stdout.replace(/\r\n/g, '\n').trim(), '甲🙂\n12');
        assert.ok(sawArray && sawArrayChange, '应观察到数组及数组元素变化');
        const readNumber = states.findIndex((state) => state.io.inputChanged.includes('12'));
        const readText = states.findIndex((state) => state.io.inputChanged.includes('甲🙂'));
        const wroteText = states.findIndex((state) => state.io.outputChanged.includes('甲🙂'));
        assert.ok(readNumber > 0 && readText > readNumber && wroteText > readText, '输入输出高亮必须对应不同执行步');
        for (const index of [readNumber, readText, wroteText]) {
          await history(index);
          assert.deepEqual(await ioState(), states[index].io);
          assert.equal(await page.locator('.code-line.current').getAttribute('data-line'), String(states[index].snapshot.line));
          if (index === wroteText) await page.screenshot({ path: path.join(output, 'real-paused.png') });
        }
        await page.locator('#history-latest').click();
        await page.screenshot({ path: path.join(output, 'real-completed.png') });
      });
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: checks.length === (onlyMock ? 6 : 8) && !errors.length ? 'passed' : 'failed', checks, measurements, pageErrors: errors, checkedAt: new Date().toISOString() }, null, 2));
  }
  console.log('同屏验收全部通过：' + checks.length + ' 项');
})().catch((error) => { console.error(error); process.exitCode = 1; });
