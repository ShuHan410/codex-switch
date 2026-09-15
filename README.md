# codex-switch

終端機 Codex 訂閱帳號管理器，v0.3.1。需要 Linux、Node.js 22+、Codex CLI。
本機已用 Codex CLI 0.154.0 驗證。WebSocket 依賴固定為 `ws@8.21.3`。

## 開始使用

```sh
codex-switch list
codex-switch usage --all
codex-switch login second --device-auth
codex-switch usage --all
codex-switch use second
codex-switch run
```

`login` 呼叫官方 Codex 登入。依終端機提示開啟瀏覽器、登入你要新增的
ChatGPT 帳號並輸入 device code；也可以省略 `--device-auth` 使用一般瀏覽器登入。
成功後工具自動收錄帳號。不要把 token 貼到終端機或聊天中。

自動模式：啟動時選帳號，並在目前對話執行期間持續監測、切換：

```sh
codex-switch run --auto
codex-switch run --auto --min-remaining 15
codex-switch run --auto --min-remaining 10 --poll-interval 30
codex-switch status
codex-switch run --account second -- --no-alt-screen
codex-switch run -- resume --last
```

`--` 後的參數傳給原生 Codex。固定使用 OpenAI provider，
帳號/backend 改寫、`--profile`/`-p` 與登入指令不支援透過 `run`。
`use NAME` 直接切換原生 `auth.json`，同時設定後續 `codex-switch run`
的預設帳號；`run` 的 `--account` 和 `--auto`
只影響這次啟動及該次自動監測。直接執行 `codex` 使用原生 home 的登入，
`auto` 可以更新這份登入（如下）。

手動切換原生登入：

```sh
codex-switch use roman
codex  # 讀取剛切換好的原生登入
# 明確指定原生 home（預設 CODEX_HOME，未設定時 ~/.codex）
codex-switch use roman --codex-home "$HOME/.codex"
```

`use` 與 `auto` 共用憑證備份／保存／原子替換流程，不改設定或歷史紀錄。
選擇已啟用的同一身分時保留原生最新 token，不用帳號池的舊快照覆蓋。
手動 `use` 不查詢額度，也不保證儲存的授權仍有效；可先用 `usage NAME`
確認。原生尚未登入時也能套用帳號池登入；未收錄的原生帳號會先備份，
但不會自動加入帳號池。目標必須是獨立管理的帳號。

若 `auto` 正在執行，請先在 B 終端 Ctrl-C 停止，再執行 `use`，需要時
重新啟動 `auto`。兩者使用同一把原生 home 鎖；忙碌時拒絕覆寫。
`use` 不啟動或檢查既有 session，也不以 `/status` 顯示判斷是否成功。

## 原生 Codex：在另一個終端執行 auto

終端 A 照常執行 `codex`，終端 B 執行：

```sh
codex-switch auto
# 自訂門檻與間隔（預設值如下）
codex-switch auto --min-remaining 5 --poll-interval 30
```

`auto` 不啟動 Codex 對話。它立即查詢一次，之後每輪完成後等待 30 秒再查：

1. 讀取原生 home 的 `auth.json`，以帳號／workspace 身分比對帳號池，
   不使用 `list` 星號判斷目前原生帳號。此帳號必須先由 `login` 或新版
   `import` 加入為獨立管理的帳號；未收錄就不改登入檔。
2. 使用與 `usage` 相同的 App Server RPC 查額度，當次使用的是原生登入檔。
3. 任一已回傳視窗剩餘低於 5% 或已用盡時，查詢其他帳號，選擇最少剩餘
   額度最高且至少有 5% 的可用帳號；切換前再次確認。剛好 5% 不切。
4. 備份原生登入及目前帳號池憑證，將原生最新憑證存回原帳號的獨立 home，
   再原子替換原生 `auth.json`，並更新 `use` 所管理的預設選擇。
   不複製／覆蓋設定、歷史對話或其他帳號資料。

