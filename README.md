# AI 課程預約及簽到

供補習中心使用的預約系統。管理員登入後可建立課程與上課時段，並在日曆查看預約及付款證明。學生於公開登記表選擇時段，並上載 .jpg 付款證明。

## 使用方式（本機）

需要 Node.js 22.5 或更新版本：

```sh
npm ci
npm start
```

開啟 [http://localhost:8000](http://localhost:8000)。首次啟動會建立 `data/bookings.db`（SQLite）。未設定 `ADMIN_PASSWORD` 時，示範帳號為 `admin` / `admin1234`；正式環境請在 `.env` 設定 `ADMIN_PASSWORD`（至少 12 字元）。

開發前端可用 `npm run dev`（Vite，API 會 proxy 到 `127.0.0.1:8000`）。

執行測試：

```sh
npm test
```

正式套件（含 Vite build）：

```sh
npm run build
npm start
```

同一個 `npm start` 會在偵測到 `dist/index.html` 時，自動以 `dist/` 提供已編譯的前端。

## Hostinger Web App（GitHub + MySQL）

Hostinger 必須用 **Node.js Web Application**（`npm start` 長駐），唔可以只用靜態網站托管 `dist/`。靜態-only 會令 `/api/*` 回 **503**，登入畫面顯示「操作失敗，請再試一次。」

### 1. 建立 MySQL 資料庫

於 hPanel 建立資料庫，記下全名（含帳戶前綴）的 `DB_NAME`、`DB_USER`、`DB_PASSWORD`。

### 2. 環境變數（hPanel → Web App → Environment）

```text
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=你的資料庫全名
DB_USER=你的資料庫用戶全名
DB_PASSWORD=你的資料庫密碼
ADMIN_USERNAME=admin
ADMIN_PASSWORD=至少12字元的強密碼（例：admin1234aipa5678）
```

**請勿**在 Hostinger 設定 `DATABASE_URL`（會改連 Render Postgres 而令程式啟動失敗）。  
**請勿**設定 `VITE_API_BASE`（前端與 API 應同一個網域，由 `server.js` 一併提供）。

### 3. GitHub 部署設定

| 項目 | 值 |
|------|-----|
| 分支 | `master`（或你的部署分支） |
| Node.js | 24.x（或 ≥20） |
| 根目錄 | `./` |
| Install | `npm ci` |
| Build | `npm run build` |
| Start | `npm start` |

`npm run build` 會產生 `dist/`；`npm start` 會用 Node 同時提供 API 與 `dist/` 前端。

### 4. 部署後檢查

```text
GET https://你的網域/api/health
```

應回 JSON，例如：

```json
{"ok":true,"database":"mysql","frontend":"dist"}
```

若 `database` 唔係 `mysql`、或回 503，請睇 **Deployments → Logs** 有冇 MySQL 連線錯誤或缺少環境變數。

管理員登入：`ADMIN_USERNAME` + `ADMIN_PASSWORD`。修改密碼後要 **Redeploy / Restart**，啟動時才會用新密碼更新資料庫。

## Render（Postgres，可選）

Render 或其他 Postgres 托管可設：

```text
DATABASE_URL=postgresql://...
ADMIN_PASSWORD=至少12字元
```

**唔好**同時設 `DB_TYPE=mysql`；MySQL 模式會優先於 `DATABASE_URL`。

## Windows（Docker）

安裝並啟動 Docker Desktop，使用 Linux containers。在 PowerShell 進入專案目錄：

```powershell
Copy-Item .env.example .env
notepad .env
```

在 `.env` 加入 `ADMIN_PASSWORD=你的強密碼`。然後啟動：

```powershell
docker compose up -d --build
```

開啟 http://localhost:8000。管理員預設用戶名為 `admin`，密碼使用剛設定的值。

## 功能

- 管理員登入（Bearer session）
- 建立課程與有名額的上課時段
- 日曆查看時段、預約與付款證明
- 學生登記；時段已滿時建議其他尚有空位的課程或時段
- 學生須上載 .jpg 付款證明
- 學生登記必須填寫公司名稱
- 預約確認及課前出席提醒電郵（Resend，需 `RESEND_API_KEY`）

## 環境變數

複製 `.env.example` 為 `.env`。資料庫與管理員密鑰只放在環境變數，不要提交到 Git。

## 疑難排解

| 現象 | 常見原因 |
|------|-----------|
| 登入「操作失敗，請再試一次」 | `/api/auth/login` 無回應；多數係 API 503，Node 未啟動或只得靜態 `dist/` |
| `/api/health` 503 | 同上一項；改為 Node Web App，`Start` = `npm start` |
| 啟動即退出 | Hostinger 設了 `DATABASE_URL` 但連唔到 Postgres；刪除 `DATABASE_URL`，只用 `DB_TYPE=mysql` |
| 帳號密碼正確但 401 | 改咗 `ADMIN_PASSWORD` 未 Redeploy；或舊密碼仍在 DB，需要 restart 讓 `seedAdmin` 更新 |
| `ADMIN_PASSWORD` 太短 | MySQL / Postgres 模式最少 12 字元 |
