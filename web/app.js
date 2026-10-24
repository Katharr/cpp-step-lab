/* 原生 DOM + 顺序快照，不在浏览器中解释 C++。可直接从 file:// 打开。 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : location.origin;
  const sessionId = crypto.randomUUID().replaceAll('-', '');
  const examples = {
    matrix: { input: '', source: `#include <iostream>
using namespace std;

int main() {
    int a[2][3] = {{1, 2, 3}, {4, 5, 6}};  // a = 两行三列的数组
    int s = 0;  // s = 总和
    for (int i = 0; i < 2; i++) {  // i = 行下标
        for (int j = 0; j < 3; j++) {  // j = 列下标
            s += a[i][j];
        }
    }
    cout << s << endl;
    return 0;
}
` },
    prefix: { input: '', source: `#include <iostream>
using namespace std;

int main() {
    int a[6] = {0, 3, 1, 4, 2, 5};  // a = 原数组，首格留空
    int b[6] = {};  // b = 前缀和数组
    for (int i = 1; i <= 5; i++) {  // i = 当前下标
        b[i] = b[i - 1] + a[i];
    }
    cout << b[5] << endl;
    return 0;
}
` },
    containers: { input: '', source: `#include <iostream>
#include <vector>
#include <string>
using namespace std;

int main() {
    vector<int> a = {3, 1};  // a = 可追加元素的数组
    string b = "abc";  // b = 待修改的字符串
    int i = 1;  // i = 待修改位置
    a.push_back(4);
    b[i] = 'x';
    cout << a.size() << " " << b << endl;
    return 0;
}
` },
    adjacent: { input: '', source: `#include <iostream>
using namespace std;

int main() {
    int a[4] = {3, 1, 4, 2};  // a = 待交换的数组
    int i = 1;  // i = 左侧元素下标
    int t = a[i];  // t = 临时保存的数
    a[i] = a[i + 1];
    a[i + 1] = t;
    i = 4;
    cout << a[1] << " " << a[2] << endl;
    return 0;
}
` },
    recursive: { input: '', source: `#include <iostream>
using namespace std;

int f(int x) {  // x = 当前层的数
    int a[2] = {};  // a = 当前调用独立的数组
    a[0] = x;
    if (x > 0) {
        a[1] = f(x - 1);
    }
    return a[0] + a[1];
}

int main() {
    int s = 0;  // s = 递归结果
    s = f(2);
    cout << s << endl;
    return 0;
}
` },
    swap: { input: '', source: `#include <iostream>
using namespace std;

int main() {
    long long x = 9007199254740993LL;  // x = 第一个数
    long long s = 2;  // s = 第二个数
    long long t = x;  // t = 临时保存的数
    x = s;
    s = t;
    cout << x << " " << s << endl;
    return 0;
}
` },
    array: { input: '4\n3 1 4 2\n', source: `#include <iostream>
using namespace std;

int main() {
    int n = 0;  // n = 元素个数
    int a[10] = {};  // a = 保存输入的数组
    int s = 0;  // s = 总和
    cin >> n;
    for (int i = 0; i < n; i++) {  // i = 数组下标
        cin >> a[i];
        s += a[i];
    }
    cout << s << endl;
    return 0;
}
` },
    function: { input: '', source: `#include <iostream>
using namespace std;

int s = 0;  // s = 全局结果

int f(int x) {  // x = 传入的数
    int t = x + 1;  // t = 加一后的结果
    return t;
}

int main() {
    int a = 5;  // a = 原数
    s = f(a);
    cout << s << endl;
    return 0;
}
` }
  };
  const statusText = {
    idle: '待运行', paused: '已暂停', completed: '运行结束', stopped: '已停止',
    compile_error: '编译失败', runtime_error: '运行异常', timeout: '执行超时',
    output_limit: '输出达到上限', step_limit: '步数达到上限', error: '调试失败'
  };
  const HISTORY_LIMIT = 2000;
  const OUTPUT_LIMIT = 1024 * 1024;
  const CASE_VERSION = 1;
  const CASE_STORAGE_KEY = 'code-lab:last-case:v1';
  const LAYOUT_STORAGE_KEY = 'code-lab:layout:v1';
  const stateText = { uninitialized: '未赋值', unavailable: '待确认', read_error: '读取失败', out_of_scope: '已离开作用域' };
  const dataSettings = new Map();
  let dataFrame = null;
  let snapshot = null;
  let previous = null;
  let busy = false;
  let starting = false;
  let stopping = false;
  let playing = false;
  let timer = null;
  let revision = 0;
  let uncertain = false;
  let errorLines = [];
  let history = [];
  let historyIndex = -1;
  let liveSnapshot = null;
  let historyLimitReached = false;
  const defaultLayout = { codeWidth: 45, stateHeight: 76, variablesHeight: 134 };
  let layout = { ...defaultLayout };
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const MOTION_STORAGE_KEY = 'code-lab:motion:v1';
  let feedbackAnimations = [];
  let lastFeedbackKey = '';
  let completedFeedbackRun = null;
  const CODE_THEME_STORAGE_KEY = 'code-lab:code-theme:v1';
  let highlightedSource = null;
  let highlightedLines = [];
  let presentationPresets = new Map();
  let restoredPresentations = new Set();
  let restoredPrefixWindows = new Set();
  let lastAccessViewKey = '';

  async function revealAccessWindows(result) {
    if (result.status !== 'paused') return result;
    const access = result.arrayAccess;
    if (!access) return result;
    for (const original of result.variables || []) {
      const variable = result.variables.find((item) => item.id === original.id);
      const data = variable.data;
      if (!data || variable.state !== 'ok') continue;
      const writes = access.writes.filter((item) => item.variableId === variable.id);
      const reads = access.reads.filter((item) => item.variableId === variable.id);
      const targets = [...writes, ...reads];
      if (!targets.length) continue;
      const loaded = new Set(data.elements.map((item) => item.coordinates.join(',')));
      if (targets.every((item) => loaded.has(item.coordinates.join(',')))) continue;
      const flatten = (item) => item.coordinates.reduce((index, value, axis) => index * data.shape[axis] + value - (data.lowerBounds[axis] || 0), 0);
      const indices = targets.map(flatten).filter((value) => Number.isSafeInteger(value) && value >= 0 && value < data.total);
      if (!indices.length) continue;
      const first = indices[0]; // 源目标相距过远时，优先保证写入位置可见。
      const low = Math.min(...indices), high = Math.max(...indices);
      const limit = Math.min(200, Math.max(data.limit || 50, high - low < 200 ? high - low + 1 : 50));
      const offset = Math.max(0, Math.min(high - low < limit ? low - Math.floor((limit - high + low - 1) / 2) : first - Math.floor(limit / 2), Math.max(0, data.total - limit)));
      result = await request('/api/window', { sessionId, runId: result.runId, variableId: variable.id, offset, limit });
    }
    return result;
  }

  function presentationKey(id) {
    // scope 中是 GDB 的运行地址，重新编译后会变化；展示偏好按调用实例与源码声明位置匹配。
    const parts = String(id).split(':');
    return parts.length >= 6 && /^(?:global|f\d+)$/.test(parts[1])
      ? [parts[1], parts.at(-2), parts.at(-1)].join(':') : String(id);
  }

  async function restorePresentation(result) {
    for (const variable of result.variables || []) {
      if (!variable.data) continue;
      const preset = presentationPresets.get(presentationKey(variable.id));
      if (!preset) continue;
      if (!restoredPresentations.has(variable.id)) {
        const axes = (preset.axes || []).map((id) => (result.variables || []).find((item) => presentationKey(item.id) === presentationKey(id))?.id || id);
        dataSettings.set(variable.id, { ...preset, axes, scrollLeft: 0, scrollTop: 0 });
        restoredPresentations.add(variable.id);
      }
      const settings = dataSettings.get(variable.id);
      // for 下标可能晚于数组声明，保留待关联标识，出现时再映射至本次运行。
      // 从当前设置出发，避免覆盖老师后来手动取消或更换的关联。
      settings.axes = (settings.axes || []).map((id) => id ? (result.variables || []).find((item) => presentationKey(item.id) === presentationKey(id))?.id || id : '');
      if (preset.prefixApplied && variable.data.state === 'ok' && result.status === 'paused' && !restoredPrefixWindows.has(variable.id)) {
        if (variable.data.offset !== 0 || variable.data.limit !== preset.prefixLimit) {
          result = await request('/api/window', { sessionId, runId: result.runId, variableId: variable.id, offset: 0, limit: preset.prefixLimit });
        }
        restoredPrefixWindows.add(variable.id);
      }
    }
    return result;
  }

  function applyCodeTheme(value, save = false) {
    const theme = ['light', 'dark', 'dracula'].includes(value) ? value : 'light';
    $('code-theme').value = theme;
    document.documentElement.dataset.codeTheme = theme;
    if (save) {
      try { localStorage.setItem(CODE_THEME_STORAGE_KEY, theme); } catch { /* 当前页仍生效。 */ }
    }
  }

  function setupCodeTheme() {
    let value = 'light';
    try { value = localStorage.getItem(CODE_THEME_STORAGE_KEY) || value; } catch { /* 使用课堂浅色默认。 */ }
    applyCodeTheme(value);
    document.documentElement.classList.toggle('syntax-ready', Boolean(window.CodeSyntax));
    $('code-theme').addEventListener('change', () => applyCodeTheme($('code-theme').value, true));
    new ResizeObserver(syncEditorScroll).observe($('source'));
  }

  function syncEditorScroll() {
    const source = $('source'), view = $('edit-highlight');
    $('edit-lines').scrollTop = source.scrollTop;
    view.style.width = source.clientWidth + 'px';
    view.style.height = source.clientHeight + 'px';
    view.scrollTop = source.scrollTop;
    view.scrollLeft = source.scrollLeft;
  }

  function syntaxLines(source) {
    if (source !== highlightedSource) {
      highlightedSource = source;
      highlightedLines = window.CodeSyntax ? CodeSyntax.highlight(source) : source.split('\n').map((line) => {
        const fragment = document.createDocumentFragment(); fragment.append(document.createTextNode(line)); return fragment;
      });
      const content = document.createDocumentFragment();
      highlightedLines.forEach((line, index) => {
        if (index) content.append(document.createTextNode('\n'));
        content.append(line.cloneNode(true));
      });
      // textarea 的末尾空行需要同高的布局占位，不参与词法结果或源代码。
      if (source.endsWith('\n')) {
        const endLine = document.createElement('span'); endLine.className = 'editor-end-line'; content.append(endLine);
      }
      $('edit-highlight').replaceChildren(content);
    }
    syncEditorScroll();
    return highlightedLines;
  }

  function cancelFeedback() {
    feedbackAnimations.forEach((animation) => animation.cancel());
    feedbackAnimations = [];
  }

  function setupMotion() {
    try {
      const saved = localStorage.getItem(MOTION_STORAGE_KEY);
      if (['standard', 'reduced', 'off'].includes(saved)) $('motion').value = saved;
    } catch { /* 存储不可用时使用当前页设置。 */ }
    const apply = () => {
      const selected = $('motion').value;
      document.documentElement.dataset.motion = selected === 'standard' && motionQuery.matches ? 'reduced' : selected;
      cancelFeedback();
    };
    $('motion').addEventListener('change', () => {
      try { localStorage.setItem(MOTION_STORAGE_KEY, $('motion').value); } catch { /* 设置仍即时生效。 */ }
      apply();
    });
    motionQuery.addEventListener('change', apply);
    apply();
  }

  function animateFeedback(element, frames, duration = 200) {
    if (!element || !element.getClientRects().length) return;
    feedbackAnimations.push(element.animate(frames, { duration, easing: 'cubic-bezier(.2,.7,.3,1)' }));
  }

  function pointerVisible(cell) {
    const rect = cell.getBoundingClientRect();
    // 同时尊重数组内滚动与数组面板的纵向裁剪。
    for (const container of [cell.closest('.structure-scroll'), cell.closest('.data-body')]) {
      const bounds = container.getBoundingClientRect();
      if (rect.left < bounds.left || rect.right > bounds.right || rect.top - 27 < bounds.top || rect.bottom > bounds.bottom) return false;
    }
    return true;
  }

  function showStepFeedback(oldPointers) {
    const key = snapshot ? `${snapshot.runId}:${snapshot.step}` : '';
    if (!key || key === lastFeedbackKey) return;
    lastFeedbackKey = key;
    const completed = snapshot.status === 'completed' && completedFeedbackRun !== snapshot.runId;
    if (completed) completedFeedbackRun = snapshot.runId;
    if (document.documentElement.dataset.motion !== 'standard' || (playing && Number($('speed').value) <= 300)) return;
    animateFeedback($('code-view').querySelector('.current .line-text'), [{ opacity: .45 }, { opacity: 1 }], 160);
    for (const value of document.querySelectorAll('.changed .current-value, .element.changed .element-value')) {
      if (value.closest('.access-write')) continue;
      animateFeedback(value, [{ transform: 'scale(1)', opacity: .6 }, { transform: 'scale(1.08)', opacity: 1, offset: .45 }, { transform: 'scale(1)', opacity: 1 }], 220);
    }
    for (const cell of document.querySelectorAll('.element.access-read:not(.access-write)')) {
      animateFeedback(cell, [{ opacity: .55 }, { opacity: 1 }], 140);
    }
    for (const cell of document.querySelectorAll('.element.access-write')) {
      animateFeedback(cell.querySelector('.element-value'), [{ opacity: .35, transform: 'scale(.96)', offset: 0 }, { opacity: .35, transform: 'scale(.96)', offset: .4 }, { opacity: 1, transform: 'scale(1)' }], 280);
    }
    for (const mark of document.querySelectorAll('.io-changed')) animateFeedback(mark, [{ opacity: .4 }, { opacity: 1 }], 180);
    for (const cell of document.querySelectorAll('.element.indexed')) {
      const label = (cell.dataset.pointerLabel || '').replace(/-?\d+/g, '#');
      const old = oldPointers.get(`${cell.dataset.variableId}:${label}`);
      // 只有同一变量的单个指针才做位移；多格行列强调保持静止，避免暗示一次真实内存访问。
      const card = cell.closest('.data-card');
      if (!old || !pointerVisible(cell) || card.querySelectorAll('.indexed').length !== 1 || old.coordinates === cell.dataset.coordinates) continue;
      const rect = cell.getBoundingClientRect();
      const dx = old.left - rect.left, dy = old.top - rect.top;
      if (Math.abs(dx) > card.clientWidth || Math.abs(dy) > card.clientHeight) continue;
      // 指针通过独立浮层移动，当前值和单元格位置始终准确。
      const pointer = document.createElement('span');
      pointer.className = 'moving-pointer';
      pointer.textContent = '↓ ' + cell.dataset.pointerLabel;
      pointer.style.left = rect.left + 'px'; pointer.style.top = rect.top - 27 + 'px';
      pointer.setAttribute('aria-hidden', 'true');
      document.body.append(pointer);
      const animation = pointer.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.3,1)' });
      cell.classList.add('pointer-moving');
      const clean = () => { pointer.remove(); cell.classList.remove('pointer-moving'); };
      animation.onfinish = clean; animation.oncancel = clean;
      feedbackAnimations.push(animation);
    }
    if (completed) animateFeedback($('status'), [{ transform: 'scale(.9)', opacity: .5 }, { transform: 'scale(1.06)', offset: .6 }, { transform: 'scale(1)', opacity: 1 }], 360);
  }

  function notice(message = '') {
    ($('notice-message') || $('notice')).textContent = message;
    $('notice').hidden = !message;
  }

  function copy(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function outputWithinLimit(value) {
    const result = { stdout: value?.stdout || '', stderr: value?.stderr || '' };
    let size = new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength;
    if (size <= OUTPUT_LIMIT) return result;
    for (const name of ['stdout', 'stderr']) {
      if (size <= OUTPUT_LIMIT) break;
      const bytes = new TextEncoder().encode(result[name]);
      const keep = Math.max(0, bytes.byteLength - (size - OUTPUT_LIMIT));
      result[name] = new TextDecoder().decode(bytes.slice(0, keep));
      size = new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength;
    }
    return result;
  }

  function resetHistory() {
    history = [];
    historyIndex = -1;
    liveSnapshot = null;
    historyLimitReached = false;
    updateHistoryControls();
  }

  function historyPosition() {
    return history.length ? `第 ${history[historyIndex].step} 步 / 共 ${history.at(-1).step} 步` : '尚未运行';
  }

  function updateHistoryControls() {
    const hasHistory = history.length > 0;
    const viewing = hasHistory && historyIndex < history.length - 1;
    $('history-count').textContent = historyPosition();
    $('history-slider').max = String(Math.max(0, history.length - 1));
    $('history-slider').value = String(Math.max(0, historyIndex));
    $('history-slider').disabled = !hasHistory || busy || stopping || playing;
    $('history-prev').disabled = !hasHistory || historyIndex <= 0 || busy || stopping || playing;
    $('history-next').disabled = !hasHistory || historyIndex >= history.length - 1 || busy || stopping || playing;
    $('history-latest').disabled = !viewing || busy || stopping || playing;
    $('history-state').textContent = viewing ? '正在回看历史' : '执行历史';
  }

  function selectHistory(index, message = '') {
    if (!history.length) return;
    historyIndex = Math.max(0, Math.min(history.length - 1, Number(index)));
    snapshot = history[historyIndex];
    previous = historyIndex > 0 ? history[historyIndex - 1] : null;
    render();
    compilerInfo(snapshot);
    updateHistoryControls();
    if (message) notice(message);
  }

  function returnToLatest() {
    if (!history.length || historyIndex === history.length - 1) return false;
    selectHistory(history.length - 1, '已回到最新状态，可以继续执行。');
    return true;
  }

  function remember(result) {
    if (!Number.isInteger(result?.step)) return;
    const normalized = copy(result);
    normalized.output = outputWithinLimit(normalized.output);
    if (liveSnapshot?.runId !== normalized.runId) {
      history = [];
      historyIndex = -1;
      historyLimitReached = false;
    }
    liveSnapshot = normalized;
    const same = history.findIndex((item) => item.runId === normalized.runId && item.step === normalized.step);
    if (same >= 0) {
      normalized.outputDelta = history[same].outputDelta;
      normalized.inputTrace = history[same].inputTrace;
      history[same] = normalized;
      if (historyIndex === same || historyIndex >= history.length - 1) historyIndex = same;
    } else if (history.length < HISTORY_LIMIT) {
      history.push(normalized);
      historyIndex = history.length - 1;
    } else {
      historyLimitReached = true;
    }
    snapshot = historyIndex >= 0 ? history[historyIndex] : normalized;
    previous = historyIndex > 0 ? history[historyIndex - 1] : null;
    updateHistoryControls();
  }

  function controls() {
    const active = snapshot?.status === 'paused' && !uncertain;
    const atLatest = historyIndex < 0 || historyIndex === history.length - 1;
    const locked = busy || stopping;
    $('start').disabled = locked || active;
    $('restart').disabled = locked || !snapshot;
    for (const id of ['next', 'step', 'over', 'play']) $(id).disabled = !active || locked || playing;
    $('pause').disabled = !playing;
    $('play').hidden = playing;
    $('pause').hidden = !playing;
    $('stop').disabled = !active || starting || stopping;
    for (const id of ['example', 'standard', 'edit']) $(id).disabled = active || locked || playing || historyIndex < history.length - 1;
    $('source').readOnly = active || locked;
    $('stdin').readOnly = active || locked;
    for (const control of document.querySelectorAll('.window-controls input, .window-controls button')) control.disabled = !active || !atLatest || locked || playing;
    $('reconnect').disabled = locked;
    if (starting) $('status').textContent = '正在编译与启动…';
    else if (stopping) $('status').textContent = '正在停止…';
    else if (playing) $('status').textContent = '正在播放';
    else if (historyIndex >= 0 && historyIndex < history.length - 1) $('status').textContent = '正在回看';
    else if (busy) $('status').textContent = '正在执行…';
    else if (uncertain) $('status').textContent = '连接中断';
    else $('status').textContent = statusText[snapshot?.status || 'idle'] || '操作未完成';
    $('status').dataset.state = !starting && !stopping && historyIndex >= 0 && historyIndex < history.length - 1 ? 'history'
      : uncertain || /error|timeout|limit/.test(snapshot?.status || '') ? 'error' : snapshot?.status || 'idle';
    updateHistoryControls();
  }

  function mode(editing) {
    $('editor').hidden = !editing;
    $('code-view').hidden = editing;
    $('edit').setAttribute('aria-pressed', String(editing));
    $('view').setAttribute('aria-pressed', String(!editing));
    renderInput();
  }

  function renderCode(focusLine = snapshot?.frames?.[0]?.user === false ? null : snapshot?.line ?? errorLines[0]) {
    const source = $('source').value.replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const colored = syntaxLines(source);
    $('edit-lines').textContent = lines.map((_, i) => i + 1).join('\n');
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const row = document.createElement('span');
      row.className = 'code-line';
      row.dataset.line = i + 1;
      if (previous?.runId === snapshot?.runId && previous?.step < snapshot?.step && previous?.line === i + 1
          && previous?.frames?.[0]?.user !== false && snapshot?.motion
          && (snapshot.status !== 'paused' || (snapshot.frames?.[0]?.user !== false
            && snapshot.frames.length <= (previous.frames?.length || 0)))
          && !['stopped', 'step_limit', 'compile_error', 'error'].includes(snapshot.status)) {
        row.classList.add('executed');
        row.title = '刚执行';
      }
      if (i + 1 === focusLine) {
        row.classList.add(errorLines.includes(focusLine) ? 'compile-error' : 'current');
        row.setAttribute('aria-current', 'step');
      }
      const number = document.createElement('span');
      number.className = 'line-number';
      number.textContent = i + 1;
      const code = document.createElement('span');
      code.className = 'line-text';
      code.append(colored[i].cloneNode(true));
      if (!lines[i]) code.append(document.createTextNode(' '));
      row.append(number, code);
      fragment.append(row);
    }
    $('code-view').replaceChildren(fragment);
    const row = $('code-view').querySelector('[aria-current]');
    if (row && !$('code-view').hidden) {
      // 只滚代码区，不把控制条滚出屏幕。
      const view = $('code-view');
      const top = row.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
      if (top < view.scrollTop || top + row.offsetHeight > view.scrollTop + view.clientHeight) {
        view.scrollTop = Math.max(0, top - view.clientHeight / 3);
      }
    }
  }

  function valueText(variable) {
    if (!variable) return '—';
    return variable.state === 'ok' && variable.value !== null ? String(variable.value) : stateText[valueState(variable)] || '值不可获取';
  }

  function valueState(variable) {
    return variable.state === 'unavailable' && variable.note?.startsWith('读取失败') ? 'read_error' : variable.state;
  }

  function becameKnown(value, before) {
    return snapshot?.runId === previous?.runId && snapshot.step > previous.step
      && value.state === 'ok' && value.value != null && before?.state !== 'ok';
  }

  function variables(target, items, emptyText) {
    const fragment = document.createDocumentFragment();
    const old = new Map((previous?.variables || []).map((v) => [v.id, v]));
    for (const variable of items) {
      const row = document.createElement('tr');
      row.dataset.variable = variable.name;
      row.dataset.variableId = variable.id;
      const prior = old.get(variable.id);
      const highlighted = variable.changed || becameKnown(variable, prior);
      if (highlighted) row.className = 'changed';
      const name = document.createElement('td');
      name.textContent = variable.name;
      name.title = variable.type || '';
      const type = document.createElement('span');
      type.className = 'variable-type';
      type.textContent = variable.type;
      name.append(type);
      const current = document.createElement('td');
      current.className = 'value-cell';
      const value = document.createElement('span');
      value.className = 'current-value';
      value.dataset.valueState = valueState(variable);
      value.textContent = valueText(variable);
      if (variable.data) {
        const summary = variable.state === 'ok' && Number.isInteger(variable.data.total) ? `${variable.data.total} 项` : valueText(variable);
        const button = node('button', `${summary} · 查看`, 'structure-link');
        button.type = 'button';
        button.setAttribute('aria-label', `查看 ${variable.name} 的数组或容器`);
        button.addEventListener('click', () => {
          dataFrame = variable.kind === 'global' ? null : snapshot?.frames?.find((frame) => frame.user && frame.level === variable.frame)?.id || null;
          renderData();
          controls();
          const card = [...$('data-views').querySelectorAll('.data-card')].find((item) => item.dataset.variableId === variable.id);
          if (!card) return;
          card.open = true;
          card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          card.querySelector('summary').focus({ preventScroll: true });
        });
        value.replaceChildren(button);
      }
      current.append(value);
      current.title = [valueText(variable), variable.note, variable.format?.note].filter(Boolean).join('\n');
      if (variable.note) {
        const note = document.createElement('span');
        note.className = 'variable-note';
        note.textContent = ' ⓘ';
        note.title = variable.note;
        note.tabIndex = 0;
        note.setAttribute('aria-label', variable.note);
        current.append(note);
      }
      const before = document.createElement('td');
      before.className = 'previous-value';
      before.textContent = valueText(old.get(variable.id));
      if (highlighted && prior && ['ok', 'unavailable', 'uninitialized'].includes(prior.state)
          && !(variable.data && prior.state === 'ok' && prior.data?.total === variable.data.total)) {
        const change = document.createElement('span');
        change.className = 'value-before';
        change.textContent = (prior.data && prior.state === 'ok' ? `${prior.data.total} 项` : before.textContent) + ' → ';
        current.prepend(change);
      }
      row.append(name, current, before);
      fragment.append(row);
    }
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty';
      cell.textContent = emptyText;
      row.append(cell);
      fragment.append(row);
    }
    $(target).replaceChildren(fragment);
  }

  function render({ animate = false } = {}) {
    const oldPointers = new Map();
    if (animate && previous?.runId === snapshot?.runId) {
      for (const cell of document.querySelectorAll('.element.indexed')) {
        if (!pointerVisible(cell)) continue;
        const rect = cell.getBoundingClientRect();
        const label = (cell.dataset.pointerLabel || '').replace(/-?\d+/g, '#');
        oldPointers.set(`${cell.dataset.variableId}:${label}`, { left: rect.left, top: rect.top, coordinates: cell.dataset.coordinates });
      }
    }
    cancelFeedback();
    const frames = snapshot?.frames || [];
    $('frame').textContent = frames[0]?.function || '—';
    $('frame-count').textContent = frames.length + ' 层';
    $('frames').replaceChildren(...frames.map((frame, i) => {
      const row = document.createElement('li');
      row.textContent = `${i === 0 ? '当前 → ' : ''}${frame.function} · ${frame.line ? '第 ' + frame.line + ' 行' : '位置未知'}`;
      return row;
    }));
    const items = snapshot?.variables || [];
    variables('locals', items.filter((v) => v.kind !== 'global' && v.frame === 0 && v.visible), '—');
    const globals = items.filter((v) => v.kind === 'global' && v.state !== 'out_of_scope');
    variables('globals', globals, '—');
    if ($('globals-section')) $('globals-section').hidden = !globals.length;
    renderData();
    renderOutput();
    renderInput();
    $('stderr').textContent = snapshot?.output?.stderr || '';
    if ($('error-details')) $('error-details').hidden = !snapshot?.output?.stderr;
    const location = frames[0]?.user === false ? '当前位于库函数，本页未载入其源码' : snapshot?.line ? '下一条：第 ' + snapshot.line + ' 行' : '当前无待执行行';
    $('position').textContent = snapshot ? `第 ${snapshot.step} 步 · ${location}` : '先填写输入，再开始运行';
    $('position').title = $('position').textContent;
    renderCode();
    controls();
    if (animate) showStepFeedback(oldPointers);
    if (historyLimitReached && !noticeText()) notice('已达到 2000 步历史上限，已保留已有记录。');
  }

  function noticeText() { return $('notice').hidden ? '' : $('notice').textContent; }

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function keepHighlightVisible(view, changed, follow) {
    if (!changed || !follow) return;
    const top = changed.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
    if (top < view.scrollTop || top + changed.offsetHeight > view.scrollTop + view.clientHeight) {
      view.scrollTop = Math.max(0, top - view.clientHeight / 2);
    }
  }

  function renderOutput() {
    const view = $('stdout');
    const text = snapshot?.output?.stdout || '';
    const delta = snapshot?.outputDelta?.stdout;
    const before = previous?.runId === snapshot?.runId ? previous?.output?.stdout || '' : '';
    const addition = typeof delta === 'string' ? delta : text.startsWith(before) ? text.slice(before.length) : '';
    const follow = view.scrollTop + view.clientHeight >= view.scrollHeight - 28;
    const start = addition && text.endsWith(addition) ? text.length - addition.length : text.length;
    const changed = start < text.length ? node('mark', text.slice(start), 'io-changed') : null;
    view.replaceChildren(document.createTextNode(text.slice(0, start)), ...(changed ? [changed] : []));
    keepHighlightVisible(view, changed, follow);
  }

  function renderInput() {
    const view = $('stdin-view');
    if (!view) return;
    const running = Boolean(snapshot) && $('editor').hidden;
    $('input-hint').textContent = running ? '本次输入 · 重新运行前可修改' : '开始前填写';
    view.hidden = !running;
    $('stdin').hidden = running;
    if (!running) return;
    const text = $('stdin').value;
    const trace = snapshot.inputTrace;
    if (trace?.state !== 'ok') {
      view.textContent = text;
      view.title = trace?.note || '读取位置未确认';
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const consumed = Math.max(0, Math.min(bytes.length, Number(trace.consumed) || 0));
    // 将字节边界映射到完整 Unicode 字符，避免分割中文与代理对。
    function characterBoundary(offset) {
      let size = 0;
      let index = 0;
      for (const character of text) {
        const count = new TextEncoder().encode(character).length;
        if (size + count > offset) break;
        size += count;
        index += character.length;
      }
      return index;
    }
    const end = characterBoundary(consumed);
    const start = characterBoundary(Math.min(consumed, Math.max(0, Number(trace.deltaStart) || 0)));
    const follow = view.scrollTop + view.clientHeight >= view.scrollHeight - 28;
    const changed = start < end ? node('mark', text.slice(start, end), 'io-changed') : null;
    const next = [...text.slice(end)][0] || '';
    const cursor = node('span', next, next ? 'io-cursor' : 'io-eof');
    view.replaceChildren(node('span', text.slice(0, start), 'io-consumed'), ...(changed ? [changed] : []), cursor,
      document.createTextNode(text.slice(end + next.length)));
    view.title = trace.note || '';
    keepHighlightVisible(view, changed || cursor, follow);
  }

  function renderData() {
    const container = $('data-views');
    const active = document.activeElement;
    const activeCard = active?.closest('.data-card');
    const focus = activeCard && container.contains(activeCard) ? {
      id: activeCard.dataset.variableId,
      control: [...activeCard.querySelectorAll('summary, input, select, button')].indexOf(active),
      draft: active.tagName === 'INPUT' ? active.value : null
    } : null;
    // 重建节点前保存老师的浏览位置；不因每一步刷新强行跟随下标。
    for (const card of container.querySelectorAll('.data-card')) {
      const settings = dataSettings.get(card.dataset.variableId);
      // 课例载入会替换设置对象，此时不能用上一课例的 DOM 覆盖新设置。
      if (!settings || card.viewSettings !== settings) continue;
      const scroll = card.querySelector('.structure-scroll');
      settings.open = card.open;
      settings.windowOpen = card.querySelector('.window-options').open;
      settings.scrollLeft = scroll.scrollLeft;
      settings.scrollTop = scroll.scrollTop;
    }
    const containerTop = container.scrollTop;
    const containerLeft = container.scrollLeft;
    const frames = (snapshot?.frames || []).filter((frame) => frame.user);
    if (!frames.some((frame) => frame.id === dataFrame)) dataFrame = null;
    const follow = node('option', '跟随当前调用帧'); follow.value = '';
    $('data-frame').replaceChildren(follow, ...frames.map((frame) => {
      const option = node('option', `${frame.level === 0 ? '当前 · ' : ''}${frame.function} · 第 ${frame.level + 1} 层`);
      option.value = frame.id;
      return option;
    }));
    $('data-frame').value = dataFrame || '';
    const selected = dataFrame ? frames.find((frame) => frame.id === dataFrame) : frames[0];
    const items = (snapshot?.variables || []).filter((v) => v.state !== 'out_of_scope');
    const local = items.filter((v) => v.kind !== 'global' && v.frame === selected?.level && !v.shadowed);
    const global = items.filter((v) => v.kind === 'global');
    $('frame-variables').hidden = !selected || selected.level === 0;
    variables('frame-locals', selected?.level > 0 ? local : [], '此帧暂无可见变量');
    const views = [...local, ...global].filter((v) => v.data);
    container.replaceChildren(...views.map((variable) => dataView(variable, variable.kind === 'global' ? global : [...local, ...global])));
    if (!views.length) container.append(node('p', '—', 'empty'));
    for (const card of container.querySelectorAll('.data-card')) {
      const settings = dataSettings.get(card.dataset.variableId);
      const scroll = card.querySelector('.structure-scroll');
      scroll.scrollLeft = settings.scrollLeft || 0;
      scroll.scrollTop = settings.scrollTop || 0;
      if (focus?.id === card.dataset.variableId) {
        const control = card.querySelectorAll('summary, input, select, button')[focus.control];
        if (control) {
          if (focus.draft !== null) control.value = focus.draft;
          control.focus({ preventScroll: true });
        }
      }
    }
    container.scrollTop = containerTop;
    container.scrollLeft = containerLeft;
    const accessKey = snapshot ? `${snapshot.runId}:${snapshot.step}` : '';
    if (accessKey !== lastAccessViewKey) {
      lastAccessViewKey = accessKey;
      for (const card of container.querySelectorAll('.data-card[open]')) {
        const scroll = card.querySelector('.structure-scroll');
        const cells = [...card.querySelectorAll('.access-write, .access-read')];
        if (!cells.length) continue;
        const target = card.querySelector('.access-write') || cells[0];
        const bounds = scroll.getBoundingClientRect();
        const rects = cells.map((cell) => cell.getBoundingClientRect());
        const left = Math.min(...rects.map((rect) => rect.left)), right = Math.max(...rects.map((rect) => rect.right));
        const rect = target.getBoundingClientRect();
        if (right - left <= scroll.clientWidth && (left < bounds.left || right > bounds.right)) scroll.scrollLeft += left - bounds.left - 8;
        else if (rect.left < bounds.left || rect.right > bounds.right) scroll.scrollLeft += rect.left - bounds.left - scroll.clientWidth / 2 + rect.width / 2;
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) scroll.scrollTop += rect.top - bounds.top;
        const settings = dataSettings.get(card.dataset.variableId);
        settings.scrollLeft = scroll.scrollLeft; settings.scrollTop = scroll.scrollTop;
      }
      const primary = container.querySelector('.access-write') || container.querySelector('.access-read');
      if (primary?.closest('.data-card')?.open) {
        const body = primary.closest('.data-body');
        const bounds = body.getBoundingClientRect(), rect = primary.getBoundingClientRect();
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) body.scrollTop += rect.top - bounds.top - body.clientHeight / 2 + rect.height / 2;
      }
    }
  }

  function isNumericArrayZero(variable, element) {
    if (element.state !== 'ok' || element.value === null || variable.data.kind === 'string') return false;
    // 只确认内建数值元素；不能把 char 的 '0'、空指针或未知 typedef 当作数值零。
    const type = (variable.type || '').replace(/\b(?:const|volatile)\b/g, '').trim();
    const vector = type.match(/^std::(?:__debug::)?vector\s*<\s*([^,>]+)/);
    const elementType = (vector ? vector[1] : type.replace(/\[[^\]]*\]/g, '')).replace(/\s+/g, ' ').trim();
    if (!/^(?:(?:signed|unsigned)(?: (?:short(?: int)?|int|long(?: long)?(?: int)?))?|short(?: int)?|int|long(?: long)?(?: int)?|float|double|long double)$/.test(elementType)) return false;
    // 检查尾数本身全为零，避免 Number('1e-999') 下溢而误判。
    return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?[fFlL]?$/.test(String(element.value).trim());
  }

  function dataView(variable, candidates) {
    const data = variable.data;
    const settings = dataSettings.get(variable.id) || { open: true, axes: [] };
    if (!Number.isInteger(settings.prefixLimit) || settings.prefixLimit < 1 || settings.prefixLimit > 200) {
      settings.prefixLimit = Number.isInteger(data.limit) && data.limit >= 1 && data.limit <= 200 ? data.limit : 50;
    }
    dataSettings.set(variable.id, settings);
    const card = node('details', undefined, 'data-card');
    card.viewSettings = settings;
    card.dataset.structure = variable.name;
    card.dataset.variableId = variable.id;
    card.dataset.kind = data.kind;
    card.open = settings.open;
    card.addEventListener('toggle', () => { if (card.isConnected) settings.open = card.open; });
    const shape = data.kind === 'matrix' ? `二维数组 · ${data.shape[0]} 行 × ${data.shape[1]} 列` : `${data.kind === 'vector' ? 'vector' : data.kind === 'string' ? '字符串' : '一维数组'} · 长度 ${data.total}`;
    card.append(node('summary', `${variable.name} · ${shape}${variable.kind === 'global' ? ' · 全局' : ''}`));
    const content = node('div', undefined, 'data-content');
    card.append(content);
    if (data.note && data.kind !== 'string') content.append(node('p', data.note, 'data-note'));
    const windowControls = node('form', undefined, 'window-controls');
    const offset = node('input');
    offset.type = 'number'; offset.min = '0'; offset.max = String(Number.MAX_SAFE_INTEGER); offset.step = '1'; offset.value = data.offset;
    offset.setAttribute('aria-label', variable.name + ' 窗口起点');
    const limit = node('input');
    limit.type = 'number'; limit.min = '1'; limit.max = '200'; limit.step = '1'; limit.value = data.limit;
    limit.setAttribute('aria-label', variable.name + ' 窗口大小');
    const label = (text, control) => { const result = node('label', text); result.append(control); return result; };
    const prefixControls = node('form', undefined, 'window-controls prefix-controls');
    const prefix = node('input');
    prefix.type = 'number'; prefix.min = '1'; prefix.max = '200'; prefix.step = '1'; prefix.value = settings.prefixLimit;
    prefix.dataset.prefixLimit = '';
    prefix.setAttribute('aria-label', variable.name + ' 展示前几个元素');
    const prefixApply = node('button', `展示前 ${settings.prefixLimit} 个`); prefixApply.type = 'submit';
    prefix.addEventListener('input', () => {
      const count = Number(prefix.value);
      if (Number.isInteger(count) && count >= 1 && count <= 200) {
        settings.prefixLimit = count;
        prefixApply.textContent = `展示前 ${count} 个`;
      }
    });
    prefixControls.append(label('展示前 ', prefix), node('span', '个元素'), prefixApply);
    prefixControls.addEventListener('submit', (event) => {
      event.preventDefault();
      changeWindow(variable.id, 0, Number(prefix.value), { prefix: true });
    });
    const apply = node('button', '应用窗口'); apply.type = 'submit';
    windowControls.append(label('起点 ', offset), label('数量 ', limit), apply);
    for (const [text, start] of [['上一段', Math.max(0, data.offset - data.limit)], ['下一段', data.offset + data.limit]]) {
      const button = node('button', text); button.type = 'button';
      button.addEventListener('click', () => { if (start < data.total) changeWindow(variable.id, start, data.limit); });
      windowControls.append(button);
    }
    windowControls.addEventListener('submit', (event) => { event.preventDefault(); changeWindow(variable.id, Number(offset.value), Number(limit.value)); });
    const windowOptions = node('details', undefined, 'window-options');
    windowOptions.open = Boolean(settings.windowOpen);
    const rangeLabel = data.elements.length ? `范围 ${data.offset}–${data.offset + data.elements.length - 1}` : '范围：暂无已读取元素';
    windowOptions.append(node('summary', rangeLabel), prefixControls, windowControls);
    const tools = node('div', undefined, 'data-tools');
    tools.append(windowOptions);
    if (data.kind === 'string') {
      const display = node('select', undefined, 'character-mode');
      display.setAttribute('aria-label', variable.name + ' 字符显示方式');
      for (const [value, text] of [['character', '字符'], ['code', '编码']]) {
        const option = node('option', text); option.value = value; display.append(option);
      }
      display.value = settings.characterMode || 'character';
      display.addEventListener('change', () => { settings.characterMode = display.value; renderData(); });
      tools.append(display);
      if (data.note) {
        const hint = node('span', 'ⓘ', 'character-info');
        hint.title = data.note; hint.tabIndex = 0; hint.setAttribute('aria-label', data.note);
        tools.append(hint);
      }
    }
    content.append(tools);
    const axes = data.kind === 'matrix' ? 2 : 1;
    const values = [];
    const selectors = node('div', undefined, 'index-controls');
    for (let axis = 0; axis < axes; axis++) {
      const select = node('select');
      select.setAttribute('aria-label', variable.name + (axes === 2 ? axis === 0 ? ' 行下标' : ' 列下标' : ' 下标'));
      const empty = node('option', '不关联'); empty.value = '';
      select.append(empty);
      for (const item of candidates.filter((v) => !v.data && /^(?:const )?(?:(?:unsigned |signed )?(?:int|short|long|long long)|size_t)(?: const)?$/.test(v.type))) {
        const option = node('option', `${item.name}${item.kind === 'global' ? '（全局）' : ''} = ${valueText(item)}`);
        option.value = item.id; select.append(option);
      }
      if (settings.axes[axis] && !candidates.some((v) => v.id === settings.axes[axis])) {
        const missing = node('option', '原下标变量已离开作用域'); missing.value = settings.axes[axis]; select.append(missing);
      }
      select.value = settings.axes[axis] || '';
      select.addEventListener('change', () => { settings.axes[axis] = select.value; renderData(); controls(); });
      selectors.append(label(axes === 2 ? axis === 0 ? '行下标 ' : '列下标 ' : '下标 ', select));
      const chosen = candidates.find((v) => v.id === settings.axes[axis]);
      values.push(chosen?.state === 'ok' && /^-?\d+$/.test(chosen.value || '') ? BigInt(chosen.value) : null);
    }
    tools.append(selectors);
    const outside = values.some((value, axis) => value !== null && (value < BigInt(data.lowerBounds[axis] || 0) || value >= BigInt((data.lowerBounds[axis] || 0) + (data.shape[axis] || 0))));
    const indicators = values.map((value, axis) => {
      const chosen = candidates.find((v) => v.id === settings.axes[axis]);
      return `${axes === 2 ? axis === 0 ? '行' : '列' : '下标'}：${value === null ? settings.axes[axis] ? '值未确认或已离开作用域' : '未关联' : `${chosen?.name || ''} = ${value}`}`;
    });
    const marker = node('p', indicators.join('；') + (outside ? ' → 越界（范围外）' : ''), 'index-status' + (outside ? ' out-of-range' : ''));
    marker.hidden = !outside && values.every((value) => value === null) && !settings.axes.some(Boolean);
    content.append(marker);
    const windowInfo = `共 ${data.total} 项 · 已隐藏 ${data.hidden}`;
    const info = node('p', windowInfo, 'window-info');
    tools.append(info);
    const scroll = node('div', undefined, 'structure-scroll');
    const grid = node('div', undefined, data.kind === 'matrix' ? 'element-grid matrix-grid' : 'element-grid array-strip');
    // 只为实际读取到的坐标生成行列，极宽矩阵也不会创建整行空格子。
    const columns = [...new Set(data.elements.map((element) => element.coordinates.at(-1)))].sort((a, b) => a - b);
    const rows = [...new Set(data.elements.map((element) => element.coordinates[0]))].sort((a, b) => a - b);
    const tracks = (coordinates) => coordinates.flatMap((value, index) => index && value > coordinates[index - 1] + 1 ? [null, value] : [value]);
    const columnTracks = tracks(columns);
    const rowTracks = tracks(rows);
    if (data.kind === 'matrix') {
      grid.style.gridTemplateColumns = `3em repeat(${columnTracks.length}, minmax(5em, 1fr))`;
      grid.setAttribute('aria-label', variable.name + ' 二维数组行列逻辑视图');
      grid.append(node('span', '行 / 列', 'grid-axis'));
      for (const column of columnTracks) {
        const header = node('span', column === null ? '…' : '列 ' + column, 'grid-axis' + (column === null ? ' axis-gap' : ''));
        if (column === null) header.title = '中间列未在当前窗口读取';
        grid.append(header);
      }
      for (const row of rowTracks) {
        const header = node('span', row === null ? '…' : '行 ' + row, 'grid-axis' + (row === null ? ' axis-gap' : ''));
        if (row === null) header.title = '中间行未在当前窗口读取';
        header.style.gridRow = rowTracks.indexOf(row) + 2; header.style.gridColumn = 1; grid.append(header);
      }
      const loaded = new Set(data.elements.map((element) => element.coordinates.join(',')));
      // 窗口可能在一行中间开始或结束，空位须区别于未初始化的已读取元素。
      for (const row of rows) for (const column of columns) {
        if (loaded.has(`${row},${column}`)) continue;
        const unread = node('span', '未读取', 'matrix-unread');
        unread.title = `[${row}][${column}] 不在当前读取窗口中`;
        unread.style.gridRow = rowTracks.indexOf(row) + 2;
        unread.style.gridColumn = columnTracks.indexOf(column) + 2;
        grid.append(unread);
      }
    }
    let marked = false;
    const rendered = [];
    const access = snapshot?.arrayAccess;
    const accessCoordinates = (items) => new Set((items || []).filter((item) => item.variableId === variable.id).map((item) => item.coordinates.join(',')));
    const reads = accessCoordinates(access?.reads);
    const writes = accessCoordinates(access?.writes);
    const priorVariable = previous?.variables?.find((item) => item.id === variable.id);
    const priorElements = new Map((priorVariable?.data?.elements || []).map((item) => [item.coordinates.join(','), item]));
    for (const element of data.elements) {
      const prior = priorElements.get(element.coordinates.join(','));
      const confirmed = (prior || priorVariable?.state !== 'ok') && becameKnown(element, prior);
      const cell = node('div', undefined, 'element' + (element.changed || confirmed ? ' changed' : '') + (element.state !== 'ok' ? ' unknown' : ''));
      if (isNumericArrayZero(variable, element)) cell.classList.add('zero-value');
      cell.dataset.index = element.index; cell.dataset.coordinates = element.coordinates.join(',');
      cell.dataset.variableId = variable.id;
      cell.dataset.value = element.value ?? '';
      cell.dataset.valueState = valueState(element);
      const key = element.coordinates.join(',');
      const read = reads.has(key), write = writes.has(key);
      if (read) cell.classList.add('access-read');
      if (write) cell.classList.add('access-write');
      if (read || write) cell.dataset.access = read && write ? 'read-write' : write ? 'write' : 'read';
      const matches = values.some((value) => value !== null) && !outside && values.every((value, axis) => value === null || value === BigInt(element.coordinates[axis]));
      if (matches) {
        cell.classList.add('indexed');
        cell.dataset.pointerLabel = values.map((value, axis) => value === null ? '' : `${candidates.find((v) => v.id === settings.axes[axis])?.name || (axis ? '列' : '行')} = ${value}`).filter(Boolean).join('；');
        marked = true;
      }
      cell.append(node('span', element.coordinates.map((v) => '[' + v + ']').join(''), 'element-index'), node('strong', valueText(element), 'element-value'));
      if (data.kind === 'string' && element.state === 'ok') {
        const character = String(element.value ?? '').match(/^\s*([+-]?\d+)\s+('.*')$/s);
        if (character) {
          cell.querySelector('.element-value').textContent = settings.characterMode === 'code' ? character[1] : character[2];
          cell.title = `字符 ${character[2]} · 编码 ${character[1]}`;
        }
      }
      if (element.note) cell.title = element.note;
      if (element.state !== 'ok' && element.note?.startsWith('读取失败')) cell.querySelector('.element-value').textContent = '读取失败';
      if (element.changed) cell.title = `上一步：${element.previousValue}；当前：${element.value}`;
      else if (confirmed) cell.title = `${valueText(prior)} → ${element.value}`;
      if (data.kind === 'matrix') { cell.style.gridRow = rowTracks.indexOf(element.coordinates[0]) + 2; cell.style.gridColumn = columnTracks.indexOf(element.coordinates[1]) + 2; }
      rendered.push({ element, cell });
    }
    // 折叠只依据本次实际读取的相邻元素，不推断窗口外的值，也不遮挡读写和下标。
    settings.expandedRuns ||= [];
    const foldable = ({ element, cell }) => element.state === 'ok' && element.value !== null && element.value !== undefined && !cell.matches('.changed, .indexed, .access-read, .access-write');
    for (let start = 0; start < rendered.length;) {
      let end = start + 1;
      if (data.kind !== 'matrix' && data.kind !== 'string' && foldable(rendered[start])) {
        while (end < rendered.length && foldable(rendered[end]) && rendered[end].element.index === rendered[end - 1].element.index + 1 && rendered[end].element.value === rendered[start].element.value) end++;
      }
      if (end - start >= 6) {
        const first = rendered[start + 1].element.coordinates[0];
        const last = rendered[end - 2].element.coordinates[0];
        const runKey = `${first}:${last}:${rendered[start].element.value}`;
        const expanded = settings.expandedRuns.includes(runKey);
        const fold = node('button', undefined, 'element repeat-fold' + (expanded ? ' expanded' : ''));
        fold.type = 'button'; fold.dataset.foldRange = `${first},${last}`;
        const description = `${expanded ? '收起' : '展开'} [${first}…${last}] 的 ${end - start - 2} 个相同值：${rendered[start].element.value}`;
        fold.title = description; fold.setAttribute('aria-label', description); fold.setAttribute('aria-expanded', String(expanded));
        fold.append(node('span', `[${first}…${last}]`, 'element-index'), node('span', '⋯', 'fold-symbol'));
        fold.addEventListener('click', () => {
          settings.expandedRuns = expanded ? settings.expandedRuns.filter((key) => key !== runKey) : [...settings.expandedRuns, runKey];
          renderData();
        });
        grid.append(rendered[start].cell, fold);
        if (expanded) for (let index = start + 1; index < end - 1; index++) grid.append(rendered[index].cell);
        grid.append(rendered[end - 1].cell);
      } else {
        for (let index = start; index < end; index++) grid.append(rendered[index].cell);
      }
      start = end;
    }
    if (!outside && values.some((value) => value !== null) && !marked && data.state === 'ok') marker.append(' → 位于当前窗口之外');
    scroll.append(grid); content.append(scroll);
    if (grid.querySelector('.indexed')) grid.classList.add('has-pointer');
    if (!data.elements.length) content.append(node('p', data.state === 'ok' ? '当前容器为空。' : data.note || '无法可靠读取元素。', 'empty'));
    return card;
  }

  async function changeWindow(variableId, offset, limit, { prefix = false } = {}) {
    if (busy || stopping || playing || snapshot?.status !== 'paused' || uncertain) return;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) { notice('窗口起点须为非负整数，数量须为 1–200。'); return; }
    busy = true;
    const version = revision;
    const runId = snapshot.runId;
    controls();
    try {
      const result = await request('/api/window', { sessionId, runId, variableId, offset, limit });
      if (version === revision && result.runId === snapshot?.runId) {
        const currentSettings = dataSettings.get(variableId);
        if (currentSettings) currentSettings.prefixApplied = prefix;
        const settings = dataSettings.get(variableId);
        if (prefix && settings) {
          settings.prefixLimit = limit;
          // 应用“前 X 个”是明确定位操作；普通单步仍保留老师浏览位置。
          const card = [...$('data-views').querySelectorAll('.data-card')].find((item) => item.dataset.variableId === variableId);
          const scroll = card?.querySelector('.structure-scroll');
          if (scroll) { scroll.scrollLeft = 0; scroll.scrollTop = 0; }
          settings.scrollLeft = settings.scrollTop = 0;
        }
        remember(result); render();
      }
    } catch (error) { if (version === revision) { notice(error.message); if (error.disconnected) uncertain = true; } }
    finally { busy = false; controls(); }
  }

  function compilerInfo(result) {
    errorLines = [];
    $('diagnostic-links').replaceChildren();
    const compile = result?.compile;
    const text = [compile?.stdout, compile?.stderr].filter(Boolean).join('\n');
    $('diagnostics').hidden = !text;
    $('compiler-output').textContent = text;
    // GCC 的盘符路径可能含冒号；只提取末尾的行/列号和诊断级别。
    for (const match of text.matchAll(/:(\d+):(\d+):\s*(fatal error|error|warning|note):\s*([^\r\n]*)/g)) {
      const line = Number(match[1]);
      const isError = /error/.test(match[3]);
      if (isError) errorLines.push(line);
      const button = document.createElement('button');
      button.textContent = `第 ${line} 行，第 ${match[2]} 列 · ${isError ? '错误' : match[3] === 'warning' ? '警告' : '提示'}`;
      button.title = match[4];
      button.addEventListener('click', () => { mode(false); renderCode(line); });
      $('diagnostic-links').append(button);
    }
    if (result?.status === 'compile_error' && errorLines.length) {
      mode(false);
      renderCode(errorLines[0]);
    }
  }

  function terminalMessage(result) {
    switch (result.status) {
      case 'compile_error': return '编译失败';
      case 'runtime_error': {
        const reason = result.reason;
        return '程序运行异常，已停止。' + (reason?.['signal-name'] ? ` 信号：${reason['signal-name']}。` : '') + (reason?.['exit-code'] ? ` 退出码：${reason['exit-code']}。` : '') + '请检查代码后重新运行。';
      }
      case 'timeout': return '当前执行超过时限，已停止。请检查死循环或输入数据后重新运行。';
      case 'output_limit': return '程序输出达到 1 MB 上限，已停止。请减少输出后重新运行。';
      case 'step_limit': return '已达到 2000 步上限，请缩小样例后重新运行。';
      case 'error': return '调试失败，请检查本机 GCC/GDB 环境后重新运行。' + (typeof result.error === 'string' ? '\n' + result.error : '');
      default: return '';
    }
  }

  async function receive(result) {
    if (!Number.isInteger(result.step)) {
      if (result.status === 'stale' || result.status === 'invalid_state') uncertain = true;
      pause();
      notice(result.status === 'command_error' ? '此处无法执行该操作，请使用“下一步”或“跳过函数”。' : result.error || '操作未完成，请重新运行。');
      return;
    }
    const wasViewing = history.length && historyIndex < history.length - 1;
    const receivedRevision = revision;
    let restoreError = null;
    try { result = await restorePresentation(result); result = await revealAccessWindows(result); }
    catch (error) { restoreError = error; }
    if (receivedRevision !== revision) return;
    remember(result);
    uncertain = Boolean(restoreError?.disconnected);
    if (result.status !== 'paused') pause();
    mode(false);
    render({ animate: true });
    compilerInfo(result);
    notice(terminalMessage(result) || (restoreError ? '本步已执行，展示设置未能恢复。' + restoreError.message : wasViewing ? '已回到最新状态。' : ''));
  }

  async function request(path, data) {
    let response;
    try {
      response = await fetch(api + path, {
        method: data ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json' } : {},
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(90000)
      });
    } catch {
      $('connection').textContent = '本地服务未连接';
      const error = new Error('无法连接本地服务。请双击“代码实验台/start.bat”，保持启动窗口开启，再点击“重新连接”。');
      error.disconnected = true;
      throw error;
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('本地服务返回格式异常，请检查服务窗口后重新运行。'); }
    $('connection').textContent = '本地服务已连接';
    if (!response.ok) throw new Error(result.error || '本地服务拒绝了此次操作，请稍后重试。');
    return result;
  }

  async function connect() {
    try {
      await request('/api/health');
      if (!snapshot) notice();
      else if (uncertain) notice('本地服务已连接，请点击“重新运行”开始新的运行。');
    } catch (error) { notice(error.message); }
  }

  function pause() {
    playing = false;
    clearTimeout(timer);
    timer = null;
    controls();
  }

  async function start() {
    if (busy || stopping) return;
    pause();
    presentationPresets = new Map([...presentationPresets, ...[...dataSettings].map(([id, setting]) => [presentationKey(id), { ...setting, axes: [...(setting.axes || [])] }])]);
    restoredPresentations.clear();
    restoredPrefixWindows.clear();
    const version = ++revision;
    busy = starting = true;
    snapshot = previous = null;
    resetHistory();
    dataSettings.clear(); dataFrame = null;
    errorLines = [];
    uncertain = false;
    notice();
    render();
    compilerInfo(null);
    mode(false);
    try {
      const result = await request('/api/start', { sessionId, source: $('source').value, input: $('stdin').value, standard: $('standard').value });
      if (version === revision) await receive(result);
    } catch (error) {
      notice(error.message);
      if (error.disconnected) uncertain = true;
    } finally {
      busy = starting = false;
      controls();
    }
  }

  async function command(commandName) {
    if (busy || stopping || uncertain) return;
    returnToLatest();
    if (snapshot?.status !== 'paused') return;
    busy = true;
    const version = revision;
    const runId = snapshot.runId;
    controls();
    notice();
    try {
      const result = await request('/api/command', { sessionId, runId, command: commandName });
      if (version === revision && snapshot?.runId === runId) await receive(result);
    } catch (error) {
      if (version === revision) {
        pause();
        uncertain = true; // 请求结果未知，重跑前不再推进旧状态。
        notice(error.message);
      }
    } finally {
      busy = false;
      controls();
      if (playing && version === revision && snapshot?.status === 'paused') timer = setTimeout(() => command('next'), Number($('speed').value));
    }
  }

  async function stop() {
    if (starting || stopping || snapshot?.status !== 'paused') return;
    returnToLatest();
    if (snapshot?.status !== 'paused') return;
    pause();
    ++revision; // 正在返回的旧单步不能覆盖停止结果。
    stopping = true;
    controls();
    try {
      await receive(await request('/api/command', { sessionId, runId: snapshot.runId, command: 'stop' }));
    } catch (error) {
      uncertain = true;
      notice(error.message);
    } finally { stopping = false; controls(); }
  }

  function edited() {
    if (snapshot) {
      snapshot = previous = null;
      resetHistory();
      errorLines = [];
      compilerInfo(null);
      notice();
    }
    render();
  }

  function displaySettings() {
    return {
      standard: $('standard').value,
      codeTheme: $('code-theme').value,
      example: $('example').value,
      mode: $('editor').hidden ? 'view' : 'edit',
      layout: { ...layout },
      dataFrame,
      dataSettings: [...dataSettings.entries()].map(([id, value]) => ({ id, open: Boolean(value.open), axes: [...(value.axes || [])], prefixLimit: value.prefixLimit, prefixApplied: Boolean(value.prefixApplied) }))
    };
  }

  function caseData() {
    return { version: CASE_VERSION, code: $('source').value, input: $('stdin').value, display: displaySettings() };
  }

  function downloadCase(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '代码实验台课例.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function saveCase() {
    const data = caseData();
    try { localStorage.setItem(CASE_STORAGE_KEY, JSON.stringify(data)); } catch { /* 下载仍可用 */ }
    downloadCase(data);
    notice('课例已保存');
  }

  function validateCase(data) {
    if (!data || typeof data !== 'object' || data.version !== CASE_VERSION) {
      throw new Error(`课例版本不兼容：当前支持版本 ${CASE_VERSION}。`);
    }
    if (typeof data.code !== 'string' || typeof data.input !== 'string') throw new Error('课例缺少有效的代码或输入。');
    if (data.display && typeof data.display !== 'object') throw new Error('课例展示设置格式不正确。');
    return data;
  }

  function applyCase(data) {
    validateCase(data);
    $('source').value = data.code;
    $('stdin').value = data.input;
    const display = data.display || {};
    if (display.layout) applyLayout(display.layout, true);
    if (['c++11', 'c++14'].includes(display.standard)) $('standard').value = display.standard;
    if (['light', 'dark', 'dracula'].includes(display.codeTheme)) applyCodeTheme(display.codeTheme, true);
    if ([...$('example').options].some((option) => option.value === display.example)) $('example').value = display.example;
    dataSettings.clear();
    presentationPresets.clear();
    restoredPresentations.clear();
    restoredPrefixWindows.clear();
    for (const item of display.dataSettings || []) {
      if (item && typeof item.id === 'string') {
        const prefixLimit = Number.isInteger(item.prefixLimit) && item.prefixLimit >= 1 && item.prefixLimit <= 200 ? item.prefixLimit : 50;
        dataSettings.set(item.id, { open: Boolean(item.open), axes: Array.isArray(item.axes) ? [...item.axes] : [], prefixLimit, prefixApplied: Boolean(item.prefixApplied) });
      }
    }
    dataFrame = typeof display.dataFrame === 'string' ? display.dataFrame : null;
    snapshot = previous = null;
    resetHistory();
    uncertain = false;
    errorLines = [];
    compilerInfo(null);
    render();
    mode(display.mode !== 'view');
    notice('课例已载入');
  }

  async function loadCaseFile(file) {
    if (!file) return;
    try {
      let data;
      try { data = JSON.parse(await file.text()); }
      catch { throw new Error('课例文件不是有效的 JSON。'); }
      applyCase(data);
    }
    catch (error) { notice(error.message || '课例文件无法载入。'); }
    finally { $('case-file').value = ''; }
  }

  function restoreCase() {
    try {
      const raw = localStorage.getItem(CASE_STORAGE_KEY);
      if (!raw) { notice('本机还没有保存的课例。'); return; }
      applyCase(JSON.parse(raw));
    } catch (error) { notice(error.message || '最近课例无法载入。'); }
  }

  function applyLayout(value, save = false) {
    const workspace = document.querySelector('.workspace');
    if (!workspace) return;
    layout = {
      codeWidth: Math.min(65, Math.max(35, Number(value.codeWidth) || defaultLayout.codeWidth)),
      stateHeight: Math.min(80, Math.max(40, Number(value.stateHeight) || defaultLayout.stateHeight)),
      variablesHeight: Number(value.variablesHeight) || defaultLayout.variablesHeight
    };
    workspace.style.setProperty('--code-width', layout.codeWidth + '%');
    workspace.style.setProperty('--state-height', layout.stateHeight + '%');
    const maximum = Math.max(84, document.querySelector('.state-grid').clientHeight - 108);
    layout.variablesHeight = Math.min(maximum, Math.max(84, layout.variablesHeight));
    workspace.style.setProperty('--variables-height', layout.variablesHeight + 'px');
    $('variables-splitter').setAttribute('aria-valuemin', '84');
    $('variables-splitter').setAttribute('aria-valuemax', String(Math.floor(maximum)));
    for (const [id, key] of [['code-splitter', 'codeWidth'], ['io-splitter', 'stateHeight'], ['variables-splitter', 'variablesHeight']]) {
      $(id)?.setAttribute('aria-valuenow', String(Math.round(layout[key])));
    }
    if (save) {
      try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* 布局仍可使用 */ }
    }
  }

  function setupLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY));
      // 旧版默认比例随新版更新，老师主动调整的比例仍然保留。
      applyLayout(saved?.variablesHeight === undefined && saved?.codeWidth === 50 && saved?.stateHeight === 65 ? defaultLayout : saved || layout);
    }
    catch { applyLayout(layout); }
    for (const [id, key, selector, vertical] of [
      ['code-splitter', 'codeWidth', '.workspace', false],
      ['io-splitter', 'stateHeight', '.inspector', true],
      ['variables-splitter', 'variablesHeight', '.state-grid', true]
    ]) {
      const handle = $(id);
      if (!handle) continue;
      let dragging = false;
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging = true;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
      });
      handle.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const bounds = document.querySelector(selector).getBoundingClientRect();
        const position = vertical ? event.clientY - bounds.top : event.clientX - bounds.left;
        const length = vertical ? bounds.height : bounds.width;
        applyLayout({ ...layout, [key]: key === 'variablesHeight' ? position - 4 : position / length * 100 });
      });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        applyLayout(layout, true);
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
      handle.addEventListener('keydown', (event) => {
        const direction = vertical ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
        if (!(event.key in direction)) return;
        event.preventDefault();
        const distance = key === 'variablesHeight' ? (event.shiftKey ? 40 : 8) : (event.shiftKey ? 5 : 1);
        applyLayout({ ...layout, [key]: layout[key] + direction[event.key] * distance }, true);
      });
      handle.title = '拖动或方向键调整，双击恢复默认比例';
      handle.addEventListener('dblclick', () => applyLayout({ ...layout, [key]: defaultLayout[key] }, true));
    }
    new ResizeObserver(() => applyLayout(layout)).observe(document.querySelector('.state-grid'));
  }

  $('start').addEventListener('click', start);
  $('restart').addEventListener('click', start);
  $('next').addEventListener('click', () => command('next'));
  $('step').addEventListener('click', () => command('step'));
  $('over').addEventListener('click', () => command('next'));
  $('play').addEventListener('click', () => {
    if (busy) return;
    returnToLatest();
    if (snapshot?.status !== 'paused') return;
    playing = true;
    command('next');
  });
  $('pause').addEventListener('click', () => {
    pause();
    if (busy) notice('已暂停播放，当前这一步完成后停下。需要立即中断时请点击“停止”。');
  });
  $('stop').addEventListener('click', stop);
  $('edit').addEventListener('click', () => { mode(true); $('source').focus(); });
  $('view').addEventListener('click', () => { mode(false); renderCode(); });
  $('source').addEventListener('input', edited);
  $('stdin').addEventListener('input', edited);
  $('standard').addEventListener('change', edited);
  $('source').addEventListener('scroll', syncEditorScroll);
  $('source').addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !$('source').readOnly) {
      event.preventDefault();
      const source = $('source');
      source.setRangeText('    ', source.selectionStart, source.selectionEnd, 'end');
      edited();
    }
  });
  function loadExample() {
    dataSettings.clear();
    presentationPresets.clear();
    const example = examples[$('example').value];
    $('source').value = example.source;
    $('stdin').value = example.input;
    edited();
    mode(true);
  }
  $('example').addEventListener('change', loadExample);
  $('reconnect').addEventListener('click', connect);
  $('data-frame').addEventListener('change', () => { dataFrame = $('data-frame').value; renderData(); controls(); });
  $('history-prev').addEventListener('click', () => selectHistory(historyIndex - 1));
  $('history-next').addEventListener('click', () => selectHistory(historyIndex + 1));
  $('history-latest').addEventListener('click', () => selectHistory(history.length - 1));
  $('history-slider').addEventListener('input', () => selectHistory(Number($('history-slider').value)));
  $('speed').addEventListener('change', () => { cancelFeedback(); if (playing) notice(`播放速度已调整为 ${$('speed').selectedOptions[0].text}。`); });
  $('save-case').addEventListener('click', saveCase);
  $('load-case').addEventListener('click', () => $('case-file').click());
  $('restore-case').addEventListener('click', restoreCase);
  $('case-file').addEventListener('change', () => loadCaseFile($('case-file').files[0]));
  $('dismiss-notice')?.addEventListener('click', () => notice());
  $('dismiss-diagnostics')?.addEventListener('click', () => { $('diagnostics').hidden = true; });
  document.addEventListener('pointerdown', (event) => {
    const menu = document.querySelector('.more-menu');
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const menu = document.querySelector('.more-menu');
      if (menu) menu.open = false;
      if ($('error-details')) $('error-details').open = false;
      $('diagnostics').hidden = true;
      notice();
    }
  });
  document.querySelectorAll('.more-menu button').forEach((button) => button.addEventListener('click', () => {
    const menu = document.querySelector('.more-menu');
    if (menu) menu.open = false;
  }));
  window.addEventListener('pagehide', () => {
    pause();
    navigator.sendBeacon(api + '/api/close', new Blob([JSON.stringify({ sessionId })], { type: 'application/json' }));
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      snapshot = previous = null;
      resetHistory();
      render();
      compilerInfo(null);
      notice('请重新运行，恢复前的会话已清理。');
    }
  });
  // 标签页被强制关闭、未能发出 pagehide 时，由服务端租约回收。
  setInterval(() => {
    if (liveSnapshot && !uncertain) {
      fetch(api + '/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }) }).catch(() => {});
    }
  }, 10000);
  setupCodeTheme();
  setupMotion();
  setupLayout();
  loadExample();
  connect();
})();
