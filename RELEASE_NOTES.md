# 史料研析台 v0.1.0 未簽名測試版

這是第一個可解壓使用的桌面測試版本。它不包含或連接任何私人文獻庫，也沒有接入第三方古籍資料源；研究者需要自行上傳史料並配置自己的模型服務。

## 下載文件

- `Shiliao-Workbench-v0.1.0-macOS-arm64-unsigned.zip`：Apple Silicon Mac（M1／M2／M3／M4／M5 等）
- `Shiliao-Workbench-v0.1.0-Windows-x64-unsigned.zip`：64 位 Windows 10／11
- `SHA256SUMS.txt`：下載完整性校驗值

## 已包含

- 自然語言研究需求與可修改研究規約
- 多模型供應商及 OpenAI 相容接口
- Token／成本估算
- 自適應樣本試跑與批量完整判讀
- 本機斷點續跑、人工複核與範圍匯出
- Prompt 模板與離線研究項目包

## 測試狀態

- macOS Apple Silicon：已從最終壓縮包解壓並完成正式可執行程序啟動自檢。
- Windows x64：已完成 PE 可執行程序與應用資源結構檢查；仍需要在真實 Windows 電腦上做首次人工測試。
- 正式運行依賴的安全審計沒有發現已知漏洞。

## 已知限制

- 本版本尚未簽名，macOS Gatekeeper 或 Windows SmartScreen 可能顯示安全提醒。
- 應用圖標與自動更新尚未定製。
- PDF、DOCX 仍顯示為待解析，建議先轉為 TXT 或 Markdown。
- 使用者必須自行承擔模型 API 費用，並確認模型供應商的資料政策。
