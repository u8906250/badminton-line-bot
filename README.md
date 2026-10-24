# 羽球臨打季打管理系統

LINE 群組機器人 + LIFF 報名頁。後端是 Cloudflare Workers（Hono）+ D1，LIFF 頁面放在 Cloudflare Pages。

**第一階段：報名**

- 群組指令：`/綁定`、`+1`、`+1 朋友名字`（最後可以加性別與程度：`+1 女`、`+1 6級`、`+1 小美 女 L6`；性別只在男女臨打費不同時有用，程度是 18 級羽球分級表的 1–18）、`-1`／`取消`、`請假`、`銷假`、`名單`、`選單`、`/取消場次 原因`（管理員）
- 依每週時段自動產生未來 4 週場次，季打成員自動佔位
- 報名開放、截止、結束狀態自動推進（每 5 分鐘）
- 候補自動遞補並 @提及被遞補的人
- LIFF 報名頁：最上面是球團規則（可收合）；報名中的場次直接顯示場地、第幾場地與名單，可報名、代朋友報名、取消、請假、銷假；還沒開放的場次收在下方的小清單
- 臨打報名可以填程度（不必填），表單裡附 18 級羽球分級表的說明；有填的會標在名單上
- 意見回饋：報名頁和管理各分頁的最下面都有一個不顯眼的「意見回饋」連結，可以寫話給這套系統的開發者，會寄到 `wrangler.toml` 裡 `FEEDBACK_TO` 填的信箱（設定方式見下面「意見回饋的信箱」）。只有開發者收得到，頁面上看不到別人寫的，球團管理員也看不到

**第二階段：管理員（LIFF「管理」分頁，只有管理員看得到）**

- 場次：臨時加場、調整單場上限（自動遞補或退回候補）、修改單場的第幾場地、取消場次並公告、名單管理（代成員報名、代取消、代季打請假與銷假）
- 點名收費：勾出席；臨打勾已收，金額預設帶入臨打費（報名時選女生的帶女生臨打費）、可修改
- 季打：建立季期、加入或移出季打成員（立即套用到這季未開打的場次）、季費已繳、設定誰免季費（例如教練、幹部，記帳時不算）；也可以加入不在 LINE 上的人（例如教練），一樣佔季打名額
- 抽籤：記錄每次抽籤（例如場地抽籤），勾選每位成員是否已經抽籤、有沒有抽中，也可以手動加入不在球團裡的人（外面名單），一次貼多個名字
- 報名頁上的管理員操作：在場次卡片（尚未開放的從「名單」進去）代季打請假、銷假；「匯出文字名單」產生可以直接貼到 LINE 群組的名單（季期與第幾場、日期、時間、地點、人數、球團規則，季打在前、請假的標「（請假）」、臨打標「0打」、候補另列），可以先修改再複製
- 記帳：依期間（各季期、本月、上月、今年、全部）彙總季打費、臨打費的已收與未收，登記場地費、羽球費、其他收支，算出結餘。季打成員在報名頁會多一個「帳本」分頁，看得到同一份帳，但不能新增或刪除；不想公開時，管理員在「設定」取消勾選「讓季打成員看帳本」就只有管理員看得到
- 時段：新增、修改（已排好的場次一起更新）、停用；可填第幾場地（例如「第 3、4 場」），會帶到每一場
- 成員：暱稱、指定管理員、轉移擁有者（擁有者限定）；手動加入的非 LINE 成員可以改名、移除
- 設定：球團名稱、臨打費與女生臨打費（留空 = 相同；不同時，臨打報名會多選一次價錢，只記在那一筆報名上）、球團規則／備註（顯示在報名頁最上面）、要不要讓季打成員看帳本（預設給看，取消勾選就只有管理員看得到）、報名開放與截止規則、取消期限；擁有者可以在最下面刪除整個球團（要輸入球團名稱確認，無法復原），刪除後在群組重新 `/綁定` 就能建立新的

管理員操作造成的遞補或退回候補，會合併成一則推播通知群組。

