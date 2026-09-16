# codex-switch

終端機 Codex 訂閱帳號管理器，v0.4.0。需要 Linux、Node.js 22+、Codex CLI。
本機已用 Codex CLI 0.154.0 驗證。WebSocket 依賴固定為 `ws@8.21.3`。

這是非官方的本機工具，與 OpenAI 無隸屬關係。不提供帳號、不分享訂閱，
也不增加或重設服務額度；請只管理你有權使用的帳號，遵守服務與組織規範。
不支援 API key、VS Code extension 或桌面 App。

## 功能一覽

- 透過官方登入新增帳號，或匯入目前已登入的帳號。
- 查看各帳號剩餘額度，以 `5h`／`7d` 等時長和 `% left` 顯示。
- 手動切換原生 Codex 登入；依實際登入檔標示目前帳號。
- 在另一個終端監控用量，低於門檻時自動切換可用帳號。
- 帳號改名、可復原移除，以及指定帳號啟動獨立 Codex home。

**重要：**`use`／`auto` 修改本機登入檔，不保證已開啟的 Codex session
會即時採用新帳號。憑證保存在本機，靠檔案權限保護，並非加密保管庫。

## 安裝

### 環境需求

- Linux；macOS／Windows 尚未驗證，不宣稱支援。
- Node.js 22 以上、npm、Git。
- 已安裝且能執行的 Codex CLI，以及自己的 ChatGPT 訂閱帳號。
- 檔案式 `auth.json` 登入；keyring 儲存模式不支援。

先確認環境：

```sh
node --version
npm --version
git --version
codex --version
```

本工具不會替你安裝 Codex CLI。額度查詢與登入需要網路。

### 從 GitHub 原始碼安裝

