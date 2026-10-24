# 网易云本地功能验证

验证环境：Windows x64、Node.js 25.8.0、Electron 44.7.0，2026-10-24。上游基线为 `e17fc84`。

## 已验证

- 根目录及 `app/` 依赖已安装；`npm --prefix app run build` 成功。
- 44 项定向测试全部通过：账号验证、本地会话保存和恢复、退出清理、分页歌单、空歌单、1,204 首歌单元数据补全及原始顺序、不可用曲目、私密歌单导入及去重、凭据隔离、登录取消、迟到请求隔离、桌面预览和确认导入、终端补全、现有网易云播放器。
- 实际 Electron 窗口以虚构账号验证：创建/收藏筛选、搜索及无结果状态、205 首曲目按 100 首分页、导入前预览、退出后清空列表。
- 实际非模拟桌面窗口能打开 `https://music.163.com/#/login`，显示网易云官方扫码登录页；关闭窗口可返回应用。检查确认该远程窗口关闭 Node 集成、启用上下文隔离和沙箱，没有应用 preload。
- 未登录真实账号。真实账号认证以及账号权限下的歌单读取，需要使用者扫码后确认。

## 全量测试的 Windows 限制

本次全量检查：1,328 项中 1,175 通过、147 失败、6 跳过。独立上游原版对照：1,318 项中 1,164 通过、148 失败、6 跳过。比较失败名称后，本地改动没有新增失败项；上游有一项 XML 解析测试在本地轮次中通过。

上游失败包括 Windows 上打开的 SQLite 文件清理顺序、Unix 系统命令及终端播放器假设。未将全量测试报告为通过，也未把这些问题扩展为本次网易云功能的改写范围。自动化检查从未使用真实网易云会话或修改既有音乐库。

复现定向检查：

```text
node --test tests/runtime/netease-library.test.mjs tests/runtime/netease-login-window.test.mjs tests/runtime/app-window-room.test.mjs tests/runtime/netease-player.test.mjs tests/runtime/command-completions.test.mjs tests/runtime/app-window-strings.test.mjs
npm --prefix app run build
```

本机截图和完整日志位于被 Git 忽略的 `outputs/netease/`；它们包含虚构音乐数据和公开登录页，没有真实登录凭据。

## 使用范围

双击根目录 `start-moondog.cmd`，进入“设置 → 网易云音乐”，点击“登录网易云”，在官方窗口扫码。连接后可浏览和导入歌单。

后续内置播放和自定义 API 已接入，当前桌面版本无需 `ncm-cli` 即可播放歌单。新增能力及验证结果见 [内置播放与自定义 API](PLAYBACK_AND_CUSTOM_API.md)。上述 44 项与原版对照数字保留为首轮账号/歌单改动记录。
