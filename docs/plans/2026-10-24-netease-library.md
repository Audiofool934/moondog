# NetEase account and library implementation plan

**Goal:** Sign in to NetEase Cloud Music locally, browse created and saved playlists and their complete track lists, and explicitly import a selected playlist into Moondog's existing listening profile.

**Architecture:** A shared NetEase library service owns the account cookie and calls only HTTPS music.163.com endpoints. An isolated Electron window opens the official login page. Only public account and music metadata reaches the renderer. Desktop settings and terminal commands share the service and the existing preview/commit import flow. Collection membership remains collection evidence, never invented listening history.

**Tech stack:** Existing Node ESM, Electron, native DOM settings sheet, Node test runner.

1. Preserve the upstream checkout and implement local credential persistence, account validation, paginated playlists and track metadata completion. Check network, expiry, empty library and cancellation behavior with fictional responses.
2. Add isolated official-site login with cleanup, navigation restrictions and a core/main bridge; add a standalone login entry for the terminal.
3. Wire the service into the shared room services and the existing import preview/commit pipeline. Add `/netease` and one-shot CLI commands.
4. Extend the existing monochrome desktop settings with an account connection, created/saved playlist filters, search, paged track details and explicit import. Keep playback via ncm-cli distinct from library sign-in.
5. Enable installation on Windows, install dependencies, build the desktop renderer, run focused tests and inspect the real desktop flow with fictional data. Document startup and actual verification limits.

Login choices considered: official-site window (chosen, matching NCM Sync); third-party API server (extra deployment and credential trust); cookie paste (poor primary experience). No account login or remote playlist writes happen during automated checks.
