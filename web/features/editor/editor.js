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
      const content = document.createDocumentFragment();
      highlightedLines.forEach((line, index) => {
        if (index) content.append(document.createTextNode('\n'));
        content.append(line.cloneNode(true));
      });
      // textarea 的末尾空行需要同高的布局占位，不参与词法结果或源代码。
      if (source.endsWith('\n')) {
        const endLine = document.createElement('span');
        endLine.className = 'editor-end-line';
        content.append(endLine);
      }
      $('edit-highlight').replaceChildren(content);
    }
    syncEditorScroll();
    return highlightedLines;
  }
  function mode(editing) {
    $('editor').hidden = !editing;
    $('code-view').hidden = editing;
    $('edit').setAttribute('aria-pressed', String(editing));
    $('view').setAttribute('aria-pressed', String(!editing));
    actions.renderInput();
  }
  function renderCode(focusLine = state.snapshot?.frames?.[0]?.user === false ? null : state.snapshot?.line ?? state.errorLines[0]) {
    const source = $('source').value.replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const colored = syntaxLines(source);
    $('edit-lines').textContent = lines.map((_, i) => i + 1).join('\n');
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const row = document.createElement('span');
      row.className = 'code-line';
      row.dataset.line = i + 1;
      if (state.previous?.runId === state.snapshot?.runId && state.previous?.step < state.snapshot?.step && state.previous?.line === i + 1 && state.previous?.frames?.[0]?.user !== false && state.snapshot?.motion && (state.snapshot.status !== 'paused' || state.snapshot.frames?.[0]?.user !== false && state.snapshot.frames.length <= (state.previous.frames?.length || 0)) && !['stopped', 'step_limit', 'compile_error', 'error'].includes(state.snapshot.status)) {
        row.classList.add('executed');
        row.title = '刚执行';
      }
      if (i + 1 === focusLine) {
        row.classList.add(state.errorLines.includes(focusLine) ? 'compile-error' : 'current');
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
        mode(false);
        renderCode(line);
      });
      $('diagnostic-links').append(button);
    }
    if (result?.status === 'compile_error' && state.errorLines.length) {
      mode(false);
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
    mode,
    renderCode,
    compilerInfo,
    edited
  };
}
