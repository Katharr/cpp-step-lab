const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.CODE_LAB_URL || 'http://127.0.0.1:8765';
const source = fs.readFileSync(require('node:path').join(__dirname, '../fixtures/cpp/index_markers.cpp'), 'utf8');
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
  async function until(line, value) {
    for(let i=0;i<30;i++) {
      if(value.line === line) return value;
      value = await action('next');
    }
    throw Error('未到达行 '+line);
  }
  const positions = () => card.locator('.index-pointer:not(.index-ghost)').evaluateAll(nodes => nodes.map(n => n.textContent).sort());
  try {
    await page.goto(base);
    await page.locator('#source').fill(source);
    let value = await action('start','/api/start');
    value = await until(9,value);
    assert.deepEqual(await positions(), ['l = 0','m = 49']);
    assert.match(await card.locator('.index-hints').textContent(), /r = 99.*窗口外/);
    assert.equal(await card.locator('.element[data-coordinates="49"]').count(),1,'下标目标不能折叠');
    const l = value.variables.find(v=>v.name==='l');
    const color = await card.locator(`.index-pointer[data-index-id="${l.id}"]`).getAttribute('color');
    assert.equal(await page.locator(`[data-variable="l"]`).evaluate(n=>n.style.getPropertyValue('--index-color')),color);
    await card.locator('.multi-index-controls summary').click();
    await card.getByLabel('关联下标 u',{exact:true}).check();
    assert.match(await card.locator('.index-hints').textContent(), /u：未赋值|u：值未确认/);
    await card.getByLabel('关联下标 r',{exact:true}).uncheck();
    value = await action('next');
    assert.deepEqual(await positions(),['l = 0','m = 0']);
    assert.match(await card.locator('.index-ghost').textContent(), /m = 49/);
    const saved = await page.locator('#history-slider').inputValue();
    await card.getByLabel('关联下标 r',{exact:true}).check();
    value = await action('next');
    assert.deepEqual(await positions(),['l = 0','m = 0','r = 0']);
    await page.evaluate(() => Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
    const rects = await card.locator('.index-pointer:not(.index-ghost) rect').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
    for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) assert.ok(rects[i].right <= rects[j].x || rects[j].right <= rects[i].x || rects[i].bottom <= rects[j].y || rects[j].bottom <= rects[i].y,'重合标签必须避让');
    value = await until(14,value);
    assert.match(await card.locator('.index-hints').textContent(), /l = -1.*越界/);
    assert.match(await card.locator('.index-hints').textContent(), /r = 100.*越界/);
    const step = value.step;
    await card.locator('.structure-scroll').evaluate(n=>n.scrollLeft=n.scrollWidth);
    await card.locator('.index-hints button').filter({hasText:'m = 75'}).click();
    await card.locator('.element[data-coordinates="75"]').waitFor();
    assert.match(await page.locator('#position').textContent(),new RegExp('第 '+step+' 步'));
    assert.deepEqual(await positions(),['m = 75']);
    assert.equal(await card.locator('.element[data-coordinates="75"]').evaluate(n=>{
      const r=n.getBoundingClientRect(), b=n.closest('.structure-scroll').getBoundingClientRect();
      return r.left >= b.left && r.right <= b.right;
    }),true,'点击定位后目标必须可见');
    await page.locator('#history-slider').evaluate((n,v)=>{n.value=v;n.dispatchEvent(new Event('input',{bubbles:true}));},saved);
    assert.deepEqual(await positions(),['l = 0','m = 0']);
    assert.match(await card.locator('.index-ghost').textContent(), /m = 49/);
    await page.locator('#history-latest').click();
    value = await action('next');
    assert.equal(await card.locator('[data-coordinates="75"]').getAttribute('data-access'),'write');
    for (const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.evaluate(()=>document.documentElement.dataset.motion='reduced');
      fs.mkdirSync('验收输出/browser/indices',{recursive:true});
      await page.screenshot({path:`验收输出/browser/indices/${theme}.png`});
    }
    await page.setViewportSize({width:700,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    value = await until(17,value);
    await card.getByLabel('关联下标 v',{exact:true}).check();
    const manual = await card.locator('.index-hints-left button').filter({hasText:'v = 1'}).evaluate(n=>n.style.color);
    value = await until(21,value);
    const unavailable = card.locator('.index-hints-unknown span').filter({hasText:'v：值未确认或已离开作用域'});
    assert.equal(await unavailable.count(),1);
    assert.equal(await unavailable.evaluate(n=>n.style.color),await page.evaluate(c=>{const n=document.createElement('span');n.style.color=c;return n.style.color;},manual));
    assert.deepEqual(errors,[]);
    console.log('多下标真实调试网页验收通过');
  } finally {
    await page.locator('#stop').click().catch(()=>{});
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