## 專案結構

```
schema.sql        資料表（全新安裝用）
migrations/       既有資料庫升級用的 SQL，每個檔案執行一次
seed.sql          （選用）用 SQL 一次匯入設定、時段、季打名單
src/index.ts      Worker 進入點：webhook、API、排程
src/commands.ts   群組指令解析與處理
src/service.ts    報名、取消、請假、銷假、遞補規則
src/cron.ts       產生場次、推進狀態
src/api.ts        LIFF 用的 REST API（成員）
src/admin.ts      管理員 API 路由
src/manage.ts     管理員功能的規則（設定、時段、季期、場次、點名、角色）
src/ledger.ts     記帳：手動登記的收支與期間彙總
src/http.ts       API 共用的錯誤處理
src/notify.ts     名單 Flex Message、遞補通知
src/line.ts       LINE API（簽章驗證、reply、push、ID token 驗證）
src/time.ts       時區換算
liff/             LIFF 頁面（index.html + app.js 成員頁 + admin.js 管理頁，不需建置）
test/             規則測試（用 Node 內建 SQLite 模擬 D1）
```

## 部署步驟

### 1. LINE Developers

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立一個 **Provider**。
2. 在這個 Provider 底下建立 **Messaging API channel**（會同時建立 LINE 官方帳號）。
   - 記下 **Channel secret**（Basic settings 頁）。
   - 在 Messaging API 頁發行 **Channel access token (long-lived)**。