原生 home 預設為 `CODEX_HOME`，未設定時為 `~/.codex`。可明確指定：

```sh
codex-switch auto --codex-home "$HOME/.codex"
codex-switch status --auto
codex-switch auto --once  # 執行一輪後退出；低額度時仍會真的切換
```

在 B 終端按 Ctrl-C 停止監控，已切換的登入會保留。正常運行不印通知；
`status --auto` 顯示最後紀錄：`watching`、`switched`、`no-alternative`、
`unregistered`、`unknown`、`busy`、`changed`、`stopped` 或 `stale`。
沒有可用替代帳號、查詢失敗或偵測到登入檔在查詢期間改變，都不強制切換。

同一帳號池／同一原生 home 同時只允許一個監控器。備份位於
`~/.codex/account-pool/auto/backups/`，含完整憑證，目錄 700、檔案 600，
以內容摘要去重，不自動刪除。原生 home 的 `.codex-switch-auto.lock`
以及帳號池的 `auto/.lock` 適用下方強制終止後人工檢查鎖的規則。

**界線：**只支援檔案式 ChatGPT 登入。若使用 keyring、API key、其他
`CODEX_HOME` 或管理員 workspace 限制，修改這份檔案未必影響你的原生
Codex；工具不改這些設定，也不繞過限制。請使用 file 儲存模式。
一般 Codex 的登入／刷新不遵守本工具鎖，檢查與替換之間仍存在極短競爭
視窗；執行手動 login/logout 時建議先停止 `auto`。多份相同 refresh token
仍可能失效，需要重新登入。這不是新的 OAuth 授權。

`auto` **只保證依規則更新登入檔，不檢查既有 session 是否採用新帳號**，
不重啟、不恢復、不重送工作。它與下方 `run --auto` 是兩個不同模式；
一般原生 Codex 工作流請使用這一節的 `auto`。

## 第二版：對話中的自動切換

預設每 30 秒檢查正在使用的帳號；任一回傳額度視窗剩餘 **低於 10%**
（或已用盡）時，自動選擇仍達門檻的帳號。`--min-remaining` 可調整門檻，
`--poll-interval` 可設 5–3600 秒。沒有合適帳號時保留現況，不中斷／重送工作。
額度查詢失敗或不完整時不盲目切換，下次輪詢再查。

工具啟動一個私人 Unix socket 上的 Codex App Server，原生終端透過
`--remote` 連線。切換呼叫官方 `account/login/start` 的外部 token 模式，
更新同一服務的登入身分；保留終端程序和 thread，讓後續請求使用新帳號。
不會中斷、重播或重啟正在執行的 turn。已送出的請求仍可能使用原帳號。
此介面為 Codex 的 experimental 功能，升級 CLI 後應重跑協定測試。
目前已驗證真實 Codex 對本機模型服務的同 thread 切換；正式服務的串流／
持續連線與長時間 token 刷新尚未完成實測，不能保證額度用盡前一定切換。

各帳號的 refresh token 留在其原始獨立 home，由原生 Codex 刷新；
即時服務僅在記憶體接收 access token，**不把 A 的 auth.json 覆蓋到 B**。
目前使用的帳號會被鎖定；切換成功才釋放舊帳號。切換回應不明確時暫停
自動切換並保留鎖，避免誤判目前的登入身分。

不跳提醒；需要查看時執行 `codex-switch status`。可能狀態：
`watching`、`no-alternative`、`unknown`、`paused`、`stopped`、`stale`。
`status` 只讀最後的監測紀錄，不含 token。

請用新版 `codex-switch run --auto` 啟動要自動切換的對話；**無法中途接管
已由舊版或原生 codex 啟動的程序**。自動模式的對話集中存放於
`~/.codex/account-pool/live/codex-home/`，帳號切換不會改變這個目錄。
`codex-switch run --auto -- resume --last` 恢復的是自動模式的上一段對話；
手動模式的舊對話仍在各帳號 home，不會自動搬移。

