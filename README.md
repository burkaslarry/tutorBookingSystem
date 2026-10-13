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

## Windows（Docker）

安裝並啟動 Docker Desktop，使用 Linux containers。在 PowerShell 進入專案目錄：

```powershell
Copy-Item .env.example .env
notepad .env
```

在 `.env` 加入 `ADMIN_PASSWORD=你的強密碼`，並設定 `FPS_PAYEE_NAME`、`FPS_IDENTIFIER`。然後啟動：

```powershell
docker compose up -d --build
```

開啟 http://localhost:8000。管理員預設用戶名為 `admin`，密碼使用剛設定的值。
同一網絡的其他裝置可用 `http://Windows電腦的區域網IP:8000` 連接，需允許 Windows 防火牆的相應連線。
讓公眾學生使用時，需另外設定公眾網址及 HTTPS；本機 localhost 網址只適用於本機。

更新程式後再執行 `docker compose up -d --build`。查看記錄用 `docker compose logs -f`；停止用 `docker compose down`。
SQLite 預約資料及收據存於 `booking-data` 資料卷，更新或一般停止容器會保留資料。
不要用 `docker compose down -v`，此指令會刪除資料卷。原有 `data` 資料夾不會自動搬入資料卷。
Windows 重啟後要啟動 Docker Desktop，容器才會自動恢復運作。

### 交給其他 Windows 電腦的安裝包

`release/tutor-booking-windows-x64.zip` 包含已建立的 Linux amd64 Docker image、
`Install.cmd`、`Install.ps1` 及使用說明。解壓後雙擊 `Install.cmd`，允許管理員權限，
填寫管理員密碼及 FPS 收款資料即可啟動，目標電腦不用安裝 Node.js 或自行 build。
如未安裝 Docker Desktop，script 會嘗試用 winget 安裝；首次 Docker/WSL 設定可能需要重啟，
重啟後再執行同一個 script。安裝包會檢查 image 校驗碼、使用獨立資料卷保留預約與收據，
並設定 Docker Desktop 在 Windows 登入時啟動。適用 Docker Desktop 支援的 Windows 10/11 x64，
不適用 Windows Server。

## 功能

- 管理員登入（Bearer session）
- 建立課程與有名額的上課時段
- 日曆查看時段、預約與轉數快收據
- 學生登記；時段已滿時建議其他尚有空位的課程或時段
- 轉數快須先上載 .png 或 .jpeg 收據，收據與預約一併保存
- 學生登記必須填寫公司名稱；只接受轉數快，選擇有效收據後才可提交
- 預約確認及課前出席提醒電郵（Resend，需 `RESEND_API_KEY`）

## 環境變數

複製 `.env.example` 為 `.env`。Resend 的密鑰只放在環境變數，不要提交到 Git。

## Hostinger Web App（GitHub + MySQL）

先建立獨立 MySQL 資料庫，再於 Web App 設定以下環境變數：

```text
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=資料庫全名（包括帳戶前綴）
DB_USER=資料庫用戶全名（包括帳戶前綴）
DB_PASSWORD=資料庫密碼
ADMIN_PASSWORD=至少12字元的管理員密碼
FPS_PAYEE_NAME=收款人名稱
FPS_IDENTIFIER=轉數快識別碼
```

GitHub 部署選擇此項目的部署分支、Node.js 24.x、根目錄 `./`。
安裝依賴用 `npm ci`，啟動用 `npm start`（入口 `server.js`）。
MySQL 模式會自動建立資料表，並將收據二進位資料與登記一併儲存於 MySQL，
不依賴部署目錄保存收據。資料庫憑證只設於 Hostinger，切勿提交到 GitHub。
SQLite/Windows 模式仍使用原有本機資料庫與收據資料夾。
新 MySQL 資料庫不會自動匯入 Render 舊資料；切換前須另行匯出／匯入。
