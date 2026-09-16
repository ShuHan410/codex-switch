# codex-switch

在終端機管理多個 Codex ChatGPT 訂閱帳號：查看剩餘額度、切換原生登入，
並在額度不足時自動換到可用帳號。

> 非官方工具，與 OpenAI 無隸屬關係。不提供帳號、不分享訂閱，也不增加或
> 重設額度。請只管理你有權使用的帳號，並遵守服務與組織規範。

目前版本 v0.4.0。支援 Linux、Node.js 22+、Codex CLI 與檔案式 ChatGPT
`auth.json` 登入；macOS／Windows、API key、keyring、VS Code extension
和桌面 App 尚未支援。

## 功能

- 透過官方登入新增帳號，或匯入目前的 Codex 登入。
- 查詢各帳號剩餘額度，支援純文字與 JSON。
- 手動切換原生 `~/.codex/auth.json`。
- 在另一個終端監控原生登入，低額度時自動切換帳號。
- 以獨立 Codex home 啟動指定帳號，隔離憑證與對話。
- 帳號改名與可復原移除。

## 安裝

先確認已安裝 Node.js 22+、npm、Git 與 Codex CLI：

```sh
node --version
npm --version
git --version
codex --version
```

從 [GitHub](https://github.com/ShuHan410/codex-switch) 安裝，不需要 sudo：

```sh
mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
git clone https://github.com/ShuHan410/codex-switch.git "$HOME/.local/share/codex-switch"
cd "$HOME/.local/share/codex-switch"
npm ci --ignore-scripts
ln -s "$PWD/bin/codex-switch.mjs" "$HOME/.local/bin/codex-switch"
codex-switch --version
```

若找不到指令，將下列設定加入 `~/.bashrc`（Zsh 使用 `~/.zshrc`），再開新終端：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

如果 `~/.local/bin/codex-switch` 已存在，先用 `ls -l` 確認來源，不要直接覆寫。
目前僅提供 GitHub 原始碼安裝，不發布 npm 套件。

更新前先停止 `auto`／`run`，再執行：

```sh
cd "$HOME/.local/share/codex-switch"
git pull --ff-only
npm ci --ignore-scripts
codex-switch --version
```

## 快速開始

將目前原生 Codex 已登入的帳號保存到帳號池：

```sh
codex-switch import personal
codex-switch usage personal
```

或透過官方登入流程新增另一個帳號：

```sh
codex-switch login work
# 也可使用裝置碼流程
codex-switch login work --device-auth
```

查看並切換帳號：

```sh
codex-switch list
codex-switch usage --all
codex-switch use work
codex
```

`personal`、`work` 都只是自訂名稱。名稱長度為 1–48，只能使用英文字母、
數字、`_`、`-`，且第一個字元必須是英文字母或數字。

## 指令

| 指令 | 用途 |
| --- | --- |
| `import NAME [--source-home PATH]` | 複製現有登入到獨立管理的 home |
| `login NAME [--device-auth]` | 新增帳號或重新授權同名帳號 |
| `list [--json]` | 列出帳號與目前原生登入，不查最新額度 |
| `usage [NAME \| --all] [--json]` | 查詢單一或全部帳號的最新額度 |
| `use NAME` | 切換原生登入並更新工具預設帳號 |
| `auto` | 執行原生登入自動監控並在終端顯示狀態 |
| `run [--account NAME] [-- ARGS...]` | 用獨立 home 啟動 Codex |
| `rename OLD NEW` | 修改池內帳號名稱 |
| `remove NAME` | 將帳號移出池，保留可復原資料 |
| `doctor` | 檢查本機設定，不驗證伺服器授權 |

完整參數可執行 `codex-switch --help`。

### 登入與帳號池

`import` 複製目前 `CODEX_HOME`（預設 `~/.codex`）的登入，不開啟瀏覽器、
不修改來源。`login` 則執行新的官方登入流程；同名帳號重新登入時，只有底層
帳號／workspace 身分相同才會更新憑證。兩者保存後都使用獨立 Codex home。

同一底層身分不能以不同名稱重複加入。`import` 是登入快照，不是新的 OAuth
授權；來源與池內若同時刷新同一組 token，任一份仍可能失效。授權失效時請用
`codex-switch login NAME` 重新登入。

`rename` 不搬動登入或對話。`remove` 只將帳號移出池，不登出、不撤銷或抹除
憑證；指令會印出可復原紀錄位置。被本工具鎖定的帳號不能改名或移除。

### 額度與手動切換

`usage` 透過本機 `codex app-server` 查詢，不啟動模型 turn。查詢全部帳號時
固定最多同時處理兩個帳號；每次都查最新資料，不沿用額度快取，也不提供
調整並行數的參數。`list` 則只讀快取狀態，但每次都會重新比對原生登入檔。

`use NAME` 原子替換原生登入檔，並保存必要備份；不修改原生設定或歷史紀錄。
它不查詢額度，也不保證已開啟的 Codex session 會採用新登入。如需指定原生
home，可在 `list`、`usage`、`use`、`auto` 使用 `--codex-home PATH`。

文字時間使用執行主機的時區；可用 `TZ=Asia/Taipei` 暫時指定。
互動終端會以顏色區分狀態，設定 `NO_COLOR=1` 可停用。`--json` 不含色碼。

### 使用獨立 home 啟動 Codex

```sh
codex-switch run                         # 使用工具預設帳號
codex-switch run --account work
codex-switch run --account work -- --no-alt-screen
codex-switch run -- resume --last
```

`--` 後的參數傳給 Codex。每個帳號的對話、資料庫、記憶、設定與憑證分開；
`resume --last` 只會看到該 home 的對話。`AGENTS.md`、skills、rules、agents
與 prompts 會連結到建立帳號時的來源 home；含帳號／backend 綁定的設定檔
不會複製。MCP／外掛登入需各自設定。`run` 不接受登入、profile 或 backend
覆寫指令。

## 自動切換原生登入：`auto`

適合平常直接執行 `codex` 的工作流：終端 A 使用 Codex，終端 B 執行監控。

```sh
# 終端 A
codex

# 終端 B
codex-switch auto
```

`auto` 立即檢查一次，之後預設每輪完成後等待 30 秒。它會：

1. 依原生 `auth.json` 的帳號／workspace 身分找出目前帳號。
2. 查詢目前帳號的所有額度視窗。
3. 任一視窗剩餘低於 5% 或用盡時，重新查詢其他帳號。
4. 選擇最低剩餘額度最高、且至少達 5% 的帳號，再安全替換原生登入檔。

目前原生帳號必須已由 `login` 或 `import` 加入池中。額度未知、查詢失敗、
登入在查詢途中改變，或沒有合適替代帳號時，都不強制切換。

```sh
codex-switch auto --min-remaining 5 --poll-interval 30
codex-switch auto --codex-home "$HOME/.codex"
codex-switch auto --once          # 執行一輪；必要時仍會切換
codex-switch auto --quiet         # 保持安靜，仍照常監控及切換
```

剛好等於門檻時不切換；低於門檻才觸發。啟動後會印出監控設定；互動式終端
會在同一行更新目前帳號、剩餘額度與下次檢查時間，切換或警告則另起一行。
輸出被重新導向時不印週期心跳，避免產生大量紀錄；`--quiet` 可關閉所有正常
輸出。按 Ctrl-C 停止後，已完成的切換不會還原。同一帳號池與原生 home 同時
只允許一個監控器。

`auto` 只負責更新登入檔，不啟動、接管、重啟或重送既有 session，也不確認
既有 session 是否採用新帳號。手動執行原生 `codex login/logout` 或 `use`
前，請先停止 `auto`；一般 Codex 不遵守本工具的帳號鎖。

## 實驗功能：`run --auto`

```sh
codex-switch run --auto
codex-switch run --auto --min-remaining 10 --poll-interval 30
codex-switch status
codex-switch run --auto -- resume --last
```

這個模式由工具啟動專用 Codex App Server 和互動終端，在同一服務內切換登入，
嘗試讓後續請求沿用同一 thread。預設門檻 10%、間隔 30 秒；不會中斷或重播
已送出的 turn。對話集中在 `~/.codex/account-pool/live/codex-home/`。

此介面仍屬 experimental：無法接管已由一般 `codex` 啟動的程序；正式服務的
長時間刷新與串流切換尚未完整驗收；同 email、不同 workspace 的歧義帳號會被
排除；只支援互動式終端。一般使用者應優先採用上一節的 `auto`。

## 資料與安全

| 資料 | 預設位置 |
| --- | --- |
| 程式 | `~/.local/share/codex-switch/` |
| 指令連結 | `~/.local/bin/codex-switch` |
| 帳號池 | `~/.codex/account-pool/` |
| 帳號 home | `~/.codex/account-pool/accounts/NAME/codex-home*` |
| `auto` 備份 | `~/.codex/account-pool/auto/backups/` |

帳號池、備份和保留的 home 含登入憑證，目錄／檔案權限為 700／600，但不是
加密保管庫。不要上傳 `~/.codex`、`auth.json`、帳號池、對話或診斷輸出。
程式 repository 與帳號資料彼此分離。

`use`／`auto` 只接受目前使用者擁有的真實原生 home；符號連結或他人擁有的
目錄會被拒絕。它們會清除 group／other 寫入權限，例如 775 調整為 755。
`list`／`usage` 不調整權限。遇到權限或認證問題請先處理根因，不要繞過檢查。

強制終止或主機故障可能留下 `.lock`；工具不會自動搶鎖。確認 `owner.json`
所記錄的 host／PID 與其 Codex 子程序都已結束後，才人工處理鎖，勿刪帳號資料。

環境變數：

- `CODEX_HOME`：原生 Codex home。
- `CODEX_SWITCH_HOME`：帳號池位置。
- `CODEX_SWITCH_CODEX`：Codex 執行檔，主要供測試／多套安裝。
- `NO_COLOR`：停用終端色彩。

退出碼：0 成功；1 指令／操作錯誤；2 `usage`／`doctor` 有未驗證帳號；
3 帳號鎖忙碌。`run` 與互動登入傳回 Codex 的退出碼。

## 限制

- 不支援提醒、工作重送、自動接續、shell 攔截或永久抹除憑證。
- 額度是服務回傳的視窗百分比，不等同精確 token 數，其他裝置也可能消耗額度。
- 多份相同 refresh token 可能互相失效；需要時重新登入。
- 管理員、workspace 與 Codex 本身的限制仍然有效，本工具不會繞過。

## 開發

維護規則與模組分工請讀 [AGENTS.md](AGENTS.md)；歷史測試證據與尚未驗證項目
保存在 [VERIFICATION.md](VERIFICATION.md)。一般修改至少執行：

```sh
npm ci --ignore-scripts
npm test
git diff --check
```

涉及實驗性即時協定時，再執行 `node scripts/verify-live-protocol.mjs`。

## 授權

目前尚未附上 LICENSE。公開 GitHub repository 允許查看與 fork，但在選定授權
前，不代表已授予完整的使用、修改與散布權利。