專案原始碼：[ShuHan410/codex-switch](https://github.com/ShuHan410/codex-switch)。
以下以 Bash、全新安裝且目標路徑尚不存在為例，不需要 sudo：

```sh
mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
git clone https://github.com/ShuHan410/codex-switch.git "$HOME/.local/share/codex-switch"
cd "$HOME/.local/share/codex-switch"
npm ci --ignore-scripts
ln -s "$PWD/bin/codex-switch.mjs" "$HOME/.local/bin/codex-switch"
export PATH="$HOME/.local/bin:$PATH"
codex-switch --version
codex-switch --help
```

若 `ln` 顯示檔案已存在，請先檢查 `ls -l "$HOME/.local/bin/codex-switch"`，
不要直接覆寫既有安裝。保留 clone 的目錄，因為指令連結依賴它與其中的依賴套件。

若 PATH 尚未包含 `~/.local/bin`，在 `~/.bashrc` 加入下列一行，
再開啟新終端（或執行 `source ~/.bashrc`）：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Zsh 使用者將同一行加入 `~/.zshrc`。設定完成後，在任何 repository
都可以呼叫 `codex-switch`，不必每個專案安裝一次。

目前提供原始碼安裝；`package.json` 的 `private: true` 用來防止意外
發布 npm 套件，不妨礙從 GitHub clone 後安裝。

### 更新與移除程式

更新前先停止本工具的 `auto`／`run` 程序，然後在 clone 目錄執行：

```sh
git pull --ff-only
npm ci --ignore-scripts
codex-switch --version
```

若有本機程式修改，先處理 Git 衝突，不要強制覆蓋。
解除安裝時，確認 `~/.local/bin/codex-switch` 是上述建立的連結後移除該連結，
再移除程式 clone 目錄即可。這不會刪除帳號池或原生登入；
帳號池內含憑證，若要清除請另外確認與處理，不要誤刪整個 `~/.codex`。

## 開始使用

已有原生 Codex 登入時，先將它加入池內；名稱由你自訂：

```sh
codex-switch import personal
codex-switch usage personal
```

或者透過工具登入新增帳號（不需要先執行原生 `codex login`）：

```sh
codex-switch login work
codex-switch list
codex-switch usage --all
codex-switch use work
codex
```

`login` 呼叫官方 Codex 登入。依終端機提示開啟瀏覽器、登入你要新增的
ChatGPT 帳號；也可使用 `codex-switch login work --device-auth` 的裝置碼流程。
成功後工具自動收錄帳號。不要把 token 貼到終端機或聊天中。
`personal`、`work`、`second`、`roman` 都只是範例名稱，沒有特殊含義；
請換成自己池內的名稱。名稱長度 1–48，使用英文字母、數字、`_` 或 `-`，
第一個字元必須是英文字母或數字。

常用指令：

| 指令 | 用途 |
| --- | --- |
| `import NAME` | 保存目前登入，來源不變 |
| `login NAME` | 新增登入或重新授權同名帳號 |
| `list` | 列出帳號與實際原生登入標記，不查詢最新額度 |
| `usage NAME`／`usage --all` | 查詢單一／全部帳號剩餘額度 |
| `use NAME` | 切換原生登入並設定工具的預設帳號 |
| `auto`／`status --auto` | 原生登入自動監控／查看監控紀錄 |
| `rename OLD NEW`／`remove NAME` | 改名／移出帳號池 |
| `run --account NAME` | 使用該帳號的獨立 home 啟動 Codex |
| `doctor` | 檢查本機憑證身分與 Codex 可執行性，不驗證伺服器授權 |

不帶名稱的 `usage` 與 `usage --all` 都會查詢整個帳號池。

### 輸出怎麼讀

終端輸出使用純文字與對齊欄位，不依賴顏色、動畫或特殊字型。
帳號名稱、方案與狀態在同一列，email／查詢時間在下方；`usage`
再列出各時段的剩餘額度與重設時間。例如（示意資料）：

```text
Native login: personal@example.test (personal)
Run default: work

  ACCOUNT   PLAN  STATUS
  --------  ----  ----------------
* personal  plus  ready
    personal@example.test
    Checked: 2026-09-16T08:00:00.000Z
    5h           80% left  codex
      Resets: 2026/9/16 下午6:00:00
    7d           45% left  codex
      Resets: 2026/9/20 上午8:00:00
```

`Native login`／`*` 表示原生登入檔的身分，`Run default` 則是未指定
`--account` 時的工具預設選擇，兩者可能不同。時間格式依系統語系顯示。
快取額度會註記尚未確認；無額度資料顯示 `Quota: not available`。
供程式讀取時使用 `--json`，其資料格式不受文字排版影響。

另一種實驗性模式 `run --auto`：啟動專用 Codex 會話並監測、切換。
若你使用一般 `codex`，請使用下方「原生 Codex」章節的 `auto`：

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
`use`／`auto` 寫入前會確認原生 home 是本人擁有的真實目錄。若有群組或
其他人的寫入權限，會先移除這些寫入位元（例如 775 → 755），保留其餘
權限；不再只因 775 就拒絕操作。非本人目錄或符號連結仍會拒絕。
此權限收緊只在切換／啟動監控時進行，`list`／`usage` 不調整原生 home 權限。

## 原生 Codex：在另一個終端執行 auto

終端 A 照常執行 `codex`，終端 B 執行：

```sh
codex-switch auto
# 自訂門檻與間隔（預設值如下）
codex-switch auto --min-remaining 5 --poll-interval 30
```

`auto` 不啟動 Codex 對話。它立即查詢一次，之後每輪完成後等待 30 秒再查：

1. 讀取原生 home 的 `auth.json`，以帳號／workspace 身分比對帳號池，
   不使用工具儲存的預設選擇判斷目前原生帳號。此帳號必須先由 `login` 或新版
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

## 實驗性會話模式：run --auto

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

## 本機資料與安全

- 程式：你 clone 的目錄（上述安裝範例為 `~/.local/share/codex-switch/`）
- 指令：`~/.local/bin/codex-switch`，連結到程式的 `bin/codex-switch.mjs`
- 帳號池：`~/.codex/account-pool/`（目錄 700、資料檔 600）
- 新帳號：`~/.codex/account-pool/accounts/NAME/codex-home/`
- 自動模式：`~/.codex/account-pool/live/`（對話、socket、狀態紀錄）

程式與帳號資料分離；預設帳號池不在 clone 目錄內。
上傳程式只需要上傳這個 Git repository，**不要上傳整個 `~/.codex`**。
`auth.json`、帳號池、登入備份、對話與含私人資訊的診斷輸出都不應公開。
備份和移除後保留的 home 仍含有效憑證；檔案權限不等於加密。

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
文字輸出顯示剩餘百分比，例如 `5h: 80% left`（原本為 `20% used`）；
`usage` 的快取額度也使用 `left`。未知或無效數字顯示 `?% left`。
百分比不是可精確換算的剩餘 token 數。`--json` 保留原始 API
`limits.*.usedPercent` 欄位相容性，`remainingPercent` 則是最少剩餘百分比。

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
`list`／`usage` 每次顯示前會重新讀取原生登入檔，星號表示登入檔的帳號／
workspace 身分與該池內項目相符，不再根據工具儲存的預設選擇標記。
手動使用原生 `codex logout`／`login` 後，下次查詢就會反映新身分。
登入帳號不在池中時，標頭顯示 email 與 `unregistered`，所有項目都不標星；
缺少登入檔顯示 `signed-out`，檔案不安全、無法解析或讀取時顯示 `unknown`，
同樣不沿用舊星號。這僅確認本機檔案，不確認既有 session 或伺服器授權。
兩個指令皆支援 `--codex-home PATH`（預設 `CODEX_HOME`，未設定時為
`~/.codex`）。JSON 仍是陣列：`active` 是本次登入檔比對結果，
`nativeState` 是偵測狀態；`selected` 保留為工具預設選擇，不代表登入身分。
Access token 到期本身不代表登入失效：刷新由 Codex 管理。
查詢失敗時保留上次額度供參考，但不會採用它自動啟動。

兩種自動模式都以所有回傳 bucket／quota window 中的「最少剩餘百分比」
判斷額度，挑選替代帳號時重新查詢，排除未知、忙碌、已用盡或查詢結果
過期的帳號，再選剩餘最多且達門檻者。這是保守策略，可能因與當次模型
無關的 bucket 而排除帳號。

| 模式 | 預設門檻 | 沒有可用帳號／查詢失敗時 |
| --- | --- | --- |
| `auto` | 5% | 沒有合適替代帳號時記錄 `no-alternative`；目前額度無法確認時記錄 `unknown`。不強制切換、不印提醒，繼續輪詢。 |
| `run --auto` | 10% | 啟動時若找不到符合門檻的帳號，報錯退出；啟動後沒有替代帳號則保持現況，記錄 `no-alternative`，繼續輪詢。查詢失敗時記錄 `unknown`。 |

門檻都可用 `--min-remaining` 調整。尚有額度且剩餘剛好等於門檻時不切換；
低於門檻或已用盡才觸發。兩者都不會退回使用未確認額度的替代帳號。

## 帳號改名與移除

```sh
codex-switch rename second adam
codex-switch remove adam
```

`rename` 更改池內名稱，預設選擇也會跟著更新；新名稱不能與現有名稱重複。
登入憑證、對話與 home 路徑不移動，也不會改寫原生登入檔。

`remove` 將指定帳號移出帳號池，之後不再出現在 `list`／`usage --all`，
也不再參與自動切換。若它是預設選擇，預設值會清除；請用 `use` 或
`run --account NAME` 明確選擇其他帳號。移除不等於登出或撤銷授權：原生 Codex
登入保持不變，因此移除目前帳號後，原生身分會顯示 `unregistered`。

這是可復原的移除，不是憑證抹除：登入憑證與對話仍保留在原 home，
帳號紀錄移至池目錄的 `removed/NAME-UUID.json`，指令會印出位置。
可用 `import NAME --source-home 原home路徑` 重新加入仍有效的登入。
改名或移除後可重用舊名稱；若舊 home 存在，新登入會建立帶 UUID 的
獨立 home，避免覆寫保留資料。請勿僅依目錄名稱判斷帳號歸屬。

帳號被本工具鎖定使用時，改名與移除會拒絕執行；請結束該次操作後重試。

## 使用界線

- `run --auto` 監測隨該次終端啟動／結束；`auto` 則在 B 終端前景運行，
  直到 Ctrl-C。兩者都不安裝常駐系統服務。
- 不含提醒、工作重送、自動接續、shell 攔截、永久抹除憑證或搬移舊對話。
- 每帳號同時只允許一個本工具的 run/login/query，避免刷新與登入競爭。
  原生 `codex` 不受這個鎖限制。執行中查詢會回報 busy。
- `run` 模式的終端機 Ctrl-C 由原生 Codex 處理；若要從其他程序停止
  `run` wrapper，請送 SIGTERM（會轉交子程序），不要只對 wrapper PID
  送 SIGINT。獨立的 `auto` 監控器則可用 Ctrl-C／SIGINT 或 SIGTERM 停止。
- 強制終止程式或主機故障可能留下 `.lock`。工具刻意不自動搶鎖。
  先檢查該目錄 `owner.json` 中的 host/PID，確認對應程序及其 Codex 子程序
  都已結束，才手動移除該鎖內的 `owner.json` 與空鎖目錄；不要刪帳號資料。
- 額度讀取有時間差，其他裝置也可能消耗同一帳號額度。

退出碼：0 成功；1 指令／操作錯誤；2 usage/doctor 有未驗證帳號；
3 帳號鎖忙碌。`run` 及互動登入傳回 Codex 的退出碼。

## 開發與驗證

修改程式前先讀 [AGENTS.md](AGENTS.md)：模組分工、維護規則與安全界線。
本 README 是使用者操作手冊；逐次測試證據與未驗證項目保存在
[VERIFICATION.md](VERIFICATION.md)，其中舊版本紀錄不代表現行功能。

```sh
# 先切換到你的 clone 目錄
npm ci --ignore-scripts
npm test
# 修改實驗性即時協定時，再執行：
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

## 授權與發布

目前尚未附上 LICENSE，專案維護者需在正式開源發布前選定授權。
公開 GitHub repository 不等於已授予完整的開源使用、修改與散布權利；
請參考 [GitHub 授權說明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。
本節不代表已套用任何授權條款。

專案已發布於 [GitHub](https://github.com/ShuHan410/codex-switch)。
維護者提交後續更新時，先確認 `origin` 指向本專案，並確認要發布的變更
已完成 commit，再從本機程式目錄執行：

```sh
git status
git remote -v
git push origin main
```

先完成 GitHub 的 Git 認證；不要將存取 token 放進 URL 或 README。
發布前檢查 `git ls-files` 與歷史紀錄，確認沒有私人憑證、帳號資料或
不想公開的內容。Git 提交中的作者姓名與 email 也會公開。
詳細流程見 [GitHub：上傳既有本機程式](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)。
