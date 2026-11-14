import { node } from '../../shared/dom.js';

const layouts = new Map();
const resizeObserver = new ResizeObserver(entries => {
  for (const { target } of entries) layouts.get(target)?.();
});
export function clearIndexLayouts() {
  resizeObserver.disconnect();
  layouts.clear();
}

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
  settings.manualIndices ||= [...(settings.axes || [])];
  settings.excludedIndices ||= [];
  settings.axes = [...new Set([...settings.manualIndices, ...(snapshot?.indexAssociations?.[variable.id] || [])])]
    .filter(id => id && !settings.excludedIndices.includes(id));
}
export function chooseIndex(settings, id, checked) {
  settings.manualIndices = (settings.manualIndices || []).filter(value => value !== id);
  settings.excludedIndices = (settings.excludedIndices || []).filter(value => value !== id);
  if (checked) settings.manualIndices.push(id);
  else settings.excludedIndices.push(id);
}
export function indexChoices(settings, candidates, rerender) {
  const controls = node('details', undefined, 'multi-index-controls');
  controls.open = Boolean(settings.indexOpen);
  controls.addEventListener('toggle', () => { if (controls.isConnected) settings.indexOpen = controls.open; });
  controls.append(node('summary', '下标标记'));
  controls.append(node('p', '自动跟随当前循环；手动勾选可固定显示。', 'data-note'));
  for (const item of candidates.filter(isIndexCandidate)) {
    const label = node('label');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = settings.axes.includes(item.id);
    const name = item.name + (item.kind === 'global' ? '（全局）' : '');
    input.setAttribute('aria-label', `关联下标 ${name}`);
    input.addEventListener('change', () => {
      chooseIndex(settings, item.id, input.checked);
      rerender();
    });
    label.append(input, document.createTextNode(name));
    if (input.checked && !settings.manualIndices.includes(item.id)) {
      const pin = node('button', '固定');
      pin.type = 'button';
      pin.setAttribute('aria-label', `固定下标 ${name}`);
      pin.addEventListener('click', () => { chooseIndex(settings, item.id, true); rerender(); });
      label.append(pin);
    }
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
    return { id, variable, value: variable?.state === 'ok' ? parse(variable.value) : null };
  });
}
export function drawMarkers(card, variable, markers, locate) {
  const grid = card.querySelector('.array-strip');
  const data = variable.data;
  const lower = BigInt(data.lowerBounds[0] || 0);
  const upper = lower + BigInt(data.total);
  const hints = node('div', undefined, 'index-hints');
  const leftHints = node('div', undefined, 'index-hints-left');
  const rightHints = node('div', undefined, 'index-hints-right');
  hints.append(leftHints, node('div', undefined, 'index-hints-unknown'), rightHints);
  card.querySelector('.data-content').insertBefore(hints, card.querySelector('.structure-scroll'));
  const cells = new Map([...grid.querySelectorAll('.element[data-coordinates]')].map(cell => [cell.dataset.coordinates, cell]));
  const targets = new Map();
  for (const marker of markers) {
    if (marker.value === null) continue;
    const position = String(marker.value);
    const name = marker.variable?.name || '下标变量';
    const color = indexColor(marker.variable);
    const cell = cells.get(position);
    if (cell) {
      if (!targets.has(position)) targets.set(position, { position, cell, members: [] });
      targets.get(position).members.push({ ...marker, name, color });
    } else {
      const outside = marker.value < lower || marker.value >= upper;
      const left = marker.value < BigInt(data.offset) + lower;
      const hint = node(outside ? 'span' : 'button', `${left ? '← ' : ''}${name}${outside ? ' · 越界' : ''}${left ? '' : ' →'}`);
      hint.style.color = color;
      hint.title = outside ? `${name} 超出数组范围` : `定位 ${name}`;
      if (!outside) {
        hint.type = 'button';
        hint.setAttribute('aria-label', `定位下标 ${name}`);
        hint.addEventListener('click', () => locate(Number(marker.value - lower)));
      }
      (left ? leftHints : rightHints).append(hint);
    }
  }
  grid.style.minWidth = '';
  const height = markers.length ? 34 : 0;
  grid.style.paddingTop = `${height + 4}px`;
  grid.classList.add('multi-index-grid');
  const layer = svg('svg', { class: 'index-marker-layer', width: grid.scrollWidth, height, 'aria-label': '数组下标位置' });
  grid.append(layer);
  const placed = [...targets.values()].map(target => {
    const group = svg('g', { 'data-index-id': target.members.map(member => member.id).join('|'),
      'data-position': target.position, class: 'index-pointer', color: target.members[0].color });
    const label = svg('text', { y: 13, 'text-anchor': 'middle' });
    target.members.forEach((member, index) => {
      if (index) label.append(svg('tspan', { fill: 'var(--muted)' }, ' · '));
      label.append(svg('tspan', { fill: member.color, 'data-index-id': member.id }, member.name));
    });
    group.append(label);
    group.setAttribute('aria-label', target.members.map(member => member.name).join('、') + '的当前位置');
    layer.append(group);
    return { ...target, group, label, size: Math.max(16, label.getComputedTextLength()) + 8 };
  });
  function layout() {
    if (!grid.getClientRects().length) return;
    for (const target of placed) target.size = Math.max(16, target.label.getComputedTextLength()) + 8;
    const required = placed.reduce((sum, target) => sum + target.size + 6, 0);
    grid.style.minWidth = '';
    layer.style.display = 'none';
    if (required > grid.scrollWidth) grid.style.minWidth = `${required}px`;
    const width = grid.scrollWidth;
    layer.setAttribute('width', width);
    layer.style.display = '';
    const bounds = grid.getBoundingClientRect();
    for (const target of placed) {
      const rect = target.cell.getBoundingClientRect();
      target.x = rect.left - bounds.left + rect.width / 2;
    }
    placed.sort((a, b) => a.x - b.x);
    let end = -6;
    for (const target of placed) {
      target.left = Math.max(end + 6, Math.min(width - target.size, target.x - target.size / 2));
      end = target.left + target.size;
    }
    let right = width;
    for (const target of [...placed].reverse()) {
      target.left = Math.min(target.left, right - target.size);
      right = target.left - 6;
    }
    for (const target of placed) {
      const center = target.left + target.size / 2;
      target.label.setAttribute('x', center);
      target.group.querySelector('path')?.remove();
      target.group.prepend(svg('path', { d: `M ${center} 18 L ${target.x} 31 m -3 -4 l 3 4 l 3 -4`,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.35, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
  }
  layout();
  const scroll = card.querySelector('.structure-scroll');
  layouts.set(scroll, layout);
  resizeObserver.observe(scroll);
}
