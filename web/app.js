// 原生模块装配：功能间通过 actions 显式调用，共享同一 state，不循环导入。
import { $, notice } from './shared/dom.js';
import { createState } from './core/state.js';
import { createApi } from './core/api.js';
import { createExecution } from './features/execution/execution.js';
import { createEditor } from './features/editor/editor.js';
import { createVariables } from './features/variables/variables.js';
import { createData } from './features/data/data.js';
import { createIO } from './features/io/io.js';
import { createHistory } from './features/history/history.js';
import { createLessons } from './features/lessons/lessons.js';
import { createLayout } from './presentation/layout.js';
import { createTheme } from './presentation/theme.js';
import { createMotion } from './presentation/motion.js';
import { createValueFormat } from './shared/value-format.js';
import { createRenderer } from './core/render.js';
const state = createState();
const client = createApi();
const actions = {};
for (const create of [createExecution, createEditor, createVariables, createData, createIO, createHistory, createLessons, createLayout, createTheme, createMotion, createValueFormat, createRenderer]) Object.assign(actions, create({
  state,
  actions,
  client
}));
$('start').addEventListener('click', actions.start);
$('restart').addEventListener('click', actions.start);
$('next').addEventListener('click', () => actions.command('next'));
$('step').addEventListener('click', () => actions.command('step'));
$('over').addEventListener('click', () => actions.command('next'));
$('play').addEventListener('click', () => {
  if (state.busy) return;
  actions.returnToLatest();
  if (state.snapshot?.status !== 'paused') return;
  state.playing = true;
  actions.command('next');
});
$('pause').addEventListener('click', () => {
  actions.pause();
  if (state.busy) notice('已暂停播放，当前这一步完成后停下。需要立即中断时请点击“停止”。');
});
$('stop').addEventListener('click', actions.stop);
$('source').addEventListener('input', actions.edited);
$('stdin').addEventListener('input', actions.edited);
$('standard').addEventListener('change', actions.edited);
$('source').addEventListener('scroll', actions.syncEditorScroll);
$('source').addEventListener('keydown', event => {
  if (event.key === 'Tab' && !$('source').readOnly) {
    event.preventDefault();
    const source = $('source');
    source.setRangeText('    ', source.selectionStart, source.selectionEnd, 'end');
    actions.edited();
  }
});
$('example').addEventListener('change', actions.loadExample);
$('reconnect').addEventListener('click', actions.connect);
$('data-frame').addEventListener('change', () => {
  state.dataFrame = $('data-frame').value;
  actions.renderData();
  actions.controls();
});
$('history-prev').addEventListener('click', () => actions.selectHistory(state.historyIndex - 1));
$('history-next').addEventListener('click', () => actions.selectHistory(state.historyIndex + 1));
$('history-latest').addEventListener('click', () => actions.selectHistory(state.history.length - 1));
$('history-slider').addEventListener('input', () => actions.selectHistory(Number($('history-slider').value)));
$('speed').addEventListener('change', () => {
  actions.cancelFeedback();
  if (state.playing) notice(`播放速度已调整为 ${$('speed').selectedOptions[0].text}。`);
});
$('save-case').addEventListener('click', actions.saveCase);
$('load-case').addEventListener('click', () => $('case-file').click());
$('restore-case').addEventListener('click', actions.restoreCase);
$('case-file').addEventListener('change', () => actions.loadCaseFile($('case-file').files[0]));
$('dismiss-notice')?.addEventListener('click', () => notice());
$('dismiss-diagnostics')?.addEventListener('click', () => {
  $('diagnostics').hidden = true;
});
document.addEventListener('pointerdown', event => {
  const menu = document.querySelector('.more-menu');
  if (menu?.open && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const menu = document.querySelector('.more-menu');
    if (menu) menu.open = false;
    if ($('error-details')) $('error-details').open = false;
    $('diagnostics').hidden = true;
    notice();
  }
});
document.querySelectorAll('.more-menu button').forEach(button => button.addEventListener('click', () => {
  const menu = document.querySelector('.more-menu');
  if (menu) menu.open = false;
}));
window.addEventListener('pagehide', () => {
  actions.pause();
  client.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    state.snapshot = state.previous = null;
    actions.resetHistory();
    actions.render();
    actions.compilerInfo(null);
    notice('请重新运行，恢复前的会话已清理。');
  }
});
setInterval(() => {
  if (state.liveSnapshot && !state.uncertain) {
    client.ping();
  }
}, 10000);
actions.setupCodeTheme();
actions.setupMotion();
actions.setupLayout();
new ResizeObserver(actions.syncEditorScroll).observe($('source').parentElement);
actions.controls();
await actions.setupExamples();
await actions.connect();
document.documentElement.dataset.ready = 'true';