3. 到 [LINE Official Account Manager](https://manager.line.biz/) 的帳號設定：
   - **允許加入群組或多人聊天室**：開啟。
   - **回應設定**：關閉「自動回應訊息」和「加入好友的歡迎訊息」，開啟 Webhook。
4. 在**同一個 Provider** 底下建立 **LINE Login channel**，記下 **Channel ID**。
   - 在 LIFF 分頁新增 LIFF app：Size 選 **Full**，Scope 勾 **openid** 和 **profile**，Endpoint URL 先隨便填，部署 Pages 後再改。記下 **LIFF ID**。
   - 這個 channel 要切換成 **Published**，否則只有開發者自己能開 LIFF 頁面。

> 兩個 channel 一定要在同一個 Provider，機器人和 LIFF 拿到的 userId 才會一致。

### 2. Cloudflare

```bash
npm install
npx wrangler login

# 建立資料庫，把輸出的 database_id 填進 wrangler.toml
npx wrangler d1 create badminton
npm run db:init

# 機密值
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

修改 `wrangler.toml` 的 `[vars]`：`LOGIN_CHANNEL_ID`、`LIFF_ID`，`LIFF_ORIGIN` 先留著，下一步再填。

**意見回饋的信箱（選用）**：成員在報名頁寫的意見回饋會寄到 `FEEDBACK_TO`。寄信用 [Resend](https://resend.com)（免費方案每天 100 封）：

1. 用要收信的那個信箱註冊 Resend。沒有自己的網域時，Resend 只能寄到註冊用的信箱，所以兩邊要是同一個。
2. 在 Resend 的 API Keys 建立一把 key（權限選 Sending access 就夠）。
3. `wrangler.toml` 的 `FEEDBACK_TO` 填那個信箱，執行 `npx wrangler secret put RESEND_API_KEY` 貼上 key。

不想開放意見回饋就把 `FEEDBACK_TO` 那一行刪掉，報名頁不會出現入口。有填信箱但還沒設定 key 時，留言會先存在資料庫，設定好之後 5 分鐘內自動補寄。

```bash
npm run deploy          # 記下 Worker 網址，例如 https://badminton-line-bot.xxx.workers.dev
```

### 3. LIFF 頁面

1. 修改 `liff/app.js` 最上方的 `CONFIG`：`LIFF_ID`，以及 `API_DIRECT`（Worker 網址 + `/api`，備用路徑）。`API_BASE` 維持 `/api` 不用改。
2. 部署：

   ```bash
   npm run deploy:liff   # 記下 Pages 網址，例如 https://badminton-liff.pages.dev
   ```

   部署完成時印出的 `https://<8碼>.badminton-liff-xxx.pages.dev` 是這一次部署的快照，之後重新部署不會更新。
   下面兩步要填的是去掉 `<8碼>.` 的固定網址。

3. 回到 LINE Login channel，把 LIFF 的 Endpoint URL 改成 Pages 網址。
4. 把 Pages 網址填進 `wrangler.toml` 的 `LIFF_ORIGIN`（不要結尾斜線），再 `npm run deploy` 一次。
5. 讓頁面的 `/api` 接到後端：Cloudflare 後台 → Workers & Pages → 這個 Pages 專案 → Settings → Bindings → Add → Service binding，
   變數名稱填 `API`、Service 選後端的 Worker（`badminton-line-bot`），Production 和 Preview 都加，然後再 `npm run deploy:liff` 一次讓設定生效。

   頁面平常是呼叫同網域的 `/api/*`，由 `liff/_worker.js` 透過這個 binding 交給後端 Worker。這樣做是為了速度：
   從台灣直接連 `*.workers.dev` 可能被送到美國的機房，每個畫面要等一秒以上；`*.pages.dev` 則是就近的機房。
   沒設定這個 binding 時頁面仍然能用，它會自動改成直接連 `API_DIRECT`，只是比較慢。
   檢查方式：開 `https://<Pages 網址>/api/ping`，應該回 `{"ok":true,"colo":"TPE",...}` 這樣的 JSON（`colo` 是執行的機房，`dbMs` 是查一次資料庫的毫秒數）。

### 4. 接上 webhook

在 Messaging API channel 設定 **Webhook URL** 為 `https://<Worker 網址>/webhook`，開啟 **Use webhook**，按 **Verify** 應該會成功。

### 5. 在群組啟用

1. 把官方帳號加入羽球群組。
2. 在群組輸入 `/綁定 球團名稱`，輸入的人就是擁有者。
3. 請大家在群組輸入一次 `選單`（系統要先看過他們，才能加入季打或指定管理員）。
4. 在群組輸入 `選單` 打開報名頁，切到「管理」：
   - 「設定」填臨打費與報名規則
   - 「時段」新增每週時段，會立即排好未來 4 週的場次
   - 「季打」建立季期並勾選季打成員
   - 「成員」指定其他管理員
5. 在群組輸入 `名單` 確認。

想用 SQL 一次匯入，也可以改用 `seed.sql`（說明在檔案開頭）。

## 常用維護指令

```bash
# 升級既有資料庫：先補上新的資料表與索引（可重跑，不會動到既有資料），
# 再把 migrations/ 裡還沒執行過的檔案依編號各執行一次，最後部署 Worker
npm run db:init
npx wrangler d1 execute badminton --remote --file=migrations/001_gender_fee.sql
npx wrangler d1 execute badminton --remote --file=migrations/002_registration_gender.sql
npx wrangler d1 execute badminton --remote --file=migrations/003_court_rules_level.sql
npx wrangler d1 execute badminton --remote --file=migrations/004_season_fee_exempt.sql
npx wrangler d1 execute badminton --remote --file=migrations/005_open_notice.sql
npx wrangler d1 execute badminton --remote --file=migrations/006_ledger_visible.sql

# 看最近的場次
npx wrangler d1 execute badminton --remote --command "SELECT id, start_at, status FROM sessions ORDER BY start_at LIMIT 10"

# 看最近的管理操作
npx wrangler d1 execute badminton --remote --command "SELECT created_at, actor_id, action, detail FROM audit_logs ORDER BY id DESC LIMIT 20"

# 看最近的意見回饋（emailed_at 是空的 = 還沒寄出，last_error 是原因）
npx wrangler d1 execute badminton --remote --command "SELECT created_at, club_name, user_name, message, emailed_at, attempts, last_error FROM feedback ORDER BY created_at DESC LIMIT 20"

# 看即時 log
npx wrangler tail
```

## 注意事項

- **推播額度**：群組指令都用 reply 回覆，不計費。在 LIFF 取消、請假或管理員操作造成的名單變動通知，以及管理員取消場次的公告會用 push，對群組推播一次會以群組人數計算。台灣免費方案每月 200 則，超過時通知會失敗，但報名結果不受影響。
- **開放報名通知（目前鎖住）**：場次開放報名時不會自動在群組發通知，因為對群組推播一次就會扣掉和群組人數一樣多的額度。場次開放後，請管理員在群組輸入「名單」或「選單」，機器人的回覆不計額度，大家會看到最近一場的名單和報名頁連結；設定頁也有這段提示。功能還留在程式裡：在 `wrangler.toml` 的 `[vars]` 加上 `OPEN_NOTICE = "on"` 再 `npm run deploy`，設定頁就會出現「開放報名時在群組發通知」的開關（每個球團各自決定，預設關閉）；發之前會查本月額度，發完不夠再推播一次就略過，把額度留給遞補通知。
- **意見回饋**：留言先存進資料庫，排程每 5 分鐘寄一次；寄不出去會重試，最多 5 次，之後留在資料庫裡（用上面的指令查）。同一個人 24 小時內最多 5 則。信的內容（留言、留言人的名字、球團名稱）會經過 Resend。留言只寄給開發者：頁面和 API 都沒有讀取的入口，球團的擁有者、管理員也看不到別人寫的。
- **登入過期**：LINE 的登入憑證大約一小時過期，而 LIFF 不會自己換新（在電腦瀏覽器開最容易遇到）。頁面發現過期會自動登出再重新登入；一分鐘內重試過還是不行才會顯示「登入已過期」。
- **排程與容量**：排程每 5 分鐘跑一次。推進場次狀態是每輪對所有球團做；補未來 4 週的場次則每輪只輪到 5 個球團（`CLUBS_PER_RUN`，`src/cron.ts`），球團多了就是每個球團隔比較久輪到一次（最慢「球團數 ÷ 5」輪），單輪的工作量不會跟著球團數變大。管理員新增、修改時段或建立季期時，自己的球團會立刻補一次，不用等。改排程間隔時，`wrangler.toml` 的 `crons` 和 `src/cron.ts` 的 `RUN_EVERY_MS` 要一起改。
- **免費方案的上限（2026-10 實測）**：Workers 每次執行 CPU 10 毫秒、對外連線 50 次、D1 呼叫 1,000 次（一次 `batch()` 算 1 次）；每天 10 萬次請求、D1 讀 500 萬列。LINE 免費每月 200 則推播，對群組推播一次扣「群組人數」則，50 人的群組一個月只夠推 4 次，這通常是最先用完的。
- **時間**：資料庫存 UTC，顯示與排程依球團時區（預設 Asia/Taipei）。
- **不超賣**：報名與遞補的名額判斷都在同一句 SQL 完成，兩個人同時搶最後一個名額也只會有一人正取。
- **測試**：`npm test` 會用 Node 內建的 SQLite 模擬 D1，跑過報名、候補、請假、銷假、遞補、取消期限、退群、排程，所有管理員功能、記帳、開放報名通知、意見回饋，以及排程一輪處理哪些球團（需要 Node 22.13 以上）。
- **速度**：覺得畫面變慢時，分別開 `https://<Pages 網址>/api/ping` 和 `https://<Worker 網址>/api/ping` 比較 `colo`（執行的機房）和 `dbMs`（查一次資料庫的毫秒數）。2026-10-13 從台灣實測：經 pages.dev 是台北、每次查詢約 35 毫秒；直接連 workers.dev 是美國達拉斯、每次查詢約 210 毫秒。升級 Workers Paid 不會改變機房。
- **本機開發**：`npm run db:init:local` 後 `npm run dev`，再用 ngrok 或 cloudflared tunnel 把 webhook 指到本機。頁面要在本機跑的話另外開 `npx wrangler pages dev liff --service API=badminton-line-bot`。