每個帳號池同時只允許一個自動模式服務。手動模式可使用未被鎖定的帳號。
若同一 email 登記多個 workspace 身分，自動模式會排除這些項目，
因目前確認介面無法區分它們；仍可使用手動模式。
自動模式目前只支援互動式終端，非互動 `exec`／`review` 請使用手動模式。

## 本機安裝與資料

- 程式：`~/.codex/tools/codex-switch/`
- 指令：`~/.local/bin/codex-switch`，連結到程式的 `bin/codex-switch.mjs`
- 帳號池：`~/.codex/account-pool/`（目錄 700、資料檔 600）
- 新帳號：`~/.codex/account-pool/accounts/NAME/codex-home/`
- 自動模式：`~/.codex/account-pool/live/`（對話、socket、狀態紀錄）

你的 `.bashrc` 和 `.profile` 已包含 `~/.local/bin`，不需要再修改。
其他主機安裝時，先在程式目錄執行 `npm ci --ignore-scripts`，
再把 `bin/codex-switch.mjs` 的絕對路徑連結到 PATH 中即可。
程式目錄可獨立使用 Git 管理；帳號池位於程式目錄外，不會被納入版本控制。

`CODEX_SWITCH_HOME` 可指定另一個帳號池；`CODEX_SWITCH_CODEX` 可指定 Codex
執行檔。這兩項主要供測試或多套安裝使用。請勿把帳號池設在 Git repository 內。

## 登入與隔離

```sh
codex-switch import another --source-home /absolute/path/to/codex-home
codex-switch login second --device-auth  # 同一帳號重新登入
codex-switch doctor
```

只支援 `auth.json` 檔案式 ChatGPT 登入，沒有 API key 或 keyring 匯入。
`import NAME` 預設讀取目前 `CODEX_HOME`（未設定時為 `~/.codex`），
將現有登入複製到帳號池的獨立 home；不開啟瀏覽器、不修改來源登入。
後續來源改登入別的帳號，不會覆蓋已匯入的憑證。匯入後與 `login` 新增的
帳號一樣支援 `usage`、`run`、自動模式及 `login NAME` 重新授權。
匯入只驗證本機檔案，初始狀態為 `unchecked`；用 `usage NAME` 查詢有效性。
既有名稱或重複身分會被拒絕，不會覆蓋帳號池中的憑證。
同一 ChatGPT 身分與 workspace 不可重複登記。

複製的是當下的登入快照，不保證永久授權。來源與匯入帳號若同時刷新同一組
refresh token，仍可能使其中一份失效；匯入後建議改用 `codex-switch run`
操作該帳號。工具不會停止原本正在執行的 Codex；需要完全獨立的授權時，
使用 `codex-switch login NAME` 重新登入。撤銷／過期授權也需要重新登入。

所有登入會先在暫存目錄完成，成功且通過帳號檢查後才保存。
新帳號重新登入會確認是原來的身分後才替換憑證；
登入錯帳號時保留原憑證。**0.2.0 及更舊版本**透過 `import` 登記的帳號仍須在其原始 Codex home
用原生 `codex login` 重新登入，工具不會替它執行重新登入。
若在原始 home 改成另一個身分，工具會標示 `identity-changed` 並拒絕啟動；
請恢復原身分，或用獨立 `codex-switch login NEW_NAME` 新增帳號。
此版本不會自動搬移舊版的引用式匯入紀錄。

新帳號建立時複製 `config.toml` 和 `*.config.toml`，之後各自維護。
若某設定檔含有 workspace 綁定或自訂 backend，工具會提示並略過整份檔案，
讓新帳號使用預設設定，避免繼承另一帳號的綁定；原始檔案不受影響。
`AGENTS.md`、`skills/`、`rules/`、`agents/`、`prompts/` 連結到來源 home。
手動模式的對話、資料庫、記憶與憑證各自保存；
`resume --last` 只看到所選帳號 home 的對話。MCP/外掛的登入狀態不會自動搬移，
有需要時在新帳號環境另外設定。管理員要求仍由 Codex 執行。

