# codex-switch

終端機 Codex 訂閱帳號管理器，v0.1.0。需要 Linux、Node.js 22+、Codex CLI。
本機已用 Codex CLI 0.154.0 驗證。無 npm 第三方依賴。

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

啟動時自動挑選額度足夠的帳號：

```sh
codex-switch run --auto
codex-switch run --auto --min-remaining 15
codex-switch run --account second -- --no-alt-screen
codex-switch run -- resume --last
```

`--` 後的參數傳給原生 Codex。第一版固定使用 OpenAI provider，
帳號/backend 改寫、`--profile`/`-p` 與登入指令不支援透過 `run`。
`use` 只改變後續 `codex-switch run` 的預設帳號；`--account` 和 `--auto`
只影響這次啟動。直接執行 `codex` 仍使用原本的登入。

## 本機安裝與資料

- 程式：`~/.codex/tools/codex-switch/`
- 指令：`~/.local/bin/codex-switch`，連結到程式的 `bin/codex-switch.mjs`
- 帳號池：`~/.codex/account-pool/`（目錄 700、資料檔 600）
- 目前帳號 `current`：直接引用既有 `~/.codex/`，未複製憑證。
- 新帳號：`~/.codex/account-pool/accounts/NAME/codex-home/`

你的 `.bashrc` 和 `.profile` 已包含 `~/.local/bin`，不需要再修改。
其他主機安裝時，把 `bin/codex-switch.mjs` 的絕對路徑連結到 PATH 中即可。
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
登入錯帳號時保留原憑證。`current` 等匯入帳號必須在其原始 Codex home
用原生 `codex login` 重新登入，工具不會替它執行重新登入。
若在原始 home 改成另一個身分，工具會標示 `identity-changed` 並拒絕啟動；
請恢復原身分，或用獨立 `codex-switch login NEW_NAME` 新增帳號。

新帳號建立時複製 `config.toml` 和 `*.config.toml`，之後各自維護。
若某設定檔含有 workspace 綁定或自訂 backend，工具會提示並略過整份檔案，
讓新帳號使用預設設定，避免繼承另一帳號的綁定；原始檔案不受影響。
`AGENTS.md`、`skills/`、`rules/`、`agents/`、`prompts/` 連結到來源 home。
對話、資料庫、記憶與憑證各自保存。既有對話仍在 `current`；
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

## 第一版界線

- 自動選擇只發生在啟動前；不會在工作進行中切換或承諾永不中斷。
- 不含背景輪詢、shell 攔截、刪除帳號與跨帳號搬移對話。
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
node --check src/core.mjs
node --check src/main.mjs
```

離線測試只使用暫存目錄與假憑證，不接觸真實帳號池。

官方依據（查核 2026-09-15）：

- [App Server 帳號及額度介面](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [憑證儲存](https://learn.chatgpt.com/docs/auth#credential-storage)
