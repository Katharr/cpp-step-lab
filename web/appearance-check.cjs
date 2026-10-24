// 课堂外观：颜色语义、数组前缀窗口和编辑/执行语法主题；使用项目依赖与本机 Edge。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const output = path.join(__dirname, 'qa', 'appearance');
const checks = [];
const errors = [];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  let page = await context.newPage();
  const card = (name) => page.locator(`[data-structure="${name}"]`);
  async function check(name, run) { await run(); checks.push(name); console.log('通过：' + name); }
  async function reveal(selector) {
    await page.locator(selector).evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    });
  }
  async function action(id, endpoint = '/api/command') {
    await reveal('#' + id);
    const pending = page.waitForResponse((response) => response.url() === base + endpoint && response.request().method() === 'POST');
    await page.locator('#' + id).click();
    const result = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return result;
  }
  async function theme(name) {
    await reveal('#code-theme');
    await page.locator('#code-theme').selectOption(name);
    assert.equal(await page.locator('html').getAttribute('data-code-theme'), name);
    await page.locator('#code-theme').evaluate((select) => { select.closest('details').open = false; });
  }
  async function saveCase() {
    await reveal('#save-case');
    const pending = page.waitForEvent('download');
    await page.locator('#save-case').click();
    const download = await pending;
    const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    await download.delete();
    return saved;
  }
  const syntaxSource = '#include <iostream>\n/* 跨行注释：if 9007199254740993\n仍是注释 */\nconst char *s = R"tag(<img src=x onerror=alert(1)>\nif 9007199254740993 </script>)tag"; // s：原始字符串\nlong long x = 9007199254740993; // x：精确整数\nint main() {\n    std::cout << x;\n    return 0;\n}\n';
  try {
    let step = 0;
    let offset = 0;
    let limit = 12;
    let stopped = false;
    const fixture = () => ({
      runId: 'appearance-fixture', status: stopped ? 'stopped' : 'paused', step, line: 7 + step,
      frames: [{ id: 'f0', level: 0, function: 'main', user: true, line: 7 + step }], output: {},
      variables: [
        { id: 'n', name: 'n', type: 'int', kind: 'local', frame: 0, visible: true, state: step ? 'ok' : 'unavailable', value: step ? '3' : null, note: step ? null : '状态未确认：尚未观察到赋值' },
        { id: 'q', name: 'q', type: 'int', kind: 'local', frame: 0, visible: true, state: step ? 'ok' : 'uninitialized', value: step ? '4' : null, note: step ? null : '已执行声明，尚未初始化' },
        { id: 'i', name: 'i', type: 'int', kind: 'local', frame: 0, visible: true, state: 'ok', value: '0' },
        { id: 'j', name: 'j', type: 'int', kind: 'local', frame: 0, visible: true, state: 'ok', value: '8' },
        { id: 'a', name: 'a', type: 'int [12]', kind: 'local', frame: 0, visible: true, state: 'ok', value: 'array',
          data: { kind: 'array', shape: [12], lowerBounds: [0], total: 12, offset, limit, hidden: 12 - Math.min(limit, 12 - offset), state: 'ok',
            elements: Array.from({ length: Math.min(limit, 12 - offset) }, (_, index) => index + offset).map((index) => ({ index, coordinates: [index], state: index === 1 ? 'uninitialized' : 'ok', value: [0, 1, 3].includes(index) ? '0' : String(index), changed: step > 0 && index === 0, previousValue: '1' })) } },
        { id: 's', name: 's', type: 'std::string', kind: 'local', frame: 0, visible: true, state: 'ok', value: '"0a"',
          data: { kind: 'string', shape: [2], lowerBounds: [0], total: 2, offset: 0, limit: 2, hidden: 0, state: 'ok',
            elements: ["'0'", "'a'"].map((value, index) => ({ index, coordinates: [index], state: 'ok', value })) } }
      ]
    });
    await page.route('**/api/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : {};
      if (endpoint === '/api/start') { step = 0; stopped = false; }
      if (endpoint === '/api/command') { step++; stopped = body.command === 'stop'; }
      if (endpoint === '/api/window') { offset = body.offset; limit = body.limit; }
      await route.fulfill({ json: endpoint === '/api/health' ? { status: 'ready' } : fixture() });
    });
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await check('语法分词：跨行注释与原始字符串、HTML 安全及大整数源码保真', async () => {
      const parsed = await page.evaluate((source) => {
        const lines = CodeSyntax.highlight(source);
        const host = document.createElement('div');
        const records = lines.map((fragment) => {
          const line = document.createElement('div'); line.append(fragment); host.append(line);
          return { text: line.textContent, tokens: [...line.querySelectorAll('span')].map((token) => ({ text: token.textContent, kind: token.className })) };
        });
        return { records, unsafe: host.querySelectorAll('img,script').length };
      }, syntaxSource);
      assert.equal(parsed.records.map((line) => line.text).join('\n'), syntaxSource);
      assert.equal(parsed.unsafe, 0);
      assert.ok(parsed.records[0].tokens.some((token) => /token-preprocessor/.test(token.kind)));
      for (const index of [1, 2]) assert.ok(parsed.records[index].tokens.some((token) => /token-comment/.test(token.kind)), '跨行注释不能变为代码');
      for (const index of [3, 4]) assert.ok(parsed.records[index].tokens.some((token) => /token-string/.test(token.kind)), '跨行 raw string 应保持字符串');
      assert.ok(parsed.records[5].tokens.some((token) => /token-number/.test(token.kind) && token.text === '9007199254740993'));
    });
    await check('三个代码主题：编辑高亮同步、光标和横纵滚动保持', async () => {
      const source = syntaxSource + '// ' + '很长的课堂代码行 '.repeat(40) + '\n' + Array.from({ length: 75 }, (_, index) => '// 第 ' + index + ' 行').join('\n');
      await page.locator('#source').fill(source);
      await page.waitForFunction(() => document.querySelector('#edit-highlight').textContent.includes('9007199254740993'));
      const palettes = [];
      for (const name of ['light', 'dark', 'dracula']) {
        await theme(name);
        const state = await page.evaluate(() => {
          const editor = document.querySelector('#source');
          const layer = document.querySelector('#edit-highlight');
          const token = layer.querySelector('.token-number');
          return { text: layer.textContent, background: getComputedStyle(editor).backgroundColor, token: getComputedStyle(token).color };
        });
        assert.ok(state.text === source || state.text === source + '\n', '编辑高亮不能改写源码');
        palettes.push(state);
      }
      assert.equal(new Set(palettes.map((palette) => palette.token)).size, 3, '三个主题具有各自语法配色');
      await page.locator('#source').focus();
      await page.locator('#source').evaluate((editor) => editor.setSelectionRange(editor.value.indexOf('9007199254740993'), editor.value.indexOf('9007199254740993')));
      const before = await page.locator('#source').evaluate((editor) => editor.selectionStart);
      await page.keyboard.insertText('7');
      assert.equal(await page.locator('#source').evaluate((editor) => editor.selectionStart), before + 1, '高亮刷新不能抢走光标');
      await page.waitForFunction(() => document.querySelector('#edit-highlight').textContent.includes('79007199254740993'));
      await page.locator('#source').evaluate((editor) => { editor.scrollTop = 400; editor.scrollLeft = 150; editor.dispatchEvent(new Event('scroll')); });
      const scroll = await page.evaluate(() => {
        const editor = document.querySelector('#source'); const layer = document.querySelector('#edit-highlight');
        return { sourceTop: editor.scrollTop, sourceLeft: editor.scrollLeft, layerTop: layer.scrollTop, layerLeft: layer.scrollLeft };
      });
      assert.ok(scroll.sourceTop > 0 && scroll.sourceLeft > 0);
      assert.ok(Math.abs(scroll.sourceTop - scroll.layerTop) <= 1 && Math.abs(scroll.sourceLeft - scroll.layerLeft) <= 1, '高亮层跟随编辑器横纵滚动');
      await page.locator('#source').fill(syntaxSource);
      await page.screenshot({ path: path.join(output, 'editor-dracula.png') });
    });
    await check('状态反馈：灰色待确认、红色未赋值、首次确定值高亮与历史还原', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await action('start', '/api/start');
      const row = (name) => page.locator(`#locals [data-variable="${name}"]`);
      assert.equal(await row('n').locator('.current-value').textContent(), '待确认');
      assert.equal(await row('q').locator('.current-value').textContent(), '未赋值');
      const colors = await page.evaluate(() => {
        const probe = document.createElement('span'); document.body.append(probe);
        const color = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
        const n = document.querySelector('#locals [data-variable="n"] .current-value');
        const q = document.querySelector('#locals [data-variable="q"] .current-value');
        const result = { pending: getComputedStyle(n).color, gray: color('--muted'), uninitialized: getComputedStyle(q).color, red: color('--state-error'), warningBorder: getComputedStyle(q).borderTopStyle };
        probe.remove(); return result;
      });
      assert.equal(colors.pending, colors.gray);
      assert.equal(colors.uninitialized, colors.red);
      assert.equal(colors.warningBorder, 'solid');
      assert.equal(await page.locator('#locals .changed').count(), 0, '首屏不产生变化高亮');
      await page.screenshot({ path: path.join(output, 'variable-states.png') });
      await page.evaluate(() => {
        window.__stateFeedback = [];
        window.__stateAnimate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          if (this.matches('.current-value')) window.__stateFeedback.push(this.closest('tr')?.dataset.variable);
          return window.__stateAnimate.apply(this, args);
        };
      });
      try {
        await action('next');
        for (const [name, before, value] of [['n', '待确认', '3'], ['q', '未赋值', '4']]) {
          assert.equal(await row(name).locator('.current-value').textContent(), value);
          assert.match(await row(name).getAttribute('class'), /changed/);
          assert.equal(await row(name).locator('.value-before').textContent(), before + ' → ');
        }
        assert.deepEqual((await page.evaluate(() => window.__stateFeedback)).sort(), ['n', 'q']);
        const feedback = await page.evaluate(() => window.__stateFeedback.length);
        await page.locator('.more-menu > summary').click();
        await page.locator('#code-theme').selectOption('light');
        await page.locator('.more-menu > summary').click();
        assert.equal(await page.evaluate(() => window.__stateFeedback.length), feedback, '切换外观不重播状态动效');
        await page.screenshot({ path: path.join(output, 'variable-values-confirmed.png') });
        await action('next');
        assert.equal(await row('n').locator('.value-before').count(), 0);
        assert.doesNotMatch(await row('n').getAttribute('class') || '', /changed/);
        const animations = await page.evaluate(() => window.__stateFeedback.length);
        await page.locator('#history-prev').click();
        assert.equal(await row('n').locator('.value-before').textContent(), '待确认 → ');
        await page.locator('#history-prev').click();
        assert.equal(await row('q').locator('.current-value').textContent(), '未赋值');
        assert.equal(await page.evaluate(() => window.__stateFeedback.length), animations, '历史回看只还原高亮，不重播动效');
        await page.locator('#history-latest').click();
      } finally {
        await page.evaluate(() => { Element.prototype.animate = window.__stateAnimate; delete window.__stateAnimate; delete window.__stateFeedback; });
      }
      await action('stop');
    });
    await check('零值语义：数值零变灰，未知值和字符零不误标，变化与下标仍清楚', async () => {
      await action('start', '/api/start');
      assert.equal(await card('a').locator('[data-index="0"] .zero-value').count() + await card('a').locator('[data-index="0"].zero-value').count(), 1);
      assert.equal(await card('a').locator('[data-index="1"] .zero-value, [data-index="1"].zero-value').count(), 0);
      assert.equal(await card('s').locator('.zero-value').count(), 0, '字符 0 不代表数值零');
      await card('a').getByLabel('a 下标', { exact: true }).selectOption('i');
      await action('next');
      const cell = card('a').locator('[data-index="0"]');
      assert.match(await cell.getAttribute('class'), /changed/);
      assert.match(await cell.getAttribute('class'), /indexed/);
      assert.match(await card('a').locator('.index-status').textContent(), /i = 0/);
      const contrast = await cell.evaluate((element) => ({ outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderStyle, title: element.title }));
      assert.notEqual(contrast.outline, 'none', '下标指向仍有轮廓');
      assert.match(contrast.title, /上一步.*1.*当前.*0/);
    });
    await check('展示前几个：窗口从零开始且不执行代码，窗口外关联提示与课例持久化', async () => {
      const before = await page.locator('#history-count').textContent();
      const prefix = card('a').getByLabel('a 展示前几个元素', { exact: true });
      await reveal('[data-structure="a"] [data-prefix-limit]');
      await prefix.fill('3');
      const pending = page.waitForResponse((response) => response.url() === base + '/api/window');
      await card('a').getByRole('button', { name: /展示前.*个/ }).click();
      const response = await pending;
      assert.deepEqual({ offset: response.request().postDataJSON().offset, limit: response.request().postDataJSON().limit }, { offset: 0, limit: 3 });
      const snapshot = await response.json();
      assert.equal(snapshot.step, 1);
      await page.waitForFunction(() => document.querySelector('[data-structure="a"]').querySelectorAll('.element').length === 3);
      assert.equal(await page.locator('#history-count').textContent(), before);
      assert.deepEqual(await card('a').locator('.element').evaluateAll((elements) => elements.map((element) => element.dataset.index)), ['0', '1', '2']);
      assert.match(await card('a').locator('.window-info').textContent(), /已隐藏 9/);
      await card('a').getByLabel('a 下标', { exact: true }).selectOption('j');
      assert.match(await card('a').locator('.index-status').textContent(), /窗口之外/);
      const saved = await saveCase();
      assert.equal(saved.display.dataSettings.find((setting) => setting.id === 'a').prefixLimit, 3);
      await action('stop');
      await page.locator('#case-file').setInputFiles({ name: '课堂外观.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已载入'));
      const restored = await saveCase();
      assert.equal(restored.display.dataSettings.find((setting) => setting.id === 'a').prefixLimit, 3);
    });
    await check('执行主题、历史回看和刷新持久：主题变化不改变代码或快照', async () => {
      await action('start', '/api/start');
      await action('next');
      const colors = [];
      for (const name of ['light', 'dark', 'dracula']) {
        await theme(name);
        assert.equal(await page.locator('#source').inputValue(), syntaxSource);
        colors.push(await page.locator('#code-view .token-number').first().evaluate((token) => getComputedStyle(token).color));
        await page.locator('#history-prev').click();
        assert.equal(await page.locator('html').getAttribute('data-code-theme'), name);
        assert.match(await page.locator('#history-state').textContent(), /回看/);
        await page.locator('#history-latest').click();
      }
      assert.equal(new Set(colors).size, 3);
      assert.equal(await page.locator('#code-view img, #code-view script').count(), 0);
      assert.ok((await page.locator('#code-view').textContent()).includes('9007199254740993'));
      await page.screenshot({ path: path.join(output, 'execution-dracula.png') });
      await action('stop');
      await page.reload();
      assert.equal(await page.locator('#code-theme').inputValue(), 'dracula');
      assert.equal(await page.locator('html').getAttribute('data-code-theme'), 'dracula');
      assert.equal(await page.evaluate(() => localStorage.getItem('code-lab:code-theme:v1')), 'dracula');
    });
    await page.close();
    page = await context.newPage();
    await page.goto(base);
    await check('真实 GCC/GDB：数组零值、前缀窗口与单步变化', async () => {
      await page.locator('#source').fill('int main() {\n    int a[12] = {}; // a：零值数组\n    a[1] = 7;\n    return 0;\n}\n');
      let snapshot = await action('start', '/api/start');
      for (let index = 0; index < 10 && !snapshot.variables.some((variable) => variable.name === 'a' && variable.data?.elements.length === 12 && variable.data.elements.every((element) => element.state === 'ok' && element.value === '0')); index++) {
        assert.equal(snapshot.status, 'paused');
        snapshot = await action('next');
      }
      assert.equal(await card('a').locator('.element').count(), 12);
      assert.equal(await card('a').locator('.zero-value').count(), 12);
      const initialized = { step: snapshot.step, line: snapshot.line };
      await reveal('[data-structure="a"] [data-prefix-limit]');
      await card('a').getByLabel('a 展示前几个元素', { exact: true }).fill('3');
      const pending = page.waitForResponse((response) => response.url() === base + '/api/window');
      await card('a').getByRole('button', { name: /展示前.*个/ }).click();
      const refreshed = await (await pending).json();
      assert.equal(refreshed.step, snapshot.step);
      assert.equal(refreshed.line, snapshot.line);
      await page.waitForFunction(() => document.querySelector('[data-structure="a"]').querySelectorAll('.element').length === 3);
      snapshot = await action('next');
      assert.equal(await card('a').locator('[data-index="1"] .element-value').textContent(), '7');
      assert.equal(await card('a').locator('[data-index="1"].changed').count(), 1);
      assert.equal(await card('a').locator('[data-index="1"].zero-value, [data-index="1"] .zero-value').count(), 0);
      await page.screenshot({ path: path.join(output, 'array-zero-and-prefix.png') });
      for (let index = 0; index < 10 && snapshot.status === 'paused'; index++) snapshot = await action('next');
      assert.equal(snapshot.status, 'completed');
      async function restoredRun(command, oldRunId) {
        // 读取自动恢复窗口的真实响应，不能把原单步响应中的默认 limit 当作最终展示。
        const restored = page.waitForResponse((response) => response.url() === base + '/api/window');
        let current = await action(command, '/api/start');
        assert.notEqual(current.runId, oldRunId, '重新运行应创建新 runId');
        for (let index = 0; index < 10 && !current.variables.some((variable) => variable.name === 'a' && variable.data?.state === 'ok' && variable.data.elements.some((element) => element.state === 'ok')); index++) {
          assert.equal(current.status, 'paused');
          current = await action('next');
        }
        assert.deepEqual({ step: current.step, line: current.line }, initialized, '恢复展示范围不能额外推进初始化步骤');
        const response = await restored;
        const restoredSnapshot = await response.json();
        assert.equal(restoredSnapshot.runId, current.runId);
        assert.deepEqual({ step: restoredSnapshot.step, line: restoredSnapshot.line }, initialized);
        assert.deepEqual({ offset: response.request().postDataJSON().offset, limit: response.request().postDataJSON().limit }, { offset: 0, limit: 3 });
        const array = restoredSnapshot.variables.find((variable) => variable.name === 'a' && variable.data);
        assert.equal(array.data.limit, 3);
        assert.equal(array.data.hidden, 9);
        await page.waitForFunction(() => document.querySelector('[data-structure="a"]').querySelectorAll('.element').length === 3);
        assert.equal(await card('a').locator('.zero-value').count(), 3);
        assert.match(await card('a').locator('.window-info').textContent(), /已隐藏 9/);
        assert.equal(await card('a').getByLabel('a 展示前几个元素', { exact: true }).inputValue(), '3');
        return current;
      }
      snapshot = await restoredRun('restart', snapshot.runId);
      const saved = await saveCase();
      const savedArray = saved.display.dataSettings.find((setting) => setting.prefixApplied);
      assert.equal(savedArray.prefixLimit, 3);
      await action('stop');
      await page.locator('#case-file').setInputFiles({ name: '真实数组前缀课例.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已载入'));
      snapshot = await restoredRun('start', snapshot.runId);
      await action('stop');
    });
    await check('真实 GCC/GDB：待确认与未赋值经输入、复制后都有变化高亮', async () => {
      await page.locator('#edit').click();
      await theme('light');
      await page.locator('#variables-splitter').press('Shift+ArrowDown');
      await page.locator('#source').fill('#include <iostream>\nint main() {\n    int n; // n：输入的数\n    int s = 0; // s：执行位置标记\n    int q; // q：输入值的副本\n    s = 1;\n    std::cin >> n;\n    q = n;\n    std::cout << q << std::endl;\n    return 0;\n}\n');
      await page.locator('#stdin').fill('12\n');
      const row = (name) => page.locator(`#locals [data-variable="${name}"]`);
      let snapshot = await action('start', '/api/start');
      for (let i = 0; i < 5 && snapshot.line !== 6; i++) snapshot = await action('next');
      assert.equal(snapshot.line, 6);
      assert.equal(await row('n').locator('.current-value').textContent(), '待确认');
      assert.equal(await row('q').locator('.current-value').textContent(), '未赋值');
      await page.screenshot({ path: path.join(output, 'real-variable-states.png') });
      snapshot = await action('next');
      assert.equal(snapshot.line, 7);
      snapshot = await action('next');
      assert.equal(snapshot.line, 8);
      assert.equal(await row('n').locator('.current-value').textContent(), '12');
      assert.equal(await row('n').locator('.value-before').textContent(), '待确认 → ');
      assert.match(await row('n').getAttribute('class'), /changed/);
      snapshot = await action('next');
      assert.equal(snapshot.line, 9);
      assert.equal(await row('q').locator('.current-value').textContent(), '12');
      assert.equal(await row('q').locator('.value-before').textContent(), '未赋值 → ');
      assert.match(await row('q').getAttribute('class'), /changed/);
      assert.doesNotMatch(await row('n').getAttribute('class') || '', /changed/);
      await page.screenshot({ path: path.join(output, 'real-variable-confirmed.png') });
      await action('next');
      assert.doesNotMatch(await row('q').getAttribute('class') || '', /changed/);
      assert.equal((await page.locator('#stdout').textContent()).trim(), '12');
      await action('stop');
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: checks.length === 8 && !errors.length ? 'passed' : 'failed', checks, pageErrors: errors, checkedAt: new Date().toISOString() }, null, 2));
  }
  console.log('课堂外观验收全部通过：' + checks.length + ' 项');
})().catch((error) => { console.error(error); process.exitCode = 1; });
