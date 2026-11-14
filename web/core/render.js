import { $, notice, noticeText } from "../shared/dom.js";
export function createRenderer({
  state,
  actions
}) {
  function render({
    animate = false
  } = {}) {
    const oldPointers = new Map();
    if (animate && state.previous?.runId === state.snapshot?.runId) {
      for (const cell of document.querySelectorAll('.element.indexed')) {
        if (!actions.pointerVisible(cell)) continue;
        const rect = cell.getBoundingClientRect();
        const label = (cell.dataset.pointerLabel || '').replace(/-?\d+/g, '#');
        oldPointers.set(`${cell.dataset.variableId}:${label}`, {
          left: rect.left,
          top: rect.top,
          coordinates: cell.dataset.coordinates
        });
      }
    }
    actions.cancelFeedback();
    const frames = state.snapshot?.frames || [];
    $('frame').textContent = frames[0]?.function || '—';
    $('frame-count').textContent = frames.length + ' 层';
    $('frames').replaceChildren(...frames.map((frame, i) => {
      const row = document.createElement('li');
      row.textContent = `${i === 0 ? '当前 → ' : ''}${frame.function} · ${frame.line ? '第 ' + frame.line + ' 行' : '位置未知'}`;
      return row;
    }));
    const items = state.snapshot?.variables || [];
    actions.variables('locals', items.filter(v => v.kind !== 'global' && v.frame === 0 && v.visible), '—');
    const globals = items.filter(v => v.kind === 'global' && v.state !== 'out_of_scope');
    actions.variables('globals', globals, '—');
    if ($('globals-section')) $('globals-section').hidden = !globals.length;
    actions.renderData({ animate });
    actions.renderOutput();
    actions.renderInput();
    $('stderr').textContent = state.snapshot?.output?.stderr || '';
    if ($('error-details')) $('error-details').hidden = !state.snapshot?.output?.stderr;
    const location = frames[0]?.user === false ? '当前位于库函数，本页未载入其源码' : state.snapshot?.line ? '下一条：第 ' + state.snapshot.line + ' 行' : '当前无待执行行';
    $('position').textContent = state.snapshot ? `第 ${state.snapshot.step} 步 · ${location}` : '先填写输入，再开始运行';
    $('position').title = $('position').textContent;
    actions.renderCode();
    actions.controls();
    if (animate) actions.showStepFeedback(oldPointers);
    if (state.historyLimitReached && !noticeText()) notice('已达到 2000 步历史上限，已保留已有记录。');
  }
  return {
    render
  };
}
