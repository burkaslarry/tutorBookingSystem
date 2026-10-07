# AI 課程預約及簽到

供補習中心使用的預約系統。管理員登入後可建立課程與上課時段，並在日曆查看預約及轉數快收據。學生於公開登記表選擇時段，先以轉數快付款並上載收據。資料儲存於本機 SQLite。

## 使用方式

需要 Node.js 22.5 或更新版本。在專案目錄執行：

```sh
npm start
```

然後開啟 [http://localhost:8000](http://localhost:8000)。首次啟動時會建立 `data/bookings.db`。示範管理員帳號見登入頁「如何登入？」。正式環境請在 `.env` 設定 `ADMIN_PASSWORD`（變數名稱見 `.env.example`）。

執行測試：

```sh
npm test
```

## 功能

- 管理員登入（Bearer session）
- 建立課程與有名額的上課時段
- 日曆查看時段、預約與轉數快收據
- 學生登記；時段已滿時建議其他尚有空位的課程或時段
- 轉數快須先上載 .png 或 .jpeg 收據，收據與預約一併保存
- KPay 付款可依 `.env.example` 的商戶變數開啟
- 預約確認及課前出席提醒電郵（Resend，需 `RESEND_API_KEY`）

## 環境變數

複製 `.env.example` 為 `.env`。Resend 與 KPay 的密鑰只放在環境變數，不要提交到 Git。
