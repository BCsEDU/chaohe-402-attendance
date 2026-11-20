# 班級出缺席請假與聯絡簿補作業追蹤系統

整合每日出缺席請假（事假、病假、喪假、公假／其他，支援全天／上午／下午）與聯絡簿拆解項目，讓導師一眼掌握每位學生還欠哪些作業或小考未補。

## 核心設計
- **雙模式儲存**：
  - **Supabase 雲端同步**：沿用既有 `xueli-quiz` (`ppdgubracsneozahujxl`) 專案的 `teacher_config` 教師密碼驗證，跨裝置同步（Edge Function `attendance-tracker` 已部署上線）。
  - **本機離線模式**：不連雲端亦可直接使用（資料存於瀏覽器 `localStorage`），並支援以 JSON 備份檔跨機或跨模式搬移。
- **個資安全設計**：
  - 雲端資料表**僅儲存座號（1～45）**，不存學生真實姓名；5 張資料表皆開啟 RLS 並全面拒絕 `anon` / `authenticated` 直接存取，僅透過驗證密碼後的 Edge Function 讀寫。
  - 若想在自己常用的裝置上顯示姓名，可在「⚙️ 班級設定 ＆ 備份」貼上**本機私密座號姓名對照表**（僅存於該瀏覽器 `localStorage`，絕不上傳雲端），上課投影時可按頁首「👁️ 隱藏姓名」一鍵遮蔽。
- **半天請假防誤算與單項豁免**：
  - 聯絡簿支援智慧分行拆解，自動識別「作業／小考／訂簽／純提醒免補」以及時段（「全天／回家」、「上午課堂」、「下午課堂」）。
  - 上午請假會自動略過標記為「下午課堂」的項目；「純提醒事項」自動不列入缺交。
  - 針對任何學生或單項作業，隨時可點選 `待補` / `已交待改` / `完成` / `免補`，也能從「同日略過項目」手動加回待補。

## 檔案結構
- `index.html`：主系統頁面（教師登入、待補總覽、出缺席＆聯絡簿雙欄工作台、假別統計月報、班級設定＆備份）
- `css/styles.css`：響應式樣式表
- `js/config.js`：Supabase 設定與假別／類別常數
- `js/parser.js`：聯絡簿智慧拆解引擎與本機名單解析
- `js/store.js`：雲端／本機雙儲存層、補交連動運算與 CSV／JSON 匯出
- `js/app.js`：前端互動與視圖渲染邏輯
- `supabase/migrations/20261120000001_create_attendance_tracker.sql`：資料庫建表與 RLS 安全設定
- `supabase/functions/attendance-tracker/index.ts`：Supabase Edge Function（已部署至 `ppdgubracsneozahujxl`）

---

## 啟用雲端同步的最後一步（只需執行一次）

由於安全設定限制，DDL 建表需由您在後台執行一次：

1. 開啟 Supabase Dashboard → 專案 `xueli-quiz` (`ppdgubracsneozahujxl`) → **SQL Editor**
2. 貼上並執行 `supabase/migrations/20261120000001_create_attendance_tracker.sql` 內容（或登入網頁後點畫面上的「📋 一鍵複製建表 SQL」）
3. 完成後即可在網頁輸入既有教師密碼登入雲端工作台。

---

## 發布到 GitHub Pages（選用）
```bash
cd "attendance-homework"
git init
git add .
git commit -m "feat: add attendance and contact-book makeup homework tracker"
# 建立 GitHub Repo 後推上 main 並開啟 GitHub Pages
```
