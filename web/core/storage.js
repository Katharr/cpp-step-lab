// 存储不可用时仍允许本页运行，调用者自行决定是否显示恢复提示。
export function readText(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
