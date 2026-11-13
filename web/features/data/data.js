import { $, notice, node } from "../../shared/dom.js";
import * as CellAccess from './cell-access.js';
export function createData({
  state,
  actions,
  client
}) {
  function presentationKey(id) {
    // scope 中是 GDB 的运行地址，重新编译后会变化；展示偏好按调用实例与源码声明位置匹配。
    const parts = String(id).split(':');
    return parts.length >= 6 && /^(?:global|f\d+)$/.test(parts[1]) ? [parts[1], parts.at(-2), parts.at(-1)].join(':') : String(id);
  }
  async function restorePresentation(result) {
    for (const variable of result.variables || []) {
      if (!variable.data) continue;
      const preset = state.presentationPresets.get(presentationKey(variable.id));
      if (!preset) continue;
      if (!state.restoredPresentations.has(variable.id)) {
        const axes = (preset.axes || []).map(id => (result.variables || []).find(item => presentationKey(item.id) === presentationKey(id))?.id || id);
        state.dataSettings.set(variable.id, {
          ...preset,
          axes,
          scrollLeft: 0,
          scrollTop: 0
        });
        state.restoredPresentations.add(variable.id);
      }
      const settings = state.dataSettings.get(variable.id);
      // for 下标可能晚于数组声明，保留待关联标识，出现时再映射至本次运行。
      // 从当前设置出发，避免覆盖老师后来手动取消或更换的关联。
      settings.axes = (settings.axes || []).map(id => id ? (result.variables || []).find(item => presentationKey(item.id) === presentationKey(id))?.id || id : '');
      if (preset.prefixApplied && variable.data.state === 'ok' && result.status === 'paused' && !state.restoredPrefixWindows.has(variable.id)) {
        if (variable.data.offset !== 0 || variable.data.limit !== preset.prefixLimit) {
          result = await client.request('/api/window', {
            sessionId: client.sessionId,
            runId: result.runId,
            variableId: variable.id,
            offset: 0,
            limit: preset.prefixLimit
          });
        }
        state.restoredPrefixWindows.add(variable.id);
      }
    }
    return result;
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
      const settings = state.dataSettings.get(card.dataset.variableId);
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
    const frames = (state.snapshot?.frames || []).filter(frame => frame.user);
    if (!frames.some(frame => frame.id === state.dataFrame)) state.dataFrame = null;
    const follow = node('option', '跟随当前调用帧');
    follow.value = '';
    $('data-frame').replaceChildren(follow, ...frames.map(frame => {
      const option = node('option', `${frame.level === 0 ? '当前 · ' : ''}${frame.function} · 第 ${frame.level + 1} 层`);
      option.value = frame.id;
      return option;
    }));
    $('data-frame').value = state.dataFrame || '';
    const selected = state.dataFrame ? frames.find(frame => frame.id === state.dataFrame) : frames[0];
    const items = (state.snapshot?.variables || []).filter(v => v.state !== 'out_of_scope');
    const local = items.filter(v => v.kind !== 'global' && v.frame === selected?.level && !v.shadowed);
    const global = items.filter(v => v.kind === 'global');
    $('frame-variables').hidden = !selected || selected.level === 0;
    document.querySelector('.locals-section').hidden = Boolean(selected?.level > 0);
    $('frame').textContent = selected?.function || '—';
    $('frame').title = selected ? `${selected.function} · 第 ${selected.level + 1} 层` : '';
    actions.variables('frame-locals', selected?.level > 0 ? local : [], '此帧暂无可见变量');
    const views = [...local, ...global].filter(v => v.data);
    container.replaceChildren(...views.map(variable => dataView(variable, variable.kind === 'global' ? global : [...local, ...global])));
    for (const row of document.querySelectorAll('.variables-body [data-variable-id]')) {
      const binding = row.querySelector('.variable-binding');
      if (!binding) continue;
      const labels = [];
      for (const variable of views) {
        const axes = state.dataSettings.get(variable.id)?.axes || [];
        axes.forEach((id, axis) => {
          if (id !== row.dataset.variableId) return;
          const value = items.find(item => item.id === id);
          labels.push(variable.data.kind === 'matrix' ? `${variable.name} · ${axis === 0 ? '行' : '列'}下标` : `下标 · ${variable.name}[${actions.valueText(value)}]`);
        });
      }
      binding.textContent = labels.join(' · ');
      binding.title = binding.textContent;
    }
    if (!views.length) container.append(node('p', '—', 'empty'));
    for (const card of container.querySelectorAll('.data-card')) {
      const settings = state.dataSettings.get(card.dataset.variableId);
      const scroll = card.querySelector('.structure-scroll');
      scroll.scrollLeft = settings.scrollLeft || 0;
      scroll.scrollTop = settings.scrollTop || 0;
      if (focus?.id === card.dataset.variableId) {
        const control = card.querySelectorAll('summary, input, select, button')[focus.control];
        if (control) {
          if (focus.draft !== null) control.value = focus.draft;
          control.focus({
            preventScroll: true
          });
        }
      }
    }
    container.scrollTop = containerTop;
    container.scrollLeft = containerLeft;
    CellAccess.focus(container, state.snapshot, state.dataSettings);
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
    const settings = state.dataSettings.get(variable.id) || {
      open: true,
      axes: []
    };
    if (!Number.isInteger(settings.prefixLimit) || settings.prefixLimit < 1 || settings.prefixLimit > 200) {
      settings.prefixLimit = Number.isInteger(data.limit) && data.limit >= 1 && data.limit <= 200 ? data.limit : 50;
    }
    state.dataSettings.set(variable.id, settings);
    const card = node('details', undefined, 'data-card');
    card.viewSettings = settings;
    card.dataset.structure = variable.name;
    card.dataset.variableId = variable.id;
    card.dataset.kind = data.kind;
    card.open = settings.open;
    card.addEventListener('toggle', () => {
      if (card.isConnected) settings.open = card.open;
    });
    const shape = data.kind === 'matrix' ? `二维数组 · ${data.shape[0]} 行 × ${data.shape[1]} 列` : `${data.kind === 'vector' ? 'vector' : data.kind === 'string' ? '字符串' : '一维数组'} · 长度 ${data.total}`;
    const summary = node('summary', `${variable.name} · ${shape}${variable.kind === 'global' ? ' · 全局' : ''}`);
    const access = CellAccess.coordinates(state.snapshot?.arrayAccess, variable.id);
    CellAccess.appendUseNote(summary, access);
    card.append(summary);
    const content = node('div', undefined, 'data-content');
    card.append(content);
    if (data.note && data.kind !== 'string') content.append(node('p', data.note, 'data-note'));
    const windowControls = node('form', undefined, 'window-controls');
    const offset = node('input');
    offset.type = 'number';
    offset.min = '0';
    offset.max = String(Number.MAX_SAFE_INTEGER);
    offset.step = '1';
    offset.value = data.offset;
    offset.setAttribute('aria-label', variable.name + ' 窗口起点');
    const limit = node('input');
    limit.type = 'number';
    limit.min = '1';
    limit.max = '200';
    limit.step = '1';
    limit.value = data.limit;
    limit.setAttribute('aria-label', variable.name + ' 窗口大小');
    const label = (text, control) => {
      const result = node('label', text);
      result.append(control);
      return result;
    };
    const prefixControls = node('form', undefined, 'window-controls prefix-controls');
    const prefix = node('input');
    prefix.type = 'number';
    prefix.min = '1';
    prefix.max = '200';
    prefix.step = '1';
    prefix.value = settings.prefixLimit;
    prefix.dataset.prefixLimit = '';
    prefix.setAttribute('aria-label', variable.name + ' 展示前几个元素');
    const prefixApply = node('button', `展示前 ${settings.prefixLimit} 个`);
    prefixApply.type = 'submit';
    prefix.addEventListener('input', () => {
      const count = Number(prefix.value);
      if (Number.isInteger(count) && count >= 1 && count <= 200) {
        settings.prefixLimit = count;
        prefixApply.textContent = `展示前 ${count} 个`;
      }
    });
    prefixControls.append(label('展示前 ', prefix), node('span', '个元素'), prefixApply);
    prefixControls.addEventListener('submit', event => {
      event.preventDefault();
      changeWindow(variable.id, 0, Number(prefix.value), {
        prefix: true
      });
    });
    const apply = node('button', '应用窗口');
    apply.type = 'submit';
    windowControls.append(label('起点 ', offset), label('数量 ', limit), apply);
    for (const [text, start] of [['上一段', Math.max(0, data.offset - data.limit)], ['下一段', data.offset + data.limit]]) {
      const button = node('button', text);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (start < data.total) changeWindow(variable.id, start, data.limit);
      });
      windowControls.append(button);
    }
    windowControls.addEventListener('submit', event => {
      event.preventDefault();
      changeWindow(variable.id, Number(offset.value), Number(limit.value));
    });
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
        const option = node('option', text);
        option.value = value;
        display.append(option);
      }
      display.value = settings.characterMode || 'character';
      display.addEventListener('change', () => {
        settings.characterMode = display.value;
        renderData();
      });
      tools.append(display);
      if (data.note) {
        const hint = node('span', 'ⓘ', 'character-info');
        hint.title = data.note;
        hint.tabIndex = 0;
        hint.setAttribute('aria-label', data.note);
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
      const empty = node('option', '不关联');
      empty.value = '';
      select.append(empty);
      for (const item of candidates.filter(v => !v.data && /^(?:const )?(?:(?:unsigned |signed )?(?:int|short|long|long long)|size_t)(?: const)?$/.test(v.type))) {
        const option = node('option', `${item.name}${item.kind === 'global' ? '（全局）' : ''} = ${actions.valueText(item)}`);
        option.value = item.id;
        select.append(option);
      }
      if (settings.axes[axis] && !candidates.some(v => v.id === settings.axes[axis])) {
        const missing = node('option', '原下标变量已离开作用域');
        missing.value = settings.axes[axis];
        select.append(missing);
      }
      select.value = settings.axes[axis] || '';
      select.addEventListener('change', () => {
        settings.axes[axis] = select.value;
        renderData();
        actions.controls();
      });
      selectors.append(label(axes === 2 ? axis === 0 ? '行下标 ' : '列下标 ' : '下标 ', select));
      const chosen = candidates.find(v => v.id === settings.axes[axis]);
      values.push(chosen?.state === 'ok' && /^-?\d+$/.test(chosen.value || '') ? BigInt(chosen.value) : null);
    }
    tools.append(selectors);
    const outside = values.some((value, axis) => value !== null && (value < BigInt(data.lowerBounds[axis] || 0) || value >= BigInt((data.lowerBounds[axis] || 0) + (data.shape[axis] || 0))));
    const indicators = values.map((value, axis) => {
      const chosen = candidates.find(v => v.id === settings.axes[axis]);
      return `${axes === 2 ? axis === 0 ? '行' : '列' : '下标'}：${value === null ? settings.axes[axis] ? '值未确认或已离开作用域' : '未关联' : `${chosen?.name || ''} = ${value}`}`;
    });
    const marker = node('p', indicators.join('；') + (outside ? ' → 越界（范围外）' : ''), 'index-status' + (outside ? ' out-of-range' : ''));
    marker.hidden = !outside && values.every(value => value === null) && !settings.axes.some(Boolean);
    content.append(marker);
    const windowInfo = `共 ${data.total} 项 · 已隐藏 ${data.hidden}`;
    const info = node('p', windowInfo, 'window-info');
    tools.append(info);
    const scroll = node('div', undefined, 'structure-scroll');
    const grid = node('div', undefined, data.kind === 'matrix' ? 'element-grid matrix-grid' : 'element-grid array-strip');
    // 只为实际读取到的坐标生成行列，极宽矩阵也不会创建整行空格子。
    const columns = [...new Set(data.elements.map(element => element.coordinates.at(-1)))].sort((a, b) => a - b);
    const rows = [...new Set(data.elements.map(element => element.coordinates[0]))].sort((a, b) => a - b);
    const tracks = coordinates => coordinates.flatMap((value, index) => index && value > coordinates[index - 1] + 1 ? [null, value] : [value]);
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
        header.style.gridRow = rowTracks.indexOf(row) + 2;
        header.style.gridColumn = 1;
        grid.append(header);
      }
      const loaded = new Set(data.elements.map(element => element.coordinates.join(',')));
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
    const priorVariable = state.previous?.variables?.find(item => item.id === variable.id);
    const priorElements = new Map((priorVariable?.data?.elements || []).map(item => [item.coordinates.join(','), item]));
    for (const element of data.elements) {
      const prior = priorElements.get(element.coordinates.join(','));
      const confirmed = (prior || priorVariable?.state !== 'ok') && actions.becameKnown(element, prior);
      const cell = node('div', undefined, 'element' + (element.changed || element.added || confirmed ? ' changed' : '') + (element.state !== 'ok' ? ' unknown' : ''));
      if (isNumericArrayZero(variable, element)) cell.classList.add('zero-value');
      cell.dataset.index = element.index;
      cell.dataset.coordinates = element.coordinates.join(',');
      cell.dataset.variableId = variable.id;
      cell.dataset.value = element.value ?? '';
      cell.dataset.valueState = actions.valueState(element);
      const matches = values.some(value => value !== null) && !outside && values.every((value, axis) => value === null || value === BigInt(element.coordinates[axis]));
      if (matches) {
        cell.classList.add('indexed');
        cell.dataset.pointerLabel = values.map((value, axis) => value === null ? '' : `${candidates.find(v => v.id === settings.axes[axis])?.name || (axis ? '列' : '行')} = ${value}`).filter(Boolean).join('；');
        marked = true;
      }
      cell.append(node('span', element.coordinates.map(v => '[' + v + ']').join(''), 'element-index'), node('strong', actions.valueText(element), 'element-value'));
      if (data.kind === 'string' && element.state === 'ok') {
        const character = String(element.value ?? '').match(/^\s*([+-]?\d+)\s+('.*')$/s);
        if (character) {
          cell.querySelector('.element-value').textContent = settings.characterMode === 'code' ? character[1] : character[2];
          cell.title = `字符 ${character[2]} · 编码 ${character[1]}`;
        }
      }
      if (element.note) cell.title = element.note;
      if (element.state !== 'ok' && element.note?.startsWith('读取失败')) cell.querySelector('.element-value').textContent = '读取失败';
      if (element.added) cell.title = `本步新增；当前：${element.value}`;else if (element.changed) cell.title = `上一步：${element.previousValue}；当前：${element.value}`;else if (confirmed) cell.title = `${actions.valueText(prior)} → ${element.value}`;
      CellAccess.mark(cell, element.coordinates, access);
      if (data.kind === 'matrix') {
        cell.style.gridRow = rowTracks.indexOf(element.coordinates[0]) + 2;
        cell.style.gridColumn = columnTracks.indexOf(element.coordinates[1]) + 2;
      }
      rendered.push({
        element,
        cell
      });
    }
    // 折叠只依据本次实际读取的相邻元素，不推断窗口外的值，也不遮挡读写和下标。
    settings.expandedRuns ||= [];
    const foldable = ({
      element,
      cell
    }) => element.state === 'ok' && element.value !== null && element.value !== undefined && !cell.matches('.changed, .indexed') && !CellAccess.isMarked(cell);
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
        fold.type = 'button';
        fold.dataset.foldRange = `${first},${last}`;
        const description = `${expanded ? '收起' : '展开'} [${first}…${last}] 的 ${end - start - 2} 个相同值：${rendered[start].element.value}`;
        fold.title = description;
        fold.setAttribute('aria-label', description);
        fold.setAttribute('aria-expanded', String(expanded));
        fold.append(node('span', `[${first}…${last}]`, 'element-index'), node('span', '⋯', 'fold-symbol'));
        fold.addEventListener('click', () => {
          settings.expandedRuns = expanded ? settings.expandedRuns.filter(key => key !== runKey) : [...settings.expandedRuns, runKey];
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
    if (!outside && values.some(value => value !== null) && !marked && data.state === 'ok') marker.append(' → 位于当前窗口之外');
    scroll.append(grid);
    content.append(scroll);
    if (grid.querySelector('.indexed')) grid.classList.add('has-pointer');
    if (!data.elements.length) content.append(node('p', data.state === 'ok' ? '当前容器为空。' : data.note || '无法可靠读取元素。', 'empty'));
    return card;
  }
  async function changeWindow(variableId, offset, limit, {
    prefix = false
  } = {}) {
    if (state.busy || state.stopping || state.playing || !state.snapshot || state.uncertain) return;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      notice('窗口起点须为非负整数，数量须为 1–200。');
      return;
    }
    const historical = state.historyIndex < state.history.length - 1 || state.snapshot.status !== 'paused';
    if (historical) {
      const snapshot = structuredClone(state.snapshot);
      const variable = snapshot.variables.find(item => item.id === variableId);
      if (!variable?.data) return;
      const data = variable.data;
      const cache = snapshot.observations?.[variableId] || Object.fromEntries(data.elements.map(item => [item.coordinates.join(','), item]));
      data.offset = Math.min(offset, Math.max(0, data.total - 1));
      data.limit = limit;
      data.elements = [];
      for (let index = data.offset; index < Math.min(data.total, data.offset + limit); index++) {
        const coordinates = data.shape.length === 2
          ? [Math.floor(index / data.shape[1]) + (data.lowerBounds[0] || 0), index % data.shape[1] + (data.lowerBounds[1] || 0)]
          : [index + (data.lowerBounds[0] || 0)];
        data.elements.push(cache[coordinates.join(',')] || { index, coordinates, state: 'unavailable', value: null, note: '该暂停点未记录此元素', changed: false, previousValue: null });
      }
      data.hidden = data.total - data.elements.length;
      state.snapshot = snapshot;
      actions.render();
      return;
    }
    state.busy = true;
    const version = state.revision;
    const runId = state.snapshot.runId;
    actions.controls();
    try {
      const result = await client.request('/api/window', {
        sessionId: client.sessionId,
        runId,
        variableId,
        offset,
        limit
      });
      if (version === state.revision && result.runId === state.snapshot?.runId) {
        const currentSettings = state.dataSettings.get(variableId);
        if (currentSettings) currentSettings.prefixApplied = prefix;
        const settings = state.dataSettings.get(variableId);
        if (prefix && settings) {
          settings.prefixLimit = limit;
          // 应用“前 X 个”是明确定位操作；普通单步仍保留老师浏览位置。
          const card = [...$('data-views').querySelectorAll('.data-card')].find(item => item.dataset.variableId === variableId);
          const scroll = card?.querySelector('.structure-scroll');
          if (scroll) {
            scroll.scrollLeft = 0;
            scroll.scrollTop = 0;
          }
          settings.scrollLeft = settings.scrollTop = 0;
        }
        actions.remember(result);
        actions.render();
      }
    } catch (error) {
      if (version === state.revision) {
        notice(error.message);
        if (error.disconnected) state.uncertain = true;
      }
    } finally {
      state.busy = false;
      actions.controls();
    }
  }
  return {
    presentationKey,
    restorePresentation,
    renderData
  };
}
