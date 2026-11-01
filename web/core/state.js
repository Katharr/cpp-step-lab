// 页面只有一个运行与展示状态对象；模块通过传入的 state 更新，不复制快照状态。
export const defaultLayout = {
  codeWidth: 40,
  stateHeight: 76,
  variablesWidth: 200,
  variableColumns: 1
};
export function createState() {
  return {
    dataSettings: new Map(),
    dataFrame: null,
    snapshot: null,
    previous: null,
    busy: false,
    starting: false,
    stopping: false,
    playing: false,
    timer: null,
    revision: 0,
    uncertain: false,
    errorLines: [],
    history: [],
    historyIndex: -1,
    liveSnapshot: null,
    historyLimitReached: false,
    layout: {
      ...defaultLayout
    },
    presentationPresets: new Map(),
    restoredPresentations: new Set(),
    restoredPrefixWindows: new Set(),
    lessonLoading: true,
    editorRevision: 0
  };
}
