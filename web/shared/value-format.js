const stateText = {
  uninitialized: '未赋值',
  unavailable: '待确认',
  read_error: '读取失败',
  out_of_scope: '已离开作用域'
};
export function createValueFormat({
  state
}) {
  function valueText(variable) {
    if (!variable) return '—';
    return variable.state === 'ok' && variable.value !== null ? String(variable.value) : stateText[valueState(variable)] || '值不可获取';
  }
  function valueState(variable) {
    return variable.state === 'unavailable' && variable.note?.startsWith('读取失败') ? 'read_error' : variable.state;
  }
  function becameKnown(value, before) {
    return state.snapshot?.runId === state.previous?.runId && state.snapshot.step > state.previous.step && value.state === 'ok' && value.value != null && before?.state !== 'ok';
  }
  return {
    valueText,
    valueState,
    becameKnown
  };
}
