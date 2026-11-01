import { $, notice, node } from "../../shared/dom.js";
import { readText, writeText } from '../../core/storage.js';
const CASE_VERSION = 1;
const CASE_STORAGE_KEY = 'code-lab:last-case:v1';
export function createLessons({
  state,
  actions,
  client
}) {
  let catalog = [];
  let loadRevision = 0;
  function cancelLessonLoad() {
    ++loadRevision;
    state.lessonLoading = false;
    actions.controls();
  }
  async function setupExamples() {
    const editorRevision = state.editorRevision;
    try {
      const index = await client.request('/课例/index.json');
      if (index?.version !== 1 || !Array.isArray(index.lessons) || !index.lessons.length) {
        throw new Error('内置课例索引格式不正确。');
      }
      catalog = index.lessons;
      if (catalog.some(lesson => !/^[a-z][a-z0-9-]*$/.test(lesson.id) || lesson.file !== `${lesson.id}.json` || typeof lesson.title !== 'string')) {
        throw new Error('内置课例索引包含无效条目。');
      }
      $('example').replaceChildren(...catalog.map(lesson => {
        const option = node('option', lesson.title);
        option.value = lesson.id;
        return option;
      }));
      if (editorRevision !== state.editorRevision) {
        state.lessonLoading = false;
        actions.render();
        return;
      }
      await loadExample();
    } catch (error) {
      state.lessonLoading = false;
      actions.render();
      notice(error.message || '内置课例无法载入，请检查服务后重新打开页面。');
    }
  }
  async function loadExample() {
    const lesson = catalog.find(item => item.id === $('example').value);
    if (!lesson) return;
    const version = ++loadRevision;
    const editorRevision = state.editorRevision;
    state.lessonLoading = true;
    actions.controls();
    try {
      const data = await client.request('/课例/' + lesson.file);
      if (version !== loadRevision || editorRevision !== state.editorRevision) return;
      applyCase(validateCase(data), {
        fromBuiltin: true
      });
      notice();
    } catch (error) {
      if (version === loadRevision) notice(error.message || '内置课例无法载入。');
    } finally {
      if (version === loadRevision) {
        state.lessonLoading = false;
        actions.controls();
      }
    }
  }
  function displaySettings() {
    return {
      standard: $('standard').value,
      codeTheme: $('code-theme').value,
      example: $('example').value,
      mode: $('editor').hidden ? 'view' : 'edit',
      layout: {
        ...state.layout
      },
      dataFrame: state.dataFrame,
      dataSettings: [...state.dataSettings.entries()].map(([id, value]) => ({
        id,
        open: Boolean(value.open),
        axes: [...(value.axes || [])],
        prefixLimit: value.prefixLimit,
        prefixApplied: Boolean(value.prefixApplied)
      }))
    };
  }
  function caseData() {
    return {
      version: CASE_VERSION,
      code: $('source').value,
      input: $('stdin').value,
      display: displaySettings()
    };
  }
  function downloadCase(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '代码实验台课例.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function saveCase() {
    const data = caseData();
    try {
      writeText(CASE_STORAGE_KEY, JSON.stringify(data));
    } catch {/* 下载仍可用 */}
    downloadCase(data);
    notice('课例已保存');
  }
  function validateCase(data) {
    if (!data || typeof data !== 'object' || data.version !== CASE_VERSION) {
      throw new Error(`课例版本不兼容：当前支持版本 ${CASE_VERSION}。`);
    }
    if (typeof data.code !== 'string' || typeof data.input !== 'string') throw new Error('课例缺少有效的代码或输入。');
    if (data.display && typeof data.display !== 'object') throw new Error('课例展示设置格式不正确。');
    return data;
  }
  function applyCase(data, {
    fromBuiltin = false
  } = {}) {
    validateCase(data);
    if (!fromBuiltin) cancelLessonLoad();
    ++state.editorRevision;
    $('source').value = data.code;
    $('stdin').value = data.input;
    const display = data.display || {};
    if (display.layout) actions.applyLayout(display.layout, true);
    if (['c++11', 'c++14'].includes(display.standard)) $('standard').value = display.standard;
    if (['light', 'dark', 'dracula'].includes(display.codeTheme)) actions.applyCodeTheme(display.codeTheme, true);
    if ([...$('example').options].some(option => option.value === display.example)) $('example').value = display.example;
    state.dataSettings.clear();
    state.presentationPresets.clear();
    state.restoredPresentations.clear();
    state.restoredPrefixWindows.clear();
    for (const item of display.dataSettings || []) {
      if (item && typeof item.id === 'string') {
        const prefixLimit = Number.isInteger(item.prefixLimit) && item.prefixLimit >= 1 && item.prefixLimit <= 200 ? item.prefixLimit : 50;
        state.dataSettings.set(item.id, {
          open: Boolean(item.open),
          axes: Array.isArray(item.axes) ? [...item.axes] : [],
          prefixLimit,
          prefixApplied: Boolean(item.prefixApplied)
        });
      }
    }
    state.dataFrame = typeof display.dataFrame === 'string' ? display.dataFrame : null;
    state.snapshot = state.previous = null;
    actions.resetHistory();
    state.uncertain = false;
    state.errorLines = [];
    actions.compilerInfo(null);
    actions.render();
    actions.mode(display.mode !== 'view');
    notice('课例已载入');
  }
  async function loadCaseFile(file) {
    if (!file) return;
    try {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('课例文件不是有效的 JSON。');
      }
      applyCase(data);
    } catch (error) {
      notice(error.message || '课例文件无法载入。');
    } finally {
      $('case-file').value = '';
    }
  }
  function restoreCase() {
    try {
      const raw = readText(CASE_STORAGE_KEY);
      if (!raw) {
        notice('本机还没有保存的课例。');
        return;
      }
      applyCase(JSON.parse(raw));
    } catch (error) {
      notice(error.message || '最近课例无法载入。');
    }
  }
  return {
    cancelLessonLoad,
    setupExamples,
    loadExample,
    saveCase,
    loadCaseFile,
    restoreCase
  };
}
