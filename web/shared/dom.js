export const $ = id => document.getElementById(id);
export function notice(message = '') {
  ($('notice-message') || $('notice')).textContent = message;
  $('notice').hidden = !message;
}
export function noticeText() {
  return $('notice').hidden ? '' : $('notice').textContent;
}
export function copy(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
export function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
