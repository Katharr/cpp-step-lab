// 真实 GCC/GDB：阶段识别、固定下标、位置与访问分离、窗口/历史/课例恢复。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const source = fs.readFileSync(require('node:path').join(__dirname, '../fixtures/cpp/index_stages.cpp'), 'utf8');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CODE_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const card = page.locator('[data-structure="a"]');
  async function action(id, endpoint='/api/command') {
    const pending = page.waitForResponse(r => r.url() === base + endpoint && r.request().method() === 'POST');
    await page.locator('#'+id).click();
    const result = await (await pending).json();
    await page.waitForFunction(() => !/正在编译|正在执行|正在停止/.test(document.querySelector('#status').textContent));
    return result;
  }
  async function until(text, value) {
    const line = source.split('\n').findIndex(s => s.includes(text)) + 1;
    for(let i=0;i<100;i++) {
      if(value.line === line) return value;
      assert.equal(value.status, 'paused');
      value = await action('next');
    }
    throw Error('未到达 '+text);
  }
  const positions = () => card.locator('.index-pointer text').allTextContents();
  const linked = () => page.locator('.index-variable').evaluateAll(nodes => nodes.map(n=>n.dataset.variable).sort());
  async function openIndices() { const details=card.locator('.multi-index-controls'); if(!await details.evaluate(n=>n.open)) await details.locator('summary').click(); }
  try {
    await page.goto(base);
    await page.locator('#source').fill(source);
    await page.locator('#stdin').fill('5 6 7');
    let value = await action('start','/api/start');
    value = await until('std::cin >> a[i]',value);
    assert.deepEqual(await positions(), ['i']);
    assert.deepEqual(await linked(), ['i'], '长度、计算依赖和后续阶段下标不应自动强调');
    fs.mkdirSync('验收输出/browser/indices',{recursive:true});
    for (const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t, theme);
      await page.screenshot({path:`验收输出/browser/indices/compact-input-${theme}.png`});
    }
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await action('next');
    assert.deepEqual(await positions(), ['i'], '输入循环的非数组语句保持箭头');
    const saved = await page.locator('#history-slider').inputValue();
    await openIndices();
    await card.getByRole('button',{name:'固定下标 i',exact:true}).click();
    await card.getByLabel('关联下标 u',{exact:true}).check();
    assert.equal(await card.locator('.index-hints').textContent(), '', '未知值不画箭头或生成杂乱提示');
    value = await until('a[j+1] = a[j]',value);
    assert.deepEqual(await linked(), ['i','j','u'], '自动切换到 j，手动 i 保留');
    assert.deepEqual((await positions()).sort(), ['i','j']);
    await openIndices();
    await card.getByRole('button',{name:'固定下标 j',exact:true}).click();
    value = await action('next');
    assert.equal(await card.locator('.index-pointer[data-position="0"] text').textContent(),'j');
    assert.equal(await card.locator('[data-coordinates="1"]').getAttribute('data-access'),'write','j+1 的写入颜色不改变 j 箭头位置');
    assert.equal(await card.locator('[data-coordinates="0"]').getAttribute('data-access'),'read');
    await openIndices();
    await card.getByLabel('关联下标 m',{exact:true}).check();
    const step = value.step;
    await card.getByRole('button',{name:'定位下标 m',exact:true}).click();
    await card.locator('[data-coordinates="75"]').waitFor();
    assert.match(await page.locator('#position').textContent(),new RegExp('第 '+step+' 步'));
    assert.equal(await card.locator('[data-coordinates="75"]').evaluate(n=>{const r=n.getBoundingClientRect(),b=n.closest('.structure-scroll').getBoundingClientRect();return r.left>=b.left&&r.right<=b.right;}),true);
    await page.locator('#history-slider').evaluate((n,v)=>{n.value=v;n.dispatchEvent(new Event('input',{bubbles:true}));},saved);
    assert.equal(await card.locator('.index-pointer[data-position="0"] text').textContent(),'i');
    await page.locator('#history-latest').click();
    value = await until('i = -1',value);
    value = await action('next');
    assert.match(await card.locator('.index-hints').textContent(),/i · 越界/);
    value = await action('next');
    assert.match(await card.locator('.index-hints').textContent(),/j · 越界/);
    assert.doesNotMatch(await card.locator('.index-hints').textContent(),/=|75|100|-1/);
    for (const theme of ['light','dark']) {
      await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.dataset.motion='reduced';},theme);
      fs.mkdirSync('验收输出/browser/indices',{recursive:true});
      await page.screenshot({path:`验收输出/browser/indices/${theme}.png`});
    }
    value = await until('return t', value);
    await openIndices();
    await card.getByLabel('关联下标 j',{exact:true}).uncheck();
    await action('stop');
    await page.locator('.more-menu').evaluate(n=>n.open=true);
    const downloaded = page.waitForEvent('download');
    await page.locator('#save-case').click();
    await (await downloaded).delete();
    const savedCase = await page.evaluate(()=>JSON.parse(localStorage.getItem('code-lab:last-case:v1')));
    const preference=savedCase.display.dataSettings.find(s=>s.id.endsWith(':a'));
    assert.ok(preference.manualIndices.some(id=>id.endsWith(':i')));
    assert.ok(preference.excludedIndices.some(id=>id.endsWith(':j')));
    await page.locator('.more-menu').evaluate(n=>n.open=true);
    await page.locator('#restore-case').click();
    value = await action('start','/api/start');
    value = await until('a[j+1] = a[j]',value);
    assert.deepEqual(await linked(), ['i','m','u'], '课例重跑保留手动固定，并保持取消 j');
    assert.equal(await card.locator('.index-pointer text').filter({hasText:/^j$/}).count(),0);
    assert.deepEqual(errors,[]);
    console.log('通过：真实调试阶段切换、固定/取消、位置与访问分离、窗口定位、历史和课例重跑');
  } finally {
    await page.locator('#stop').click({timeout:2000}).catch(()=>{});
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
