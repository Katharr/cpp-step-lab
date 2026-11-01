import { $, node } from "../../shared/dom.js";
export function createVariables({
  state,
  actions
}) {
  function variables(target, items, emptyText) {
    const fragment = document.createDocumentFragment();
    const expanded = new Set([...$(target).querySelectorAll('tr:has(.variable-details[open])')].map(row => row.dataset.variableId));
    const old = new Map((state.previous?.variables || []).map(v => [v.id, v]));
    // 数组只保留定位入口，放在本分组末尾；普通变量维持快照顺序。
    for (const variable of [...items.filter(item => !item.data), ...items.filter(item => item.data)]) {
      const row = document.createElement('tr');
      row.dataset.variable = variable.name;
      row.dataset.variableId = variable.id;
      const prior = old.get(variable.id);
      const displayValue = variable.data && variable.state === 'ok' && Number.isInteger(variable.data.total) ? `${variable.data.total} 项` : actions.valueText(variable);
      const highlighted = variable.changed || actions.becameKnown(variable, prior);
      if (highlighted) row.className = 'changed';
      const name = document.createElement('td');
      name.textContent = variable.name;
      name.title = variable.type || '';
      const type = document.createElement('span');
      type.className = 'variable-type';
      type.textContent = variable.type;
      name.append(type);
      const current = document.createElement('td');
      current.className = 'value-cell';
      const value = document.createElement('span');
      value.className = 'current-value';
      value.dataset.valueState = actions.valueState(variable);
      value.textContent = actions.valueText(variable);
      if (variable.data) {
        const button = node('button', `${displayValue} · 查看`, 'structure-link');
        button.type = 'button';
        button.setAttribute('aria-label', `查看 ${variable.name} 的数组或容器`);
        button.addEventListener('click', () => {
          state.dataFrame = variable.kind === 'global' ? null : state.snapshot?.frames?.find(frame => frame.user && frame.level === variable.frame)?.id || null;
          actions.renderData();
          actions.controls();
          const card = [...$('data-views').querySelectorAll('.data-card')].find(item => item.dataset.variableId === variable.id);
          if (!card) return;
          card.open = true;
          card.scrollIntoView({
            block: 'nearest',
            inline: 'nearest'
          });
          card.querySelector('summary').focus({
            preventScroll: true
          });
        });
        value.replaceChildren(button);
      }
      current.append(value);
      current.title = [actions.valueText(variable), variable.note, variable.format?.note].filter(Boolean).join('\n');
      if (variable.note) {
        const note = document.createElement('span');
        note.className = 'variable-note';
        note.textContent = ' ⓘ';
        note.title = variable.note;
        note.tabIndex = 0;
        note.setAttribute('aria-label', variable.note);
        current.append(note);
      }
      const before = document.createElement('td');
      before.className = 'previous-value';
      before.textContent = actions.valueText(old.get(variable.id));
      const footer = node('div', undefined, 'variable-footer');
      if (highlighted && prior && ['ok', 'unavailable', 'uninitialized'].includes(prior.state) && !(variable.data && prior.state === 'ok' && prior.data?.total === variable.data.total)) {
        const change = document.createElement('span');
        change.className = 'value-before';
        change.textContent = (prior.data && prior.state === 'ok' ? `${prior.data.total} 项` : before.textContent) + ' → ';
        const detail = node('div', undefined, 'variable-change');
        detail.append(node('span', '◆ ', 'change-marker'), change, document.createTextNode(displayValue));
        footer.append(detail);
      }
      if (!variable.data) {
        footer.append(node('div', undefined, 'variable-binding'));
      }
      if (footer.childElementCount) current.append(footer);
      if (!variable.data) {
        if (actions.valueText(variable).length > 22) {
          const details = node('details', undefined, 'variable-details');
          details.open = expanded.has(variable.id);
          details.append(node('summary', '完整值'), node('pre', actions.valueText(variable)));
          current.append(details);
        }
      }
      row.append(name, current, before);
      fragment.append(row);
    }
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty';
      cell.textContent = emptyText;
      row.append(cell);
      fragment.append(row);
    }
    $(target).replaceChildren(fragment);
  }
  return {
    variables
  };
}
