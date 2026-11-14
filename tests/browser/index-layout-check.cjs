// 下标合并与分离时只显示当前位置，标签与数组基线保持稳定。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let step = 0;
  const values = [[0, 4, 9], [0, 0, 9], [0, 0, 0], [2, 6, 10]];
  const snapshot = () => ({ runId: 'index-layout', status: 'paused', step, line: 1, output: {},
    frames: [{ id: 'f0', level: 0, function: 'main', user: true }],
    indexAssociations: { a: ['i', 'j', 'k'] },
    indexPreviousValues: step ? Object.fromEntries(['i', 'j', 'k'].map((id, i) => [id, String(values[step - 1][i])])) : { i: '-1', j: '99' },
    variables: [...['i', 'j', 'k'].map((id, i) => ({ id, name: id, type: 'int', kind: 'local', frame: 0, visible: true, state: 'ok', value: String(values[step][i]), indexColor: i, changed: step > 0 })),
      { id: 'a', name: 'a', type: 'int [12]', kind: 'local', frame: 0, visible: true, state: 'ok', value: 'array',
        data: { kind: 'array', shape: [12], lowerBounds: [0], total: 12, offset: 0, limit: 12, hidden: 0, state: 'ok',
          elements: Array.from({ length: 12 }, (_, i) => ({ index: i, coordinates: [i], state: 'ok', value: String(i) })) } }] });
  await page.route('**/api/**', route => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint === '/api/command') step++;
    return route.fulfill({ json: endpoint === '/api/health' ? { status: 'ready' } : snapshot() });
  });
  try {
    await page.goto(base);
    await page.evaluate(() => localStorage.setItem('code-lab:motion:v1', 'off'));
    await page.reload();
    await page.locator('#start').click();
    const card = page.locator('[data-structure="a"]');
    await card.locator('.index-pointer').first().waitFor();
    let height;
    for (let s = 0; s < values.length; s++) {
      if (s) {
        await page.locator('#next').click();
        await page.waitForFunction(s => document.querySelector('#position').textContent.includes(`第 ${s} 步`), s);
      }
      const result = await card.evaluate(card => {
        const labels = [...card.querySelectorAll('.index-pointer text')].map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; });
        return { labels, height: card.querySelector('svg').getAttribute('height') };
      });
      height ??= result.height;
      assert.equal(result.height, height, '下标重合与分离不能改变数组上方的保留高度');
      const expected = [...new Set(values[s])].map(value => ['i','j','k'].filter((id, i) => values[s][i] === value).join(' · '));
      assert.equal(result.labels.length, expected.length, '同格下标共用一个箭头');
      assert.deepEqual(await card.locator('.index-pointer text').allTextContents(), expected, '只显示名字；同格合并后可重新分离');
      assert.equal(await card.locator('.index-pointer rect').count(), 0, '标签不再绘制外框');
      assert.equal(await card.locator('.index-pointer path').count(), expected.length);
      assert.equal(await card.locator('.index-hints').textContent(), '', '旧位置越界也不生成提示');
      assert.equal(await card.locator('.index-ghost, .index-ghost-hint').count(), 0);
      assert.equal(new Set(result.labels.map(r => r.y)).size, 1, '当前下标标签应在同一水平线');
      const sorted = result.labels.sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].x >= sorted[i-1].x + sorted[i-1].width, '同位与相邻下标标签应横向避让');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        assert.equal(await page.locator('[data-variable="i"] .value-cell').evaluate(n => getComputedStyle(n).boxShadow), 'none', '关联色不应给数值区域叠加彩色边框');
        if (s === 2) {
          fs.mkdirSync('验收输出/browser/indices', { recursive: true });
          await page.screenshot({ path: `验收输出/browser/indices/aligned-${theme}.png` });
        }
      }
    }
    await page.setViewportSize({ width: 700, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    async function aligned() {
      await page.waitForFunction(() => [...document.querySelectorAll('.index-pointer')].every(pointer => {
        const cell=pointer.closest('.array-strip').querySelector(`[data-coordinates="${pointer.dataset.position}"]`);
        const r=cell.getBoundingClientRect(), b=pointer.closest('svg').getBoundingClientRect();
        const tip=Number(pointer.querySelector('path').getAttribute('d').match(/L ([\d.-]+) 31/)[1]);
        return r.width>0 && Math.abs(b.left+tip-r.left-r.width/2)<1;
      }));
    }
    await aligned();
    await card.locator(':scope > summary').click();
    await page.setViewportSize({width:1100,height:900});
    await card.locator(':scope > summary').click();
    await aligned();
    const shortArray = await page.evaluate(async () => {
      const { drawMarkers, clearIndexLayouts } = await import('/features/data/index-markers.js');
      const host = document.createElement('div');
      host.style.cssText = 'width:150px;position:fixed;top:0;left:0';
      host.innerHTML = '<div class="data-content"><div class="structure-scroll"><div class="array-strip"><div class="element" data-coordinates="0">0</div></div></div></div>';
      document.body.append(host);
      drawMarkers(host, { data: { lowerBounds: [0], total: 1, offset: 0 } }, ['i','j','k'].map((id, i) => ({ id, variable: { name: id, indexColor: i }, value: 0n, previous: null })), () => {});
      const layer = host.querySelector('svg');
      const result = { width: layer.width.baseVal.value, tip: Number(layer.querySelector('path').getAttribute('d').match(/L ([\d.-]+) 31/)[1]), cellCenter: host.querySelector('.element').getBoundingClientRect().left - host.querySelector('.array-strip').getBoundingClientRect().left + host.querySelector('.element').getBoundingClientRect().width/2, labels: [...layer.querySelectorAll('text')].map(n => { const r=n.getBBox(); return {x:r.x,right:r.x+r.width}; }) };
      clearIndexLayouts(); host.remove(); return result;
    });
    assert.equal(shortArray.labels.length, 1);
    assert.ok(Math.abs(shortArray.tip-shortArray.cellCenter)<1, '短数组扩宽后箭头仍指向实际格子中心');
    for (let i = 0; i < shortArray.labels.length; i++) {
      assert.ok(shortArray.labels[i].x >= 0 && shortArray.labels[i].right <= shortArray.width, '短数组多标签不能越过滚动平面');
      if (i) assert.ok(shortArray.labels[i].x >= shortArray.labels[i-1].right, '短数组也不能重叠');
    }
    console.log('通过：小名字无外框、同格合并/分离、固定高度、短数组与窄屏');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
