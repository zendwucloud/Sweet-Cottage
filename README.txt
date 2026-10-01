sweet_cottage — 由 SLOT FORGE 打包
引擎原型：消除 · Scatter計數（取自 Cascading_PayAnywhere_6x5）
輸出格式：PixiJS 8.20.1（WebGL）

包含檔案：
- config.js  : 本次編輯生成（符號/權重/賠率/素材檔名）
- engine.js  : 該原型真實引擎邏輯
- gui.js     : 按鈕、音效、選單控制器（與 DOM 版相同）
- index.html : 版面，符號圖檔名已套用新皮
- skin.js    : PixiJS 表現參數（sprite 幀數/時長、中獎特效、噴錢、彩帶），可直接改
- pixi-view.js : PixiJS 繪製程式（轉輪、符號動畫、爆破、噴錢、彩帶）
- pixi.min.mjs : PixiJS 函式庫本體（MIT License），已內附，離線也能跑
- spine-pixi-v8.min.mjs : Spine 官方 PixiJS runtime（4.2），已內附
  ※ Spine Runtime 需自行持有 Spine Editor 授權，散佈前請確認貴公司授權狀態
  ※ 骨架檔（.json/.skel）、.atlas 與其頁面貼圖也已一併打包在這個資料夾
- 49 個素材檔（圖片/影片/音效/動畫 sprite）：已一併打包在這個資料夾內（已啟用「只打包用到的素材」，排除 42 個未引用檔案，省 5.20 MB）

執行：解壓後直接用本機伺服器開這個資料夾裡的 index.html
（ES module 需 http，不能用 file://）。例：python -m http.server