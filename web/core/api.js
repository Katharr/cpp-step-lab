import { $ } from '../shared/dom.js';
export function createApi() {
  const baseUrl = location.origin;
  const sessionId = crypto.randomUUID().replaceAll('-', '');
  async function request(path, data) {
    let response;
    try {
      response = await fetch(baseUrl + path, {
        method: data ? 'POST' : 'GET',
        headers: data ? {
          'Content-Type': 'application/json'
        } : {},
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(90000)
      });
    } catch {
      $('connection').textContent = '本地服务未连接';
      const error = new Error('无法连接本地服务。请双击“代码实验台/start.bat”，保持启动窗口开启，再点击“重新连接”。');
      error.disconnected = true;
      throw error;
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('本地服务返回格式异常，请检查服务窗口后重新运行。');
    }
    $('connection').textContent = '本地服务已连接';
    if (!response.ok) throw new Error(result.error || '本地服务拒绝了此次操作，请稍后重试。');
    return result;
  }
  function close() {
    navigator.sendBeacon(baseUrl + '/api/close', new Blob([JSON.stringify({
      sessionId
    })], {
      type: 'application/json'
    }));
  }
  function ping() {
    return fetch(baseUrl + '/api/ping', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId
      })
    }).catch(() => {});
  }
  return {
    baseUrl,
    sessionId,
    request,
    close,
    ping
  };
}
