# codex-switch

終端機 Codex 訂閱帳號管理器，v0.2.0。需要 Linux、Node.js 22+、Codex CLI。
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
`use` 只改變後續 `codex-switch run` 的預設帳號；`--account` 和 `--auto`
只影響這次啟動及該次自動監測。直接執行 `codex` 仍使用原本的登入。

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
匯入是登記原始儲存位置，因此 token 刷新後仍只維護一份憑證。
同一 ChatGPT 身分與 workspace 不可重複登記。

所有登入會先在暫存目錄完成，成功且通過帳號檢查後才保存。
新帳號重新登入會確認是原來的身分後才替換憑證；
登入錯帳號時保留原憑證。透過 `import` 登記的帳號必須在其原始 Codex home
用原生 `codex login` 重新登入，工具不會替它執行重新登入。
若在原始 home 改成另一個身分，工具會標示 `identity-changed` 並拒絕啟動；
請恢復原身分，或用獨立 `codex-switch login NEW_NAME` 新增帳號。

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

- 自動模式的監測隨該次終端啟動／結束；不安裝常駐系統服務。
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