## 額度與狀態

```sh
codex-switch usage second
codex-switch usage --all --json
codex-switch list --json
```

`usage` 透過本機 `codex app-server` 的官方 JSON-RPC 介面查詢；
沒有啟動模型 turn，也不透過解析 TUI 畫面或未公開 HTTP endpoint。
只顯示 quota window，用量百分比不是可精確換算的剩餘 token 數。

| 狀態 | 意義 |
| --- | --- |
| `unchecked` | 已保存登入，尚未查詢或剛重新登入 |
| `ready` | 成功查詢，所回傳額度視窗尚有餘額 |
| `limited` | 某一額度視窗已用盡或服務回報限制 |
| `needs-login` | 缺少登入，或服務明確表示需重新登入 |
| `unknown` | 網路、逾時、服務錯誤、缺少或無法確認的額度資料 |
| `busy` | 該帳號正在被本工具使用；只顯示舊快取 |
| `identity-changed` | 原始登入位置已變成不同帳號／workspace |

`list` 是快取快照，請看 `checked` 時間；最新資料使用 `usage`。
Access token 到期本身不代表登入失效：刷新由 Codex 管理。
查詢失敗時保留上次額度供參考，但不會採用它自動啟動。

自動選擇每次重新查詢所有帳號，排除未知、忙碌、限制與過期的查詢結果。
取所有回傳 bucket 的所有 quota window 中「最少剩餘百分比」，
選擇數值最高且至少剩下 10% 的帳號（可調整）。這是保守策略：
可能因某個與當次模型無關的 bucket 而排除帳號。
額度資料不足或所有帳號都不符合時，明確報錯，不退回未知帳號。

## 使用界線

- `run --auto` 監測隨該次終端啟動／結束；`auto` 則在 B 終端前景運行，
  直到 Ctrl-C。兩者都不安裝常駐系統服務。
- 不含提醒、工作重送、自動接續、shell 攔截、刪除帳號或搬移舊對話。
- 每帳號同時只允許一個本工具的 run/login/query，避免刷新與登入競爭。
  原生 `codex` 不受這個鎖限制。執行中查詢會回報 busy。
- 終端機 Ctrl-C 由原生 Codex 處理；若要從其他程序停止 wrapper，請送
  SIGTERM（會轉交子程序），不要只對 wrapper PID 送 SIGINT。
- 強制終止程式或主機故障可能留下 `.lock`。工具刻意不自動搶鎖。
  先檢查該目錄 `owner.json` 中的 host/PID，確認對應程序及其 Codex 子程序
  都已結束，才手動移除該鎖內的 `owner.json` 與空鎖目錄；不要刪帳號資料。
- 額度讀取有時間差，其他裝置也可能消耗同一帳號額度。

退出碼：0 成功；1 指令／操作錯誤；2 usage/doctor 有未驗證帳號；
3 帳號鎖忙碌。`run` 及互動登入傳回 Codex 的退出碼。

## 開發與驗證

```sh
cd ~/.codex/tools/codex-switch
npm test
node scripts/verify-live-protocol.mjs
# 可選：開啟假帳號的原生終端，不輸入 prompt，按 Ctrl-C 結束
node scripts/verify-live-protocol.mjs --ui-smoke
node --check src/core.mjs
node --check src/main.mjs
node --check src/live.mjs
```

離線測試只使用暫存目錄與假憑證，不接觸真實帳號池。
協定測試使用實際安裝的 Codex、假帳號與 localhost 模型回應，
驗證同一個 thread 的下一次請求從 alpha 換成 beta，不消耗真實模型額度。

官方依據（查核 2026-09-15）：

- [App Server 帳號及額度介面](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [憑證儲存](https://learn.chatgpt.com/docs/auth#credential-storage)
