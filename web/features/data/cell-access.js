// 格子访问展示只消费快照中的 arrayAccess，不推测 C++ 执行路径。
let lastAccessViewKey = '';
async function revealWindows(result, loadWindow) {
  if (result.status !== 'paused') return result;
  const access = result.arrayAccess;
  if (!access) return result;
  for (const original of result.variables || []) {
    const variable = result.variables.find(item => item.id === original.id);
    const data = variable.data;
    if (!data || variable.state !== 'ok') continue;
    const writes = access.writes.filter(item => item.variableId === variable.id);
    const reads = access.reads.filter(item => item.variableId === variable.id);
    const uses = (access.uses || []).filter(item => item.variableId === variable.id);
    const targets = [...writes, ...reads, ...uses];
    if (!targets.length) continue;
    const loaded = new Set(data.elements.map(item => item.coordinates.join(',')));
    if (targets.every(item => loaded.has(item.coordinates.join(',')))) continue;
    const flatten = item => item.coordinates.reduce((index, value, axis) => index * data.shape[axis] + value - (data.lowerBounds[axis] || 0), 0);
    const indices = targets.map(flatten).filter(value => Number.isSafeInteger(value) && value >= 0 && value < data.total);
    if (!indices.length) continue;
    const first = indices[0]; // 源目标相距过远时，优先保证写入位置可见。
    const low = Math.min(...indices),
      high = Math.max(...indices);
    const limit = Math.min(200, Math.max(data.limit || 50, high - low < 200 ? high - low + 1 : 50));
    const offset = Math.max(0, Math.min(high - low < limit ? low - Math.floor((limit - high + low - 1) / 2) : first - Math.floor(limit / 2), Math.max(0, data.total - limit)));
    result = await loadWindow({
      runId: result.runId,
      variableId: variable.id,
      offset,
      limit
    });
  }
  return result;
}
function coordinates(access, variableId) {
  const accessCoordinates = items => new Set((items || []).filter(item => item.variableId === variableId).map(item => item.coordinates.join(',')));
  const reads = accessCoordinates(access?.reads);
  const writes = accessCoordinates(access?.writes);
  const uses = accessCoordinates(access?.uses);
  return {
    reads,
    writes,
    uses
  };
}
function mark(cell, coordinates, {
  reads,
  writes,
  uses
}) {
  const key = coordinates.join(',');
  const read = reads.has(key),
    write = writes.has(key);
  const used = uses.has(key) && !read && !write;
  if (used) cell.classList.add('access-use');
  if (read) cell.classList.add('access-read');
  if (write) cell.classList.add('access-write');
  if (read || write) cell.dataset.access = read && write ? 'read-write' : write ? 'write' : 'read';else if (used) cell.dataset.access = 'use';
  if (used) cell.title = [cell.title, '本步用作函数实参；函数内部读写未展开'].filter(Boolean).join('；');
}
function appendUseNote(summary, access) {
  if (access.uses.size) {
    const useNote = document.createElement('span');
    useNote.className = 'access-use-note';
    useNote.textContent = ' · 本步传入函数';
    useNote.title = '紫色格子：本步用作函数实参';
    summary.append(useNote);
  }
}
function focus(container, snapshot, dataSettings) {
  const accessKey = snapshot ? `${snapshot.runId}:${snapshot.step}` : '';
  if (accessKey !== lastAccessViewKey) {
    lastAccessViewKey = accessKey;
    for (const card of container.querySelectorAll('.data-card[open]')) {
      const scroll = card.querySelector('.structure-scroll');
      const cells = [...card.querySelectorAll('.access-write, .access-read, .access-use')];
      if (!cells.length) continue;
      const target = card.querySelector('.access-write') || cells[0];
      const bounds = scroll.getBoundingClientRect();
      const rects = cells.map(cell => cell.getBoundingClientRect());
      const left = Math.min(...rects.map(rect => rect.left)),
        right = Math.max(...rects.map(rect => rect.right));
      const rect = target.getBoundingClientRect();
      if (right - left <= scroll.clientWidth && (left < bounds.left || right > bounds.right)) scroll.scrollLeft += left - bounds.left - 8;else if (rect.left < bounds.left || rect.right > bounds.right) scroll.scrollLeft += rect.left - bounds.left - scroll.clientWidth / 2 + rect.width / 2;
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) scroll.scrollTop += rect.top - bounds.top;
      const settings = dataSettings.get(card.dataset.variableId);
      settings.scrollLeft = scroll.scrollLeft;
      settings.scrollTop = scroll.scrollTop;
    }
    const primary = container.querySelector('.access-write') || container.querySelector('.access-read') || container.querySelector('.access-use');
    if (primary?.closest('.data-card')?.open) {
      const body = primary.closest('.data-body');
      const bounds = body.getBoundingClientRect(),
        rect = primary.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) body.scrollTop += rect.top - bounds.top - body.clientHeight / 2 + rect.height / 2;
    }
  }
}
function animate(animateFeedback) {
  for (const cell of document.querySelectorAll('.element.access-read:not(.access-write), .element.access-use')) {
    animateFeedback(cell, [{
      opacity: .55
    }, {
      opacity: 1
    }], 140);
  }
  for (const cell of document.querySelectorAll('.element.access-write')) {
    animateFeedback(cell.querySelector('.element-value'), [{
      opacity: .35,
      transform: 'scale(.96)',
      offset: 0
    }, {
      opacity: .35,
      transform: 'scale(.96)',
      offset: .4
    }, {
      opacity: 1,
      transform: 'scale(1)'
    }], 280);
  }
}
function isMarked(cell) {
  return cell.matches('.access-read, .access-write, .access-use');
}
export { revealWindows, coordinates, mark, appendUseNote, focus, animate, isMarked };
