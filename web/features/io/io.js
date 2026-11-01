import { $, node } from "../../shared/dom.js";
export function createIO({
  state
}) {
  function keepHighlightVisible(view, changed, follow) {
    if (!changed || !follow) return;
    const top = changed.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
    if (top < view.scrollTop || top + changed.offsetHeight > view.scrollTop + view.clientHeight) {
      view.scrollTop = Math.max(0, top - view.clientHeight / 2);
    }
  }
  function renderOutput() {
    const view = $('stdout');
    const text = state.snapshot?.output?.stdout || '';
    const delta = state.snapshot?.outputDelta?.stdout;
    const before = state.previous?.runId === state.snapshot?.runId ? state.previous?.output?.stdout || '' : '';
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
    // 最新运行结束后直接恢复输入；回看历史时仍展示当步读取轨迹。
    const running = Boolean(state.snapshot) && $('editor').hidden && (state.snapshot.status === 'paused' || state.historyIndex < state.history.length - 1);
    $('input-hint').textContent = running ? '本次输入 · 重新运行前可修改' : '开始前填写';
    view.hidden = !running;
    $('stdin').hidden = running;
    if (!running) return;
    const text = $('stdin').value;
    const trace = state.snapshot.inputTrace;
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
    view.replaceChildren(node('span', text.slice(0, start), 'io-consumed'), ...(changed ? [changed] : []), cursor, document.createTextNode(text.slice(end + next.length)));
    view.title = trace.note || '';
    keepHighlightVisible(view, changed || cursor, follow);
  }
  return {
    renderOutput,
    renderInput
  };
}
