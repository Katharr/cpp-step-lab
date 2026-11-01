import { $ } from "../shared/dom.js";
import * as CodeSyntax from '../features/editor/syntax.js';
import { readText, writeText } from '../core/storage.js';
const CODE_THEME_STORAGE_KEY = 'code-lab:code-theme:v1';
export function createTheme({
  actions
}) {
  function applyCodeTheme(value, save = false) {
    const theme = ['light', 'dark', 'dracula'].includes(value) ? value : 'light';
    $('code-theme').value = theme;
    document.documentElement.dataset.codeTheme = theme;
    if (save) {
      try {
        writeText(CODE_THEME_STORAGE_KEY, theme);
      } catch {/* 当前页仍生效。 */}
    }
  }
  function setupCodeTheme() {
    let value = 'light';
    try {
      value = readText(CODE_THEME_STORAGE_KEY) || value;
    } catch {/* 使用课堂浅色默认。 */}
    applyCodeTheme(value);
    document.documentElement.classList.toggle('syntax-ready', Boolean(CodeSyntax.highlight));
    $('code-theme').addEventListener('change', () => applyCodeTheme($('code-theme').value, true));
    new ResizeObserver(actions.syncEditorScroll).observe($('source'));
  }
  return {
    applyCodeTheme,
    setupCodeTheme
  };
}
