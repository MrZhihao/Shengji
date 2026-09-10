/**
 * Service worker 注册与自动更新。
 * 新版本装好后（skipWaiting + clientsClaim 会立刻接管）自动刷新页面；
 * 每次回到前台、每次重连服务端都主动检查一次更新，不用等浏览器 24 小时的默认周期。
 */
let registration: ServiceWorkerRegistration | null = null;
let hadController = false;
let reloading = false;

export function setupPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 首次安装也会触发 controllerchange，那时没有旧版本，不用刷新
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((r) => {
      registration = r;
    }).catch(() => { /* 注册失败就当普通网页用 */ });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  });
}

/** 对比线上 index.html 里的脚本文件名，不一样就让 service worker 去更新 */
export async function checkForUpdate(): Promise<void> {
  try {
    const current = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? '';
    const res = await fetch(`/index.html?u=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/\/assets\/index-[\w-]+\.js/);
    if (m && current && !current.includes(m[0])) {
      if (registration) await registration.update();
      else if (!reloading) { reloading = true; window.location.reload(); }
    }
  } catch { /* 离线时忽略 */ }
}

export const buildTime: string = typeof __BUILD__ === 'string' ? __BUILD__ : '';
