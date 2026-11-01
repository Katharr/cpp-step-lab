import { $, notice, copy } from "../../shared/dom.js";
const HISTORY_LIMIT = 2000;
const OUTPUT_LIMIT = 1024 * 1024;
export function createHistory({
  state,
  actions
}) {
  function outputWithinLimit(value) {
    const result = {
      stdout: value?.stdout || '',
      stderr: value?.stderr || ''
    };
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
    state.history = [];
    state.historyIndex = -1;
    state.liveSnapshot = null;
    state.historyLimitReached = false;
    updateHistoryControls();
  }
  function historyPosition() {
    return state.history.length ? `第 ${state.history[state.historyIndex].step} 步 / 共 ${state.history.at(-1).step} 步` : '尚未运行';
  }
  function updateHistoryControls() {
    const hasHistory = state.history.length > 0;
    const viewing = hasHistory && state.historyIndex < state.history.length - 1;
    $('history-count').textContent = historyPosition();
    $('history-slider').max = String(Math.max(0, state.history.length - 1));
    $('history-slider').value = String(Math.max(0, state.historyIndex));
    $('history-slider').disabled = !hasHistory || state.busy || state.stopping || state.playing;
    $('history-prev').disabled = !hasHistory || state.historyIndex <= 0 || state.busy || state.stopping || state.playing;
    $('history-next').disabled = !hasHistory || state.historyIndex >= state.history.length - 1 || state.busy || state.stopping || state.playing;
    $('history-latest').disabled = !viewing || state.busy || state.stopping || state.playing;
    $('history-state').textContent = viewing ? '正在回看历史' : '执行历史';
  }
  function selectHistory(index, message = '') {
    if (!state.history.length) return;
    state.historyIndex = Math.max(0, Math.min(state.history.length - 1, Number(index)));
    state.snapshot = state.history[state.historyIndex];
    state.previous = state.historyIndex > 0 ? state.history[state.historyIndex - 1] : null;
    actions.render();
    actions.compilerInfo(state.snapshot);
    updateHistoryControls();
    if (message) notice(message);
  }
  function returnToLatest() {
    if (!state.history.length || state.historyIndex === state.history.length - 1) return false;
    selectHistory(state.history.length - 1, '已回到最新状态，可以继续执行。');
    return true;
  }
  function remember(result) {
    if (!Number.isInteger(result?.step)) return;
    const normalized = copy(result);
    normalized.output = outputWithinLimit(normalized.output);
    if (state.liveSnapshot?.runId !== normalized.runId) {
      state.history = [];
      state.historyIndex = -1;
      state.historyLimitReached = false;
    }
    state.liveSnapshot = normalized;
    const same = state.history.findIndex(item => item.runId === normalized.runId && item.step === normalized.step);
    if (same >= 0) {
      normalized.outputDelta = state.history[same].outputDelta;
      normalized.inputTrace = state.history[same].inputTrace;
      state.history[same] = normalized;
      if (state.historyIndex === same || state.historyIndex >= state.history.length - 1) state.historyIndex = same;
    } else if (state.history.length < HISTORY_LIMIT) {
      state.history.push(normalized);
      state.historyIndex = state.history.length - 1;
    } else {
      state.historyLimitReached = true;
    }
    state.snapshot = state.historyIndex >= 0 ? state.history[state.historyIndex] : normalized;
    state.previous = state.historyIndex > 0 ? state.history[state.historyIndex - 1] : null;
    updateHistoryControls();
  }
  return {
    resetHistory,
    updateHistoryControls,
    selectHistory,
    returnToLatest,
    remember
  };
}
