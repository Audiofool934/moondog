export const NETEASE_LOGIN_URL = "https://music.163.com/#/login";
export function isNeteaseLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "music.163.com" || url.hostname.endsWith(".music.163.com"));
  } catch { return false; }
}

/** Remote content gets neither a preload nor access to Node or the application. */
export function openNeteaseLogin({ BrowserWindow, parent, signal }) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const login = new BrowserWindow({ parent, modal: Boolean(parent), width: 1080, height: 760, show: false,
      title: "登录网易云音乐", autoHideMenuBar: true,
      webPreferences: { partition: `netease-login-${Date.now()}`, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const storage = login.webContents.session;
    const cookies = storage.cookies;
    let settled = false;
    const timeout = setTimeout(() => finish(null), 5 * 60_000);
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cookies.removeListener("changed", changed);
      signal?.removeEventListener("abort", cancelled);
      if (!login.isDestroyed()) login.destroy();
      void storage.clearStorageData().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const cancelled = () => finish(null);
    function changed(_event, cookie, _cause, removed) {
      if (!removed && cookie.name === "MUSIC_U" && cookie.value &&
        isNeteaseLoginUrl(`https://${cookie.domain.replace(/^\./u, "")}`)) finish(`MUSIC_U=${cookie.value}`);
    }
    cookies.on("changed", changed);
    signal?.addEventListener("abort", cancelled, { once: true });
    login.webContents.setWindowOpenHandler(({ url }) => {
      if (isNeteaseLoginUrl(url)) void login.loadURL(url).catch(() => finish(null, new Error("网易云登录页加载失败，请重试。")));
      return { action: "deny" };
    });
    login.webContents.on("will-navigate", (event, url) => { if (!isNeteaseLoginUrl(url)) event.preventDefault(); });
    login.webContents.on("will-redirect", (event, url) => { if (!isNeteaseLoginUrl(url)) event.preventDefault(); });
    login.on("closed", cancelled);
    login.once("ready-to-show", () => { if (!settled) login.show(); });
    void login.loadURL(NETEASE_LOGIN_URL).catch(() => finish(null, new Error("网易云登录页加载失败，请检查网络后重试。")));
  });
}
