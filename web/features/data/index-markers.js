import { node } from '../../shared/dom.js';

const palette = ['#007f83', '#8555c4', '#bd356d', '#336dc1', '#867000', '#a44b23', '#477c35'];
export function isIndexCandidate(variable) {
  const type = variable.type.replace(/\b(?:const|volatile)\b/g, '').trim().replace(/\s+/g, ' ');
  return !variable.data && /^(?:(?:unsigned|signed)(?: (?:int|char|short(?: int)?|long(?: long)?(?: int)?))?|int|char|short(?: int)?|long(?: long)?(?: int)?|(?:std::)?size_t|(?:std::)?ptrdiff_t)$/.test(type);
}
export function indexColor(variable) {
  const serial = variable?.indexColor || 0;
  return serial < palette.length ? palette[serial] : `hsl(${(serial * 137.508) % 360} 55% 42%)`;
}
export function mergeIndices(settings, snapshot, variable) {
  settings.excludedIndices ||= [];
  settings.axes = [...new Set([...(settings.axes || []), ...(snapshot?.indexAssociations?.[variable.id] || [])])]
    .filter(id => id && !settings.excludedIndices.includes(id));
}
export function indexChoices(settings, candidates, rerender) {
  const controls = node('details', undefined, 'multi-index-controls');
  controls.open = Boolean(settings.indexOpen);
  controls.addEventListener('toggle', () => { if (controls.isConnected) settings.indexOpen = controls.open; });
  controls.append(node('summary', '关联多个下标'));
  for (const item of candidates.filter(isIndexCandidate)) {
    const label = node('label');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = settings.axes.includes(item.id);
    input.setAttribute('aria-label', `关联下标 ${item.name}`);
    input.addEventListener('change', () => {
      settings.axes = settings.axes.filter(id => id !== item.id);
      settings.excludedIndices = settings.excludedIndices.filter(id => id !== item.id);
      if (input.checked) settings.axes.push(item.id);
      else settings.excludedIndices.push(item.id);
      rerender();
    });
    label.append(input, document.createTextNode(item.name));
    controls.append(label);
  }
  return controls;
}
const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}
export function markerValues(snapshot, settings) {
  settings.indexMetadata ||= {};
  return settings.axes.map(id => {
    const current = snapshot.variables.find(item => item.id === id);
    if (current) settings.indexMetadata[id] = { name: current.name, indexColor: current.indexColor };
    const variable = current || { ...settings.indexMetadata[id], state: 'out_of_scope' };
    const parse = value => /^-?\d+$/.test(value ?? '') ? BigInt(value) : null;
    return { id, variable, value: variable?.state === 'ok' ? parse(variable.value) : null,
      previous: parse(snapshot.indexPreviousValues?.[id]) };
  });
}
export function drawMarkers(card, variable, markers, locate) {
  const grid = card.querySelector('.array-strip');
  const data = variable.data;
  const lower = BigInt(data.lowerBounds[0] || 0);
  const upper = lower + BigInt(data.total);
  const hints = node('div', undefined, 'index-hints');
  const leftHints = node('div', undefined, 'index-hints-left');
  const unknownHints = node('div', undefined, 'index-hints-unknown');
  const rightHints = node('div', undefined, 'index-hints-right');
  hints.append(leftHints, unknownHints, rightHints);
  card.querySelector('.data-content').insertBefore(hints, card.querySelector('.structure-scroll'));
  const targets = [];
  for (const marker of markers) {
    const { value, previous, variable: item } = marker;
    const name = item?.name || '下标变量';
    const color = indexColor(item);
    if (value === null) {
      const hint = node('span', `${name}：${item?.state === 'uninitialized' ? '未赋值' : '值未确认或已离开作用域'}`);
      hint.style.color = color;
      unknownHints.append(hint);
    }
    for (const [position, ghost] of [[value, false], [previous, true]]) {
      if (position === null || ghost && (position === value || value === null)) continue;
      const cell = [...grid.querySelectorAll('.element[data-coordinates]')].find(cell => cell.dataset.coordinates === String(position));
      if (cell) targets.push({ ...marker, position, ghost, cell, color, name });
      else {
        const outside = position < lower || position >= upper;
        const left = position < BigInt(data.offset) + lower;
        const hint = node(!outside && !ghost ? 'button' : 'span', `${left ? '←' : '→'} ${name} = ${position} · ${outside ? '越界' : '窗口外'}${ghost ? '（上一步）' : ''}`, ghost ? 'index-ghost-hint' : '');
        hint.style.color = color;
        if (hint.tagName === 'BUTTON') {
          hint.type = 'button';
          hint.addEventListener('click', () => locate(Number(position - lower)));
        }
        (left ? leftHints : rightHints).append(hint);
      }
    }
  }
  // 所有标签在数组自己的滚动平面内排布；折叠后的实际格子坐标是唯一定位依据。
  const width = grid.scrollWidth;
  const lanes = [];
  const placed = targets.map(target => {
    const text = `${target.name} = ${target.position}${target.ghost ? ' · 前' : ''}`;
    const size = Math.min(width, Math.max(64, text.length * 8 + 16));
    const x = target.cell.offsetLeft - grid.offsetLeft + target.cell.offsetWidth / 2;
    return { ...target, text, size, x, left: Math.max(0, Math.min(width - size, x - size / 2)) };
  }).sort((a, b) => Number(a.ghost) - Number(b.ghost) || a.left - b.left);
  for (const target of placed) {
    let lane = lanes.findIndex(end => end + 8 <= target.left);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = target.left + target.size;
    target.y = lane * 29 + 3;
  }
  const height = lanes.length ? lanes.length * 29 + 22 : 0;
  grid.style.paddingTop = `${height + 4}px`;
  grid.classList.add('multi-index-grid');
  const layer = svg('svg', { class: 'index-marker-layer', width, height, 'aria-label': '数组下标位置' });
  for (const target of placed) {
    const group = svg('g', { 'data-index-id': target.id, 'data-position': target.position,
      class: target.ghost ? 'index-pointer index-ghost' : 'index-pointer', color: target.color });
    const center = target.left + target.size / 2;
    group.append(svg('path', { d: `M ${target.ghost ? target.x : center} ${target.ghost ? height - 16 : target.y + 23} L ${target.x} ${height - 3} m -4 -6 l 4 6 l 4 -6`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
      svg('rect', { x: target.left, y: target.y, width: target.size, height: 23, rx: 4, fill: 'var(--surface)', stroke: 'currentColor' }),
      svg('text', { x: center, y: target.y + 16, 'text-anchor': 'middle', fill: 'currentColor' }, target.text));
    layer.append(group);
  }
  grid.append(layer);
}
