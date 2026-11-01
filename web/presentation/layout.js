import { $ } from "../shared/dom.js";
import { defaultLayout } from '../core/state.js';
import { readText, writeText } from '../core/storage.js';
export function createLayout({
  state
}) {
  const LAYOUT_STORAGE_KEY = 'code-lab:layout:v1';
  function applyLayout(value, save = false) {
    const workspace = document.querySelector('.workspace');
    if (!workspace) return;
    const columns = Number(value.variableColumns) === 2 ? 2 : 1;
    state.layout = {
      codeWidth: Math.min(65, Math.max(35, Number(value.codeWidth) || defaultLayout.codeWidth)),
      stateHeight: Math.min(80, Math.max(40, Number(value.stateHeight) || defaultLayout.stateHeight)),
      variablesWidth: Math.min(420, Math.max(160, Number(value.variablesWidth) || (columns === 2 ? 280 : defaultLayout.variablesWidth))),
      variableColumns: columns
    };
    workspace.style.setProperty('--code-width', state.layout.codeWidth + '%');
    workspace.style.setProperty('--state-height', state.layout.stateHeight + '%');
    const stateWidth = document.querySelector('.state-grid').clientWidth;
    const minimum = columns === 2 && stateWidth >= 452 ? 244 : stateWidth < 380 ? 128 : 160;
    const maximum = Math.max(minimum, Math.min(420, stateWidth - 8 - (stateWidth < 500 ? 200 : 280)));
    const width = Math.min(maximum, Math.max(minimum, state.layout.variablesWidth));
    workspace.style.setProperty('--variables-width', width + 'px');
    workspace.dataset.variableColumns = columns === 2 && width >= 244 ? '2' : '1';
    $('variables-one').setAttribute('aria-pressed', String(columns === 1));
    $('variables-two').setAttribute('aria-pressed', String(columns === 2));
    $('variables-two').title = width < 244 ? '空间不足时暂以单列显示，加宽变量栏可恢复双列' : '每行显示两个变量';
    $('variables-splitter').setAttribute('aria-valuemin', String(minimum));
    $('variables-splitter').setAttribute('aria-valuemax', String(Math.floor(maximum)));
    $('variables-splitter').setAttribute('aria-valuenow', String(Math.round(width)));
    for (const [id, key] of [['code-splitter', 'codeWidth'], ['io-splitter', 'stateHeight']]) {
      $(id).setAttribute('aria-valuenow', String(Math.round(state.layout[key])));
    }
    if (save) {
      try {
        writeText(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout));
      } catch {/* 布局仍可使用 */}
    }
  }
  function setupLayout() {
    try {
      const saved = JSON.parse(readText(LAYOUT_STORAGE_KEY));
      // 旧课例的 variablesHeight 不再参与布局，已有代码和 I/O 比例仍可恢复。
      applyLayout(saved || state.layout);
    } catch {
      applyLayout(state.layout);
    }
    for (const [id, key, selector, vertical] of [['code-splitter', 'codeWidth', '.workspace', false], ['io-splitter', 'stateHeight', '.inspector', true], ['variables-splitter', 'variablesWidth', '.state-grid', false]]) {
      const handle = $(id);
      if (!handle) continue;
      let dragging = false;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging = true;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
      });
      handle.addEventListener('pointermove', event => {
        if (!dragging) return;
        const bounds = document.querySelector(selector).getBoundingClientRect();
        const position = vertical ? event.clientY - bounds.top : event.clientX - bounds.left;
        const length = vertical ? bounds.height : bounds.width;
        applyLayout({
          ...state.layout,
          [key]: key === 'variablesWidth' ? position - 4 : position / length * 100
        });
      });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        applyLayout(state.layout, true);
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
      handle.addEventListener('keydown', event => {
        const direction = vertical ? {
          ArrowUp: -1,
          ArrowDown: 1
        } : {
          ArrowLeft: -1,
          ArrowRight: 1
        };
        if (!(event.key in direction)) return;
        event.preventDefault();
        const distance = key === 'variablesWidth' ? event.shiftKey ? 40 : 8 : event.shiftKey ? 5 : 1;
        const current = key === 'variablesWidth' ? Number(handle.getAttribute('aria-valuenow')) : state.layout[key];
        applyLayout({
          ...state.layout,
          [key]: current + direction[event.key] * distance
        }, true);
      });
      handle.title = '拖动或方向键调整，双击恢复默认比例';
      handle.addEventListener('dblclick', () => applyLayout({
        ...state.layout,
        [key]: key === 'variablesWidth' && state.layout.variableColumns === 2 ? 280 : defaultLayout[key]
      }, true));
    }
    for (const [id, columns] of [['variables-one', 1], ['variables-two', 2]]) {
      $(id).addEventListener('click', () => applyLayout({
        ...state.layout,
        variableColumns: columns,
        variablesWidth: columns === 2 ? Math.max(280, state.layout.variablesWidth) : Math.min(220, state.layout.variablesWidth)
      }, true));
    }
    new ResizeObserver(() => applyLayout(state.layout)).observe(document.querySelector('.state-grid'));
  }
  return {
    applyLayout,
    setupLayout
  };
}
