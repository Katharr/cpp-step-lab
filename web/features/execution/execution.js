import { $, notice } from "../../shared/dom.js";
import * as CellAccess from '../data/cell-access.js';
const statusText = {
  idle: '待运行',
  paused: '已暂停',
  completed: '运行结束',
  stopped: '已停止',
  compile_error: '编译失败',
  runtime_error: '运行异常',
  timeout: '执行超时',
  output_limit: '输出达到上限',
  step_limit: '步数达到上限',
  error: '调试失败'
};
export function createExecution({
  state,
  actions,
  client
}) {
  function controls() {
    const active = state.snapshot?.status === 'paused' && !state.uncertain;
    const atLatest = state.historyIndex < 0 || state.historyIndex === state.history.length - 1;
    const locked = state.busy || state.stopping || state.lessonLoading;
    $('start').disabled = locked || active;
    $('restart').disabled = locked || !state.snapshot;
    for (const id of ['next', 'step', 'over', 'play']) $(id).disabled = !active || locked || state.playing;
    $('pause').disabled = !state.playing;
    $('play').hidden = state.playing;
    $('pause').hidden = !state.playing;
    $('stop').disabled = !active || state.starting || state.stopping;
    for (const id of ['example', 'standard', 'edit']) $(id).disabled = active || locked || state.playing || state.historyIndex < state.history.length - 1;
    $('source').readOnly = active || locked;
    $('stdin').readOnly = active || locked;
    for (const id of ['save-case', 'load-case', 'restore-case']) $(id).disabled = state.lessonLoading;
    for (const control of document.querySelectorAll('.window-controls input, .window-controls button')) control.disabled = !active || !atLatest || locked || state.playing;
    $('reconnect').disabled = locked;
    if (state.starting) $('status').textContent = '正在编译与启动…';else if (state.stopping) $('status').textContent = '正在停止…';else if (state.playing) $('status').textContent = '正在播放';else if (state.historyIndex >= 0 && state.historyIndex < state.history.length - 1) $('status').textContent = '正在回看';else if (state.busy) $('status').textContent = '正在执行…';else if (state.uncertain) $('status').textContent = '连接中断';else $('status').textContent = statusText[state.snapshot?.status || 'idle'] || '操作未完成';
    $('status').dataset.state = !state.starting && !state.stopping && state.historyIndex >= 0 && state.historyIndex < state.history.length - 1 ? 'history' : state.uncertain || /error|timeout|limit/.test(state.snapshot?.status || '') ? 'error' : state.snapshot?.status || 'idle';
    actions.updateHistoryControls();
  }
  function terminalMessage(result) {
    switch (result.status) {
      case 'compile_error':
        return '编译失败';
      case 'runtime_error':
        {
          const reason = result.reason;
          return '程序运行异常，已停止。' + (reason?.['signal-name'] ? ` 信号：${reason['signal-name']}。` : '') + (reason?.['exit-code'] ? ` 退出码：${reason['exit-code']}。` : '') + '请检查代码后重新运行。';
        }
      case 'timeout':
        return '当前执行超过时限，已停止。请检查死循环或输入数据后重新运行。';
      case 'output_limit':
        return '程序输出达到 1 MB 上限，已停止。请减少输出后重新运行。';
      case 'step_limit':
        return '已达到 2000 步上限，请缩小样例后重新运行。';
      case 'error':
        return '调试失败，请检查本机 GCC/GDB 环境后重新运行。' + (typeof result.error === 'string' ? '\n' + result.error : '');
      default:
        return '';
    }
  }
  async function receive(result) {
    if (!Number.isInteger(result.step)) {
      if (result.status === 'stale' || result.status === 'invalid_state') state.uncertain = true;
      pause();
      notice(result.status === 'command_error' ? '此处无法执行该操作，请使用“下一步”或“跳过函数”。' : result.error || '操作未完成，请重新运行。');
      return;
    }
    const wasViewing = state.history.length && state.historyIndex < state.history.length - 1;
    const receivedRevision = state.revision;
    let restoreError = null;
    try {
      result = await actions.restorePresentation(result);
      result = await CellAccess.revealWindows(result, options => client.request('/api/window', {
        sessionId: client.sessionId,
        ...options
      }));
    } catch (error) {
      restoreError = error;
    }
    if (receivedRevision !== state.revision) return;
    actions.remember(result);
    state.uncertain = Boolean(restoreError?.disconnected);
    if (result.status !== 'paused') pause();
    actions.mode(false);
    actions.render({
      animate: true
    });
    actions.compilerInfo(result);
    notice(terminalMessage(result) || (restoreError ? '本步已执行，展示设置未能恢复。' + restoreError.message : wasViewing ? '已回到最新状态。' : ''));
  }
  async function connect() {
    try {
      await client.request('/api/health');
      if (!state.snapshot) notice();else if (state.uncertain) notice('本地服务已连接，请点击“重新运行”开始新的运行。');
    } catch (error) {
      notice(error.message);
    }
  }
  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    state.timer = null;
    controls();
  }
  async function start() {
    if (state.busy || state.stopping || state.lessonLoading) return;
    pause();
    state.presentationPresets = new Map([...state.presentationPresets, ...[...state.dataSettings].map(([id, setting]) => [actions.presentationKey(id), {
      ...setting,
      axes: [...(setting.axes || [])]
    }])]);
    state.restoredPresentations.clear();
    state.restoredPrefixWindows.clear();
    const version = ++state.revision;
    state.busy = state.starting = true;
    state.snapshot = state.previous = null;
    actions.resetHistory();
    state.dataSettings.clear();
    state.dataFrame = null;
    state.errorLines = [];
    state.uncertain = false;
    notice();
    actions.render();
    actions.compilerInfo(null);
    actions.mode(false);
    try {
      const result = await client.request('/api/start', {
        sessionId: client.sessionId,
        source: $('source').value,
        input: $('stdin').value,
        standard: $('standard').value
      });
      if (version === state.revision) await receive(result);
    } catch (error) {
      notice(error.message);
      if (error.disconnected) state.uncertain = true;
    } finally {
      state.busy = state.starting = false;
      controls();
    }
  }
  async function command(commandName) {
    if (state.busy || state.stopping || state.uncertain) return;
    actions.returnToLatest();
    if (state.snapshot?.status !== 'paused') return;
    state.busy = true;
    const version = state.revision;
    const runId = state.snapshot.runId;
    controls();
    notice();
    try {
      const result = await client.request('/api/command', {
        sessionId: client.sessionId,
        runId,
        command: commandName
      });
      if (version === state.revision && state.snapshot?.runId === runId) await receive(result);
    } catch (error) {
      if (version === state.revision) {
        pause();
        state.uncertain = true; // 请求结果未知，重跑前不再推进旧状态。
        notice(error.message);
      }
    } finally {
      state.busy = false;
      controls();
      if (state.playing && version === state.revision && state.snapshot?.status === 'paused') state.timer = setTimeout(() => command('next'), Number($('speed').value));
    }
  }
  async function stop() {
    if (state.starting || state.stopping || state.snapshot?.status !== 'paused') return;
    actions.returnToLatest();
    if (state.snapshot?.status !== 'paused') return;
    pause();
    ++state.revision; // 正在返回的旧单步不能覆盖停止结果。
    state.stopping = true;
    controls();
    try {
      await receive(await client.request('/api/command', {
        sessionId: client.sessionId,
        runId: state.snapshot.runId,
        command: 'stop'
      }));
    } catch (error) {
      state.uncertain = true;
      notice(error.message);
    } finally {
      state.stopping = false;
      controls();
    }
  }
  return {
    controls,
    connect,
    pause,
    start,
    command,
    stop
  };
}
