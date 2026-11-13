import { $, notice } from "../../shared/dom.js";
import * as CodeSyntax from './syntax.js';
let highlightedSource = null;
let highlightedLines = [];
export function createEditor({
  state,
  actions
}) {
  function syncEditorScroll() {
    const source = $('source'),
      view = $('edit-highlight');
    $('edit-lines').scrollTop = source.scrollTop;
    view.style.width = source.clientWidth + 'px';
    view.style.height = source.clientHeight + 'px';
    view.scrollTop = source.scrollTop;
    view.scrollLeft = source.scrollLeft;
  }
  function syntaxLines(source) {
    if (source !== highlightedSource) {
      highlightedSource = source;
      highlightedLines = CodeSyntax.highlight ? CodeSyntax.highlight(source) : source.split('\n').map(line => {
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode(line));
        return fragment;
      });
    }
    return highlightedLines;
  }
  function codeLockReason() {
    if (state.starting) return '正在编译，代码已锁定';
    if (state.stopping) return '正在停止，请稍候';
    if (state.uncertain) return '执行状态未确认，请重新连接后重新运行';
    if (state.busy) return '正在执行，代码已锁定';
    if (state.lessonLoading) return '正在载入课例，请稍候';
    if (state.historyIndex >= 0 && state.historyIndex < state.history.length - 1) return '正在回看历史，返回最新后可修改';
    if (state.liveSnapshot?.status === 'paused' || state.playing) return '运行中，代码已锁定；停止后可修改';
    return '';
  }
  function executionLine() {
    const before = state.previous, now = state.snapshot;
    if (now?.execution) {
      const spans = now.execution.spans || [];
      return spans.length ? spans.at(-1).line : null;
    }
    if (!before || before.runId !== now?.runId || before.step >= now.step || before.status !== 'paused' ||
        !['next', 'step'].includes(now.motion) || !['paused', 'completed'].includes(now.status) ||
        before.frames?.[0]?.user === false) return null;
    // 进入函数只完成了调用的一部分，不把尚未返回的调用表达式标为已完成。
    if (now.frames?.slice(1).some(frame => frame.id === before.frames?.[0]?.id)) return null;
    return before.line;
  }
  let renderedPosition = '';
  function renderCode(focusLine) {
    const source = $('source').value.replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const colored = syntaxLines(source);
    const next = state.snapshot?.status === 'paused' && state.snapshot.frames?.[0]?.user !== false ? state.snapshot.line : null;
    const executed = executionLine();
    const executionSpans = state.snapshot?.execution?.spans || [];
    const selectedFrame = executionSpans.at(-1)?.frameId;
    const executedLines = new Set();
    for (const span of executionSpans.filter(span => span.frameId === selectedFrame)) {
      for (let line = span.line; line <= span.endLine; line++) executedLines.add(line);
    }
    const fragment = document.createDocumentFragment();
    const gutter = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      const row = document.createElement('span');
      row.className = 'code-line';
      row.dataset.line = line;
      const number = document.createElement('span');
      number.className = 'line-number';
      number.textContent = line;
      if (executedLines.has(line) || line === executed) {
        row.classList.add('executed');
        number.classList.add('executed');
        row.title = '刚执行：本步从此行推进';
      }
      if (line === next) {
        row.classList.add('current');
        number.classList.add('current');
        row.setAttribute('aria-current', 'step');
        row.title = line === executed ? '刚执行 · 下一条仍在此行' : '下一条待执行';
      }
      if (state.errorLines.includes(line)) {
        row.classList.add('compile-error');
        number.classList.add('compile-error');
      }
      const code = document.createElement('span');
      code.className = 'line-text';
      code.append(colored[i].cloneNode(true));
      row.append(code);
      if (i) {
        fragment.append(document.createTextNode('\n'));
        gutter.append(document.createTextNode('\n'));
      }
      fragment.append(row);
      gutter.append(number);
    }
    // 每行共享最长行宽度，横向滚动后短行的整行底色仍覆盖可见区域。
    const content = document.createElement('span');
    content.className = 'code-lines';
    content.append(fragment);
    $('edit-highlight').replaceChildren(content);
    $('edit-lines').replaceChildren(gutter);
    $('line-hint').textContent = executed ? `● 刚执行：第 ${executed} 行` + (next ? ` · ➜ 下一条：第 ${next} 行` : '') : next ? `➜ 下一条：第 ${next} 行` : '';
    const position = state.snapshot ? `${state.snapshot.runId}:${state.snapshot.step}` : '';
    // 只在执行位置变化或显式定位诊断时跟随；普通输入和主题更新不抢滚动位置。
    const target = focusLine ?? (position !== renderedPosition ? executed ?? next : null);
    renderedPosition = position;
    if (target) {
      const view = $('source');
      const top = 8 + (target - 1) * 24;
      if (top < view.scrollTop || top + 24 > view.scrollTop + view.clientHeight) {
        view.scrollTop = Math.max(0, top - view.clientHeight / 3);
      }
    }
    syncEditorScroll();
  }
  function compilerInfo(result) {
    state.errorLines = [];
    $('diagnostic-links').replaceChildren();
    const compile = result?.compile;
    const text = [compile?.stdout, compile?.stderr].filter(Boolean).join('\n');
    $('diagnostics').hidden = !text;
    $('compiler-output').textContent = text;
    // GCC 的盘符路径可能含冒号；只提取末尾的行/列号和诊断级别。
    for (const match of text.matchAll(/:(\d+):(\d+):\s*(fatal error|error|warning|note):\s*([^\r\n]*)/g)) {
      const line = Number(match[1]);
      const isError = /error/.test(match[3]);
      if (isError) state.errorLines.push(line);
      const button = document.createElement('button');
      button.textContent = `第 ${line} 行，第 ${match[2]} 列 · ${isError ? '错误' : match[3] === 'warning' ? '警告' : '提示'}`;
      button.title = match[4];
      button.addEventListener('click', () => {
        renderCode(line);
      });
      $('diagnostic-links').append(button);
    }
    if (result?.status === 'compile_error' && state.errorLines.length) {
      renderCode(state.errorLines[0]);
    }
  }
  function edited() {
    ++state.editorRevision;
    actions.cancelLessonLoad();
    if (state.snapshot) {
      state.snapshot = state.previous = null;
      actions.resetHistory();
      state.errorLines = [];
      compilerInfo(null);
      notice();
    }
    actions.render();
  }
  return {
    syncEditorScroll,
    codeLockReason,
    renderCode,
    compilerInfo,
    edited
  };
}
