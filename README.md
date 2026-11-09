# AI 課程預約及簽到

供補習中心使用的預約系統。管理員登入後可建立課程與上課時段，並在日曆查看預約及付款證明。學生於公開登記表選擇時段，並上載 .jpg 付款證明。

**正式環境建議：全部用 Hostinger（Node + MySQL）**，唔好再用 Render 做 API 或 Postgres。參考 `.env.hostinger.example`。

## Hostinger 正式部署（唯一推薦）

### 架構

同一個 Hostinger **Node.js Web Application**：

- `npm run build` → `dist/` 前端
- `npm start` → `server.js` 提供 `/api/*` + `dist/`

前端 **唔使** `VITE_API_BASE`；所有請求打同一個網域。

### 1. MySQL

hPanel 建立資料庫，記下 **含帳戶前綴** 嘅 `DB_NAME`、`DB_USER`、`DB_PASSWORD`。

### 2. 環境變數（hPanel → Web App → Environment）

```text
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=你的資料庫全名
DB_USER=你的資料庫用戶全名
DB_PASSWORD=你的資料庫密碼
ADMIN_USERNAME=admin
ADMIN_PASSWORD=至少12字元（例：admin1234aipa5678）
```

**必須刪除或未設定：**

- `DATABASE_URL`（程式在 `DB_TYPE=mysql` 時會忽略，但刪走可避免混淆）
- `VITE_API_BASE`（唔好指去 Render）

### 3. GitHub 部署

**重要：** hPanel 若自動偵測做 **Framework: Vite**，只會 `vite build` 再發佈 `dist/`（靜態），**唔會**跑 `server.js`，`/api/*` 會 **503**。請改做 **Express** 或 **Other**：

| 項目 | 值 |
|------|-----|
| Framework | **Express** 或 **Other**（唔好選 Vite） |
| Build script | `build`（即 `npm run build`） |
| Output directory | 留空（Express / Other + entry file） |
| Entry file | `server.js` |
| Install | `npm ci` |
| Node | 24.x 或 ≥20 |

### 4. 驗收

```text
GET https://你的網域/api/health
```

成功例子：

```json
{"ok":true,"database":"mysql","frontend":"dist"}
```

然後用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登入 `/#login`。改密碼後要 **Redeploy**，啟動時先會寫入 MySQL。

### 常見錯誤

| 現象 | 原因 |
|------|------|
| 登入「操作失敗」 | `/api` 503：Framework 設成 **Vite**（靜態站）、或未設 **Entry file `server.js`** |
| Runtime log：`did not call listen() within 3 seconds` | Hostinger 要求 3 秒內 `listen()`；新版 `server.js` 會先監聽、MySQL 連好後再接管請求 |
| `database` 唔係 `mysql` | 缺 `DB_TYPE=mysql` 或 MySQL 連線失敗 |
| 密碼啱但 401 | 未 Redeploy；或 DB 內仍係舊 hash |

---

## 本機開發

需要 Node.js 22.5+：

```sh
npm ci
npm start
```

本機可用 SQLite（`data/bookings.db`），或 `.env` 設 `DATABASE_URL` 連 Postgres **僅供開發**。未設 `ADMIN_PASSWORD` 時示範帳號：`admin` / `admin1234`。

```sh
npm run dev    # Vite，API proxy 到 :8000
npm test
npm run build && npm start   # 模擬 Hostinger
```

## Windows（Docker）

```powershell
Copy-Item .env.example .env
# 設定 ADMIN_PASSWORD
docker compose up -d --build
```

## 功能

- 管理員登入（Bearer session）
- 課程、時段、日曆、收據
- 學生登記（公司名稱 + .jpg 付款證明）
- 電郵提醒（Resend，可選）

## Render（唔再用於此專案正式站）

若舊有 `tutorbookingsystem.onrender.com` 可暫停慳錢。倉庫內 `render.yaml` / `npm run db:render` 只係歷史 Postgres 工具，**與 Hostinger MySQL 正式站無關**。
