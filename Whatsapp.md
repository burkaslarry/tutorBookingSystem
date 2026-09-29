手機版已改成 **儀表板／預約／新增** 底部 tabs，三個 dashboard 數字也改為同一排顯示。網站仍在 [http://localhost:8000](http://localhost:8000)。


**Google Calendar OAuth 設定步驟**



1. 用專用 Google 帳戶到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案，並啟用 **Google Calendar API**。

2. 設定 OAuth consent screen；測試期間加入要登入授權的 Google 帳戶作為 test user。

3. 建立 **OAuth 2.0 Client ID → Web application**，將 `http://localhost:8000` 加到 Authorized JavaScript origins。正式部署後也要加上正式網址。**不要把 client secret 放在前端程式碼。**

4. 在 Google Calendar 建立專用日曆（例如「AI 課程預約」），複製 Calendar ID；再把指定 Google 電郵地址加入分享，權限設為「查看所有活動詳細資料」。

5. 把 OAuth Client ID、Client Secret 和 Calendar ID 安全交給開發者接入系統。現時系統已改用 SQLite 儲存並支援 `.ics` 匯出；OAuth 即時同步需要收到以上資料後才可完成。Client Secret 只會放在伺服器環境變數，不會放在前端或提交到 Git。



**WhatsApp 草稿**


麻煩幫我準備一個專用 Google 帳戶，供 AI 課程預約系統使用 Google Calendar。請用我能控制的復原電郵／電話，並開啟兩步驗證。


另外請建立 Google Cloud 專案、啟用 Google Calendar API，設定 OAuth consent screen，建立 Web application 的 OAuth Client ID，並把 `http://localhost:8000` 加入 Authorized JavaScript origins。再建立一個「AI 課程預約」Google 日曆，將需要查看的 Google 電郵地址設為唯讀分享。


完成後請把 Google 帳戶地址、OAuth Client ID 和 Calendar ID 交給我。OAuth Client Secret 及登入密碼請用密碼管理器安全分享，**不要透過 WhatsApp 傳送**；系統會用 Google OAuth 授權，不會把 Gmail 密碼寫進程式。
