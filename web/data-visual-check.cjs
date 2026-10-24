// 当前窗口折叠、字符显示与读写位置保护；页面仍从本项目服务加载。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const variable = (name, kind, count, state = 'ok') => ({
    id: name, name, type: kind === 'string' ? 'std::string' : 'int [50]', kind: 'local', frame: 0, visible: true, state: 'ok', value: name,
    data: { kind, shape: kind === 'matrix' ? [2, 6] : [count], lowerBounds: kind === 'matrix' ? [0, 0] : [0], total: count, offset: 0, limit: count, hidden: 0, state: 'ok',
      note: kind === 'string' ? '按 char 字节显示；UTF-8 中文占多个格子，保留内嵌空字符' : null,
      elements: Array.from({ length: count }, (_, index) => ({ index, coordinates: kind === 'matrix' ? [Math.floor(index / 6), index % 6] : [index], state, value: state === 'ok' ? kind === 'string' ? index % 2 ? "48 '0'" : "49 '1'" : '0' : null })) }
  });
  let step = 1;
  const fixture = () => ({ runId: 'data-visual-fixture', status: 'paused', step, line: 13, frames: [{ id: 'f0', level: 0, function: 'main', user: true }], output: {},
    arrayAccess: { line: 13, reads: [{ variableId: 'a', coordinates: [step === 1 ? 4 : 30] }, { variableId: 's', coordinates: [4] }], writes: [{ variableId: 'a', coordinates: [step === 1 ? 5 : 31] }] },
    variables: [variable('a', 'array', 50), variable('s', 'string', 6), variable('u', 'array', 12, 'uninitialized'), variable('m', 'matrix', 12)] });
  await page.route('**/api/**', (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint === '/api/command') step++;
    return route.fulfill({ json: endpoint === '/api/health' ? { status: 'ready' } : fixture() });
  });
  const card = (name) => page.locator(`[data-structure="${name}"]`);
  const cell = (name, index) => card(name).locator(`[data-coordinates="${index}"]`);
  try {
    await page.goto(base);
    await page.locator('#start').click();
    await cell('a', 4).waitFor();
    assert.equal(await cell('a', 4).getAttribute('data-access'), 'read');
    assert.equal(await cell('a', 5).getAttribute('data-access'), 'write');
    assert.equal(await cell('s', 4).getAttribute('data-access'), 'read');
    assert.notEqual(await cell('a', 4).evaluate((element) => getComputedStyle(element).backgroundColor), await cell('a', 5).evaluate((element) => getComputedStyle(element).backgroundColor));
    assert.equal(await card('a').locator('.repeat-fold').count(), 1);
    assert.equal(await card('a').locator('.element[data-coordinates]').count(), 8);
    assert.equal(await card('a').locator('.repeat-fold').getAttribute('data-fold-range'), '7,48');
    await card('a').locator('.repeat-fold').click();
    assert.equal(await card('a').locator('.element[data-coordinates]').count(), 50);
    await card('a').locator('.repeat-fold').click();
    assert.equal(await card('a').locator('.element[data-coordinates]').count(), 8);
    assert.equal(await card('u').locator('.repeat-fold').count(), 0);
    assert.equal(await card('u').locator('.element').count(), 12);
    assert.equal(await card('m').locator('.repeat-fold').count(), 0);
    assert.equal(await card('m').locator('.element').count(), 12);
    assert.equal(await cell('s', 4).locator('.element-value').textContent(), "'1'");
    assert.equal(await card('s').locator('.data-note').count(), 0);
    assert.match(await card('s').locator('.character-info').getAttribute('title'), /UTF-8/);
    await card('s').getByLabel('s 字符显示方式').selectOption('code');
    assert.equal(await cell('s', 4).locator('.element-value').textContent(), '49');
    await card('s').getByLabel('s 字符显示方式').selectOption('character');
    assert.equal(await cell('s', 4).locator('.element-value').textContent(), "'1'");
    await page.locator('#next').click();
    await cell('a', 30).waitFor();
    assert.equal(await cell('a', 30).getAttribute('data-access'), 'read');
    assert.equal(await cell('a', 31).getAttribute('data-access'), 'write');
    assert.equal(await card('a').locator('.access-read').count(), 1);
    assert.equal(await cell('a', 4).count(), 0, '上一条的读取格子可以重新折叠，不累积高亮');
    assert.deepEqual(errors, []);
    console.log('通过：读写格子保护、已读取重复值展开收回、未知值和矩阵不折叠、字符编码切换');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
