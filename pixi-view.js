// pixi-view.js — SLOT FORGE 產生的 PixiJS 表現層
// 支援兩種符號動畫來源：sprite 長條圖（點陣，適合材質豐富的效果），或 Spine 骨骼動畫
// （檔案小、不會糊，跟公司美術現有的 Cocos + Spine 產線共用同一份骨架/動畫檔）。
// 兩者共用同一組 startWin()/reset() 介面，config/skin 選哪個符號用哪種即可，上層完全不用管。
// -----------------------------------------------------------------------------
// 分工：engine.js 管「算」（盤面、賠率、免費遊戲），這支只管「畫」：
//   轉輪滾動、落地彈跳、中獎動畫、爆破、掉落補位、噴錢、彩帶。
// PIXI / config / skin 都由 index.html 傳進來，這支檔案本身不 import 任何東西，
// 所以「試玩預覽（Blob 網址）」跟「正式打包（本機檔案）」共用同一份程式，行為一致。
// 版面（轉輪區位置、欄寬、左右位移）不寫死在這裡：直接量 index.html 裡 #grid 的欄位 div，
// 所以美術編輯器的版面微調照樣有效。
// 三款原型共用這一支：盤面大小、列序（由下往上/由上往下）、圖層方式、金幣數值字…都由 skin.js 描述。
// -----------------------------------------------------------------------------

const MAX_TEX = 4096;   // 手機 GPU 常見的單張貼圖上限；超過的 sprite 長條圖會自動切塊上傳
const ATLAS_PAD = 0.08; // 圖集每格四周留 8% 空白，讓「預先模糊」和「預先光暈」不會被裁掉
const BLUR_ON = 0.12;   // 一格畫面移動超過格高的 12% 就換成模糊圖

/* ---------- 緩動曲線（跟 DOM 版 CSS 用同一組 cubic-bezier，手感一致） ---------- */
function cubicBezier(x1, y1, x2, y2) {
    const bx = t => 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t;
    const by = t => 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
    return x => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let lo = 0, hi = 1, t = x;
        for (let i = 0; i < 22; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
        return by(t);
    };
}
const EASE = {
    linear: t => t,
    easeOut: cubicBezier(0, 0, 0.58, 1),
    easeInOut: cubicBezier(0.42, 0, 0.58, 1),
    reel: cubicBezier(0.45, 0.05, 0.55, 0.95), // DOM 版 .reel-strip.moving
    drop: cubicBezier(0.5, 0, 0.2, 1.3),       // DOM 版掉落補位（尾端微回彈）
    css: cubicBezier(0.25, 0.1, 0.25, 1),      // CSS 預設的 ease（Hold&Win 單格重轉）
    pop: cubicBezier(0.175, 0.885, 0.32, 1.275) // 金幣數字彈出
};
// Hold&Win 的「廢牌變暗」：等同 CSS filter: brightness(b) grayscale(g)，t=0~1 做淡入淡出
function dimMatrix(t, D) {
    const k = 1 - D.grayscale * t, b = 1 - (1 - D.brightness) * t;
    const m = [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k,
               0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k,
               0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k];
    return [m[0] * b, m[1] * b, m[2] * b, 0, 0, m[3] * b, m[4] * b, m[5] * b, 0, 0, m[6] * b, m[7] * b, m[8] * b, 0, 0, 0, 0, 0, 1, 0];
}
// 多段關鍵格：frames = [[進度, 值], ...]，每一段各自套 ease（CSS keyframes 的行為）
function keyframes(frames, ease) {
    return p => {
        for (let i = 1; i < frames.length; i++) {
            const [t0, v0] = frames[i - 1], [t1, v1] = frames[i];
            if (p <= t1) { const k = (p - t0) / ((t1 - t0) || 1); return v0 + (v1 - v0) * ease(k); }
        }
        return frames[frames.length - 1][1];
    };
}
const LAND_BOUNCE = keyframes([[0, -0.075], [0.5, 0.06], [0.75, -0.02], [1, 0]], EASE.easeOut);

/* ---------- 小工具 ---------- */
let _clr = null;
function parseColor(css, fallback) {
    // 用瀏覽器自己解析任何合法 CSS 顏色（gold / #fff / rgb() / rgba()），回傳 0~1 的 rgb 與 alpha
    try {
        if (!_clr) _clr = document.createElement('canvas').getContext('2d');
        _clr.fillStyle = '#000'; _clr.fillStyle = css || fallback || '#ffd700';
        const v = _clr.fillStyle;
        if (v[0] === '#') return { rgb: [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255), a: 1 };
        const p = v.slice(v.indexOf('(') + 1, v.indexOf(')')).split(',').map(parseFloat);
        return { rgb: [p[0] / 255, p[1] / 255, p[2] / 255], a: p.length > 3 ? p[3] : 1 };
    } catch (e) { return { rgb: [1, 0.84, 0], a: 1 }; }
}
function loadImage(src) {
    return new Promise(resolve => {
        if (!src) return resolve(null);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { console.warn('[pixi-view] 找不到素材：', src); resolve(null); };
        img.src = src;
    });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function loadText(src) {
    if (!src) return null;
    try { const r = await fetch(src); return r.ok ? await r.text() : null; }
    catch (e) { console.warn('[pixi-view] 讀取失敗：', src); return null; }
}
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
// 物件可能被回收後再利用，所以動畫要連「第幾次使用」一起比對，
// 免得上一輪殘留的動畫跑到重新啟用的同一個物件身上。
const aliveFn = v => { const g = v.gen; return () => !v.dead && v.gen === g; };

// 貨架式排版：把大小不一的圖塞進一張方形貼圖。回傳實際用到的寬高，塞不下回傳 null。
function shelfPack(items, max) {
    items.sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0, W = 0;
    for (const it of items) {
        if (x + it.w > max) { x = 0; y += rowH; rowH = 0; }
        if (y + it.h > max) return null;
        it.x = x; it.y = y; x += it.w;
        rowH = Math.max(rowH, it.h); W = Math.max(W, x);
    }
    return { w: W, h: y + rowH };
}
// 垂直方向的模糊：轉輪是上下滾動，只糊 Y 軸才像真的動態模糊（也比等向模糊便宜）
function drawMotionBlur(ctx, img, x, y, w, h, spread) {
    const N = 9;
    ctx.save();
    // 一般的「疊加」是每畫一次就跟底下混合一次，疊 N 次的不透明度只會逼近 1 但到不了 1
    // （疊 9 次大約只有 65%），符號中間會透出背景。改用「相加」疊加，透明度才會正確加到 100%。
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1 / N;
    for (let i = 0; i < N; i++) ctx.drawImage(img, x, y - spread + (2 * spread * i) / (N - 1), w, h);
    ctx.restore();
}
// 預先做好的光暈：把圖轉成單色剪影再模糊，等同 CSS drop-shadow(0 0 Npx color)
function drawGlow(ctx, img, x, y, w, h, color, blurPx) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w)); cv.height = Math.max(1, Math.ceil(h));
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(cv, x, y, w, h);
    ctx.restore();
}
function canvasBlurSupported() {
    try {
        const c = document.createElement('canvas').getContext('2d');
        c.filter = 'blur(2px)';
        return c.filter !== 'none' && c.filter !== '';
    } catch (e) { return false; }
}

/* =============================================================================
   PixiSlot：素材載入、兩個 Pixi 畫布（轉輪／噴錢）的總管
   ============================================================================= */
class PixiSlot {
    constructor(PIXI, config, skin, Spine) {
        this.PIXI = PIXI;
        this.SpineNS = Spine || null; // spine-pixi-v8 模組（TextureAtlas / AtlasAttachmentLoader / SkeletonJson / SkeletonBinary / Spine）
        this.plateTex = {};          // 底板圖的貼圖：檔名 -> Texture
        this.spineData = {};          // 快取：'skeleton.json|atlas.atlas' -> Spine SkeletonData（同一份骨架多顆符號共用時不用重讀）
        this.config = config;
        this.skin = skin || {};
        this.rows = config.mechanics.rows;
        this.cols = config.mechanics.cols;
        this.T = Object.assign({
            reelDelay: 300, spin: 2000, spinTurbo: 1000, fillers: 18, stopPause: 100,
            landBounce: 300, refill: 400, explode: 400, pulse: 1.0, pop: 0.8,
            cellSpin: 2000, cellSpinRand: 800, cellSpinTurbo: 300, cellFillers: 15, cellFillersTurbo: 4, cellCoinChance: 0.1
        }, this.skin.timing || {});
        this.rowOrder = this.skin.rowOrder === 'topDown' ? 'topDown' : 'bottomUp'; // row 0 在最下排（消除類）或最上排（連線類）
        this.layering = this.skin.layering === 'global' ? 'global' : 'column';    // column：每欄一層（DOM 版 .column 有 z-index）；global：整盤共用一層
        this.staticTex = {};   // id -> Texture（靜態符號，來自圖集）
        this.blurTex = {};     // id -> Texture（預先模糊，轉輪滾動時用）
        this.glowTex = {};     // id -> Texture（預先光暈，取代即時濾鏡）
        this.dimTex = {};      // id -> Texture（預先變暗，Hold&Win 重轉時的廢牌）
        this.spriteFrames = {}; // id -> { frames:[Texture], dur, loop }
        this.atlas = null;     // { source, size }，方便除錯與回報
        this.explosion = null;  // { frames, dur }
        this.coinTex = null;
    }

    // 骨架資料是以「骨架檔|atlas 檔」為鍵（同一份骨架可以給多顆符號共用），
    // 這裡把符號 id 轉成對應的骨架資料；沒設定或載入失敗都回 null，上層就自動退回靜態圖。
    spineFor(id) {
        const d = this.skin.symbols && this.skin.symbols[id] && this.skin.symbols[id].spine;
        if (!d) return null;
        return this.spineData[d.skeleton + '|' + d.atlas] || null;
    }

    symDef(id) {
        const d = (this.skin.symbols && this.skin.symbols[id]) || {};
        return {
            win: d.win || 'pulse',
            widthScale: d.widthScale || 1,
            glow: d.glow || null,
            z: d.z || 10,
            zActive: d.zActive || 900,
            zWin: d.zWin || 300,
            period: d.period || 0,            // 中獎縮放一個來回的秒數（0 = 用 timing.pulse）
            fit: d.fit || 'stretch',          // stretch：拉滿格子；contain：保持比例
            alignY: d.alignY || 'center',
            offsetX: d.offsetX || 0,          // 以欄寬為單位的水平位移
            dimExempt: !!d.dimExempt,         // Hold&Win 變暗時不受影響（金幣）
            blank: !!d.blank || id === 99,    // Hold&Win 預留的空白格
            hasSprite: !!d.sprite || !!d.spriteStub,
            spine: this.spineFor(id) ? d.spine : null // 骨架讀取失敗時自動退回靜態圖，不會整格空白
        };
    }

    texFromImage(img) {
        const { PIXI } = this;
        if (img.naturalWidth <= MAX_TEX && img.naturalHeight <= MAX_TEX) return PIXI.Texture.from(img);
        const s = Math.min(MAX_TEX / img.naturalWidth, MAX_TEX / img.naturalHeight);
        const cv = document.createElement('canvas');
        cv.width = Math.floor(img.naturalWidth * s); cv.height = Math.floor(img.naturalHeight * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return PIXI.Texture.from(cv);
    }

    // 把 sprite sheet 切成一幀一幀的 Texture。
    // 預設是「橫向一排」（跟 DOM 版 background-size: N00% 同一種圖）；
    // 若動畫編輯器填了單幀寬高、而且圖其實是多排的格狀 sheet，就照格子切。
    // 圖寬超過 GPU 上限（例如 28 幀 × 256px = 7168px）時，自動重新排進多張 ≤4096 的貼圖。
    // 符號在這台裝置上實際會畫多大（像素）。sprite 長條圖比這個大的部分是浪費，
    // 解壓後會佔掉好幾倍的顯示卡記憶體，上傳也更久。
    targetFrameH() {
        const rect = this.gridEl ? this.gridEl.getBoundingClientRect() : null;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        return rect && rect.height ? (rect.height / this.rows) * dpr * 1.25 : 512;
    }

    sliceSheet(img, tun) {
        const { PIXI } = this;
        const n = Math.max(1, Math.round(tun.frames || 1));
        const W = img.naturalWidth, H = img.naturalHeight;
        let cols = n, fw = W / n, fh = H;
        if (tun.frameW && tun.frameH) {
            const c = Math.floor(W / tun.frameW), r = Math.floor(H / tun.frameH);
            if (r > 1 && c >= 1 && c * r >= n) { cols = c; fw = tun.frameW; fh = tun.frameH; }
        }
        const src = i => [(i % cols) * fw, Math.floor(i / cols) * fh];
        const frames = [];
        const shrink = this.skin.atlas === false ? 1 : Math.min(1, this.targetFrameH() / fh);
        if (W <= MAX_TEX && H <= MAX_TEX && shrink > 0.95) {
            const base = PIXI.Texture.from(img).source;
            for (let i = 0; i < n; i++) {
                const [x, y] = src(i);
                frames.push(new PIXI.Texture({ source: base, frame: new PIXI.Rectangle(x, y, fw, fh) }));
            }
            return frames;
        }
        const k = Math.min(shrink, MAX_TEX / fw, MAX_TEX / fh);
        const cw = Math.max(1, Math.floor(fw * k)), ch = Math.max(1, Math.floor(fh * k));
        const perRow = Math.max(1, Math.floor(MAX_TEX / cw));
        const perChunk = perRow * Math.max(1, Math.floor(MAX_TEX / ch));
        for (let start = 0; start < n; start += perChunk) {
            const cnt = Math.min(perChunk, n - start);
            const cv = document.createElement('canvas');
            cv.width = Math.min(cnt, perRow) * cw; cv.height = Math.ceil(cnt / perRow) * ch;
            const ctx = cv.getContext('2d');
            for (let j = 0; j < cnt; j++) {
                const [sx, sy] = src(start + j);
                ctx.drawImage(img, sx, sy, fw, fh, (j % perRow) * cw, Math.floor(j / perRow) * ch, cw, ch);
            }
            const base = PIXI.Texture.from(cv).source;
            for (let j = 0; j < cnt; j++) {
                frames.push(new PIXI.Texture({ source: base, frame: new PIXI.Rectangle((j % perRow) * cw, Math.floor(j / perRow) * ch, cw, ch) }));
            }
        }
        return frames;
    }

    // 素材缺圖時的替代圖：畫一張帶符號編號的色塊，遊戲照樣能跑、一眼看出缺哪張
    placeholder(label, color) {
        const { PIXI } = this;
        const c = new PIXI.Container();
        c.addChild(new PIXI.Graphics().roundRect(0, 0, 200, 300, 28).fill({ color, alpha: 0.92 }).stroke({ width: 6, color: 0xffffff }));
        const t = new PIXI.Text({ text: String(label), style: { fill: 0xffffff, fontSize: 60, fontWeight: '900', fontFamily: 'Arial Black, Arial', stroke: { color: 0x000000, width: 6 } } });
        t.anchor.set(0.5); t.position.set(100, 150); c.addChild(t);
        const tex = this.reelApp.renderer.generateTexture({ target: c, resolution: 1 });
        c.destroy({ children: true });
        return tex;
    }

    // 所有靜態符號打包成「一張」貼圖（圖集）。同一張貼圖的東西 GPU 可以合併送出，
    // 轉輪滾動時的繪製指令從上百次降到個位數，這是手機順不順的關鍵。
    // 同一張圖集裡順便放進「預先模糊」與「預先光暈」版本，這樣連濾鏡都不用開。
    buildSymbolAtlas(ids, imgs) {
        const { PIXI } = this;
        const have = ids.filter(id => imgs[id]);
        if (!have.length) return false;

        // 依照這台裝置上符號實際會顯示多大來決定圖集解析度（不放大，只縮小）
        const rect = this.gridEl ? this.gridEl.getBoundingClientRect() : null;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetH = rect && rect.height ? (rect.height / this.rows) * dpr * 1.25 : 512;
        const glowOK = canvasBlurSupported();

        const build = (quality) => {
            const items = [];
            have.forEach(id => {
                const img = imgs[id];
                const sc = Math.min(1, (targetH * quality) / img.naturalHeight);
                const w = Math.max(1, Math.round(img.naturalWidth * sc));
                const h = Math.max(1, Math.round(img.naturalHeight * sc));
                const px = Math.round(w * ATLAS_PAD), py = Math.round(h * ATLAS_PAD);
                const cw = w + px * 2, ch = h + py * 2;
                const def = this.symDef(id);
                const D = this.skin.dim;
                items.push({ id, kind: 'base', img, w: cw, h: ch, iw: w, ih: h, px, py });
                items.push({ id, kind: 'blur', img, w: cw, h: ch, iw: w, ih: h, px, py, spread: Math.max(2, h * 0.06) });
                if (def.glow && glowOK) items.push({ id, kind: 'glow', img, w: cw, h: ch, iw: w, ih: h, px, py, color: def.glow.color, blurPx: Math.max(1, def.glow.blur) });
                if (D && glowOK && !def.dimExempt) items.push({ id, kind: 'dim', img, w: cw, h: ch, iw: w, ih: h, px, py, css: `brightness(${D.brightness}) grayscale(${D.grayscale}) blur(${Math.max(0.5, D.blur)}px)` });
            });
            for (const max of [2048, MAX_TEX]) {
                const fit = shelfPack(items, max);
                if (fit) return { items, fit };
            }
            return null;
        };

        let packed = build(1) || build(0.7) || build(0.45);
        if (!packed) return false;

        const cv = document.createElement('canvas');
        cv.width = packed.fit.w; cv.height = packed.fit.h;
        const ctx = cv.getContext('2d');
        packed.items.forEach(it => {
            const x = it.x + it.px, y = it.y + it.py;
            if (it.kind === 'base') ctx.drawImage(it.img, x, y, it.iw, it.ih);
            else if (it.kind === 'blur') drawMotionBlur(ctx, it.img, x, y, it.iw, it.ih, it.spread);
            else if (it.kind === 'glow') drawGlow(ctx, it.img, x, y, it.iw, it.ih, it.color, it.blurPx);
            else { ctx.save(); ctx.filter = it.css; ctx.drawImage(it.img, x, y, it.iw, it.ih); ctx.restore(); }
        });

        const source = PIXI.Texture.from(cv).source;
        source.label = 'symbol-atlas';
        packed.items.forEach(it => {
            const tex = new PIXI.Texture({ source, frame: new PIXI.Rectangle(it.x, it.y, it.w, it.h) });
            tex._pad = ATLAS_PAD; // 顯示時要把留白算回去，符號才不會縮小
            if (it.kind === 'base') this.staticTex[it.id] = tex;
            else if (it.kind === 'blur') this.blurTex[it.id] = tex;
            else if (it.kind === 'glow') this.glowTex[it.id] = tex;
            else this.dimTex[it.id] = tex;
        });
        this.atlas = { source, size: `${cv.width}x${cv.height}`, count: packed.items.length };
        return true;
    }

    async loadTextures(report) {
        const ids = Object.keys(this.config.symbols).map(Number);
        const imgs = this.config.assets.images.symbols || {};
        const palette = [0xc0392b, 0xe67e22, 0xf1c40f, 0x27ae60, 0x2980b9, 0x8e44ad, 0xd35400, 0x7f8c8d, 0x34495e];
        const loaded = {};
        let done = 0;
        const total = ids.length + 2;
        const step = () => report && report(++done / total, '載入素材');
        await Promise.all(ids.map(async id => {
            loaded[id] = await loadImage(imgs[id]);
            const sp = this.skin.symbols && this.skin.symbols[id] && this.skin.symbols[id].sprite;
            if (sp && sp.src) {
                const sImg = await loadImage(sp.src);
                if (sImg) this.spriteFrames[id] = { frames: this.sliceSheet(sImg, sp), dur: sp.dur || 1.5, loop: sp.loop !== false };
            }
            step();
        }));

        if (this.skin.atlas !== false) this.buildSymbolAtlas(ids, loaded);
        // 沒有進圖集的（缺圖、或關掉圖集）照舊各自一張貼圖
        ids.forEach(id => {
            if (this.staticTex[id]) return;
            this.staticTex[id] = loaded[id] ? this.texFromImage(loaded[id]) : this.placeholder(id, palette[id % palette.length]);
        });

        const ex = this.skin.explosion;
        if (ex && ex.src) {
            const img = await loadImage(ex.src);
            if (img) this.explosion = { frames: this.sliceSheet(img, ex), dur: ex.dur || 0.5, size: ex.size || 1.38, offsetX: ex.offsetX ?? -0.08 };
        }
        step();
        await this.loadSpineSkeletons(ids);
        const coinImg = await loadImage(this.skin.effects && this.skin.effects.coinImg);
        if (coinImg) this.coinTex = this.texFromImage(coinImg);
        else {
            const g = new this.PIXI.Graphics().circle(48, 48, 44).fill(0xffd700).stroke({ width: 6, color: 0xb8860b });
            this.coinTex = this.reelApp.renderer.generateTexture({ target: g, resolution: 1 });
            g.destroy();
        }
        step();
    }

    // 讀進來的圖還要「送進顯示卡」才算真的準備好。瀏覽器預設會拖到那張圖第一次出現在
    // 畫面上才送，所以 sprite 長條圖（解壓後往往好幾 MB）會在第一次播動畫的瞬間卡一下。
    // 這裡在載入階段就全部送完，順便把濾鏡和文字的著色器先編譯好。
    async warmUp(report) {
        const r = this.reelApp.renderer;
        const srcs = new Set();
        const add = t => { if (t && t.source) srcs.add(t.source); };
        [this.staticTex, this.blurTex, this.glowTex, this.dimTex].forEach(m => Object.values(m).forEach(add));
        Object.values(this.spriteFrames).forEach(f => f.frames.forEach(add));
        if (this.explosion) this.explosion.frames.forEach(add);
        add(this.coinTex); add(this.radialTexture());
        const list = [...srcs];
        for (let i = 0; i < list.length; i++) {
            try { r.texture.initSource(list[i]); } catch (e) { /* 舊版或 Canvas 後端沒有這個方法，忽略 */ }
            if (report) report(i / Math.max(1, list.length), '準備貼圖');
            if (i % 3 === 2) await nextFrame(); // 讓出一格畫面，進度條才動得起來
        }
        this.compileShaders();
        this.warmUpSpine();
        // 噴錢是另一塊畫布、另一個顯示卡環境，貼圖要在那邊各自再送一次，
        // 否則第一次噴錢時才傳，一樣會頓。
        try {
            const fr = this.fxApp.renderer;
            [this.coinTex, this.radialTexture()].forEach(t => { try { fr.texture.initSource(t.source); } catch (e) {} });
            this.fx.fire(6, 0.5); this.fx.spawnConfetti();
            fr.render(this.fxApp.stage);
            this.fx.reset();
        } catch (e) {}
        if (this.reels) this.reels.prewarm();
        if (report) report(1, '準備貼圖');
        await nextFrame();
    }

    // 每種會用到 Spine 的符號先建一顆、播一幀、丟掉：這樣把骨架轉頂點、GPU 貼圖上傳、
    // Spine 專用的繪製流程（SpinePipe）都在載入階段就跑過一次，真正上場時就不用臨時做。
    warmUpSpine() {
        if (!this.SpineNS) return;
        Object.keys(this.spineData).forEach(key => {
            try {
                const spine = new this.SpineNS.Spine({ skeletonData: this.spineData[key] });
                spine.position.set(-9999, -9999);
                this.reelApp.stage.addChild(spine);
                spine.state.update(0.016); spine.state.apply(spine.skeleton);
                spine.skeleton.updateWorldTransform(0);
                this.reelApp.renderer.render(this.reelApp.stage);
                this.reelApp.stage.removeChild(spine);
                spine.destroy();
            } catch (e) { /* 預熱失敗不影響遊戲，正式使用時會再試一次 */ }
        });
    }

    // 先畫一次「用得到濾鏡和文字」的畫面，讓著色器在載入階段就編譯完成。
    // 不這樣做的話，第一次爆破或第一次顯示金幣數字時會停頓一下。
    compileShaders() {
        const { PIXI } = this;
        try {
            const probe = new PIXI.Container();
            probe.position.set(-9999, -9999);
            const tex = this.staticTex[Object.keys(this.staticTex)[0]] || PIXI.Texture.WHITE;
            const rect = this.gridEl ? this.gridEl.getBoundingClientRect() : null;
            const cw = rect && rect.height ? rect.width / this.cols : 120;
            const ch = rect && rect.height ? rect.height / this.rows : 180;
            const b = new PIXI.Sprite(tex); b.mask = new PIXI.Graphics().rect(-9999, -9999, 50, 50).fill(0xffffff);
            const t = new PIXI.Text({ text: '0', style: this.coinTextStyle() });
            probe.addChild(b.mask, b, t);
            this.reelApp.stage.addChild(probe);
            // 爆破過程中符號會放大到兩倍、模糊也跟著變強，每一種大小都會用到一塊新的暫存畫布。
            // 先照幾個代表性的大小各畫一次，消除中獎連消第三、四輪才冒出來的零星頓點。
            [1, 1.4, 1.7, 2].forEach(k => {
                const a = new PIXI.Sprite(tex);
                a.width = cw * k; a.height = ch * k;
                a.filters = [new PIXI.ColorMatrixFilter(), new PIXI.BlurFilter({ strength: 4 * (k - 1) + 0.5, quality: 2 })];
                probe.addChild(a);
                this.reelApp.renderer.render(this.reelApp.stage);
                probe.removeChild(a); a.destroy();
            });
            this.reelApp.stage.removeChild(probe);
            probe.destroy({ children: true });
        } catch (e) { /* 編譯預熱失敗不影響遊戲 */ }
    }

    // 讀取每顆用 Spine 的符號需要的骨架資料。完全不透過 PIXI.Assets 讀取，自己解析文字/圖片，
    // 因為試玩預覽用的是沒有副檔名的 blob 網址，PIXI.Assets 認副檔名選讀取器會直接失敗。
    async loadSpineSkeletons(ids) {
        const NS = this.SpineNS; if (!NS) return;
        const { TextureAtlas, AtlasAttachmentLoader, SkeletonJson, SkeletonBinary, SpineTexture } = NS;
        for (const id of ids) {
            const sp = this.skin.symbols && this.skin.symbols[id] && this.skin.symbols[id].spine;
            if (!sp || !sp.skeleton || !sp.atlas) continue;
            if (sp.plate && !this.plateTex[sp.plate]) {
                try { const pim = await loadImage(sp.plate); if (pim) this.plateTex[sp.plate] = this.texFromImage(pim); }
                catch (e) { console.warn('[pixi-view] 底板圖讀取失敗：', sp.plate, e.message || e); }
            }
            const key = sp.skeleton + '|' + sp.atlas;
            if (this.spineData[key]) continue;
            try {
                const atlasText = await loadText(sp.atlas);
                if (!atlasText) throw new Error('讀不到 atlas：' + sp.atlas);
                const atlas = new TextureAtlas(atlasText);
                // atlas 檔裡每一頁記的是「檔名」，跟 config 給的頁面圖網址一一對應（通常只有一頁）
                const pageUrls = sp.pages && Object.keys(sp.pages).length ? sp.pages
                    : Object.fromEntries(atlas.pages.map((pg, i) => [pg.name, (sp.images || [])[i] || sp.images]));
                await Promise.all(atlas.pages.map(async pg => {
                    const url = pageUrls[pg.name] || pageUrls[Object.keys(pageUrls)[0]];
                    const img = await loadImage(url);
                    if (!img) throw new Error('讀不到 Spine 頁面貼圖：' + pg.name);
                    pg.setTexture(SpineTexture.from(this.texFromImage(img).source));
                }));
                const isBinary = /\.skel$/i.test(sp.skeleton);
                let skeletonData;
                if (isBinary) {
                    const r = await fetch(sp.skeleton); const bytes = new Uint8Array(await r.arrayBuffer());
                    skeletonData = new SkeletonBinary(new AtlasAttachmentLoader(atlas)).readSkeletonData(bytes);
                } else {
                    const jsonText = await loadText(sp.skeleton);
                    if (!jsonText) throw new Error('讀不到骨架檔：' + sp.skeleton);
                    skeletonData = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(jsonText);
                }
                this.spineData[key] = skeletonData;
            } catch (e) {
                console.warn('[pixi-view] Spine 骨架載入失敗，符號 ' + id + ' 改用靜態圖：', e.message || e);
            }
        }
    }

    async makeApp(host) {
        const app = new this.PIXI.Application();
        await app.init({
            width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight),
            backgroundAlpha: 0, antialias: true, autoDensity: true,
            resolution: Math.min(window.devicePixelRatio || 1, 2),
            preference: 'webgl', powerPreference: 'high-performance'
        });
        host.appendChild(app.canvas);
        return app;
    }

    // 金幣數值字樣式：字級用 vh（跟 DOM 版 CSS 一樣以視窗高度為準），彩金用霓虹光暈
    coinTextStyle(kind) {
        const ct = this.skin.coinText || {};
        const base = Object.assign({ font: 'Arial Black, Arial, sans-serif', size: 2.2, fill: '#ffffff', glow: null }, ct.number || {});
        const k = (kind && ct[kind]) ? Object.assign({}, base, ct[kind]) : base;
        const px = Math.max(8, k.size * window.innerHeight / 100);
        return {
            fontFamily: k.font, fontSize: px, fontWeight: '900', fill: k.fill, align: 'center',
            stroke: { color: '#000000', width: Math.max(2, px * 0.16), join: 'round' },
            dropShadow: k.glow
                ? { color: k.glow, blur: px * 0.7, distance: 0, angle: 0, alpha: 1 }
                : { color: '#000000', blur: px * 0.25, distance: px * 0.09, angle: Math.PI / 2, alpha: 0.8 }
        };
    }
    radialTexture() {
        if (this._radial) return this._radial;
        const cv = document.createElement('canvas'); cv.width = cv.height = 128;
        const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        return (this._radial = this.PIXI.Texture.from(cv));
    }
    tex(type) { return this.staticTex[type] || this.PIXI.Texture.EMPTY; }

    async init(reelHost, gridEl, fxHost, onProgress) {
        this.gridEl = gridEl; // 先記起來：打包圖集時要知道符號實際顯示多大
        // 進度分兩段：讀檔 0~70%，送進顯示卡 70~100%
        const report = onProgress ? (p, label) => onProgress(Math.max(0, Math.min(1, p)), label) : null;
        this.reelApp = await this.makeApp(reelHost);
        this.fxApp = await this.makeApp(fxHost);
        await this.loadTextures(report ? (p, l) => report(p * 0.7, l) : null);
        this.reels = new ReelsView(this, reelHost, gridEl);
        this.fx = new FxLayer(this, fxHost);
        await this.warmUp(report ? (p, l) => report(0.7 + p * 0.3, l) : null);
    }
}

/* =============================================================================
   SymbolView：單一符號（主圖 + 可選的光暈層），自己管中獎/爆破/彈跳的動畫狀態
   ============================================================================= */
class SymbolView {
    constructor(slot, type) {
        const { PIXI } = slot;
        this.slot = slot; this.type = type; this.def = slot.symDef(type);
        this.gen = 0; this.dead = false;
        this.root = new PIXI.Container();
        this.glow = null;
        this.main = new PIXI.Sprite(slot.tex(type));
        this.main.anchor.set(0.5);
        if (this.def.blank) this.main.visible = false;
        this.root.addChild(this.main);
        this.spineObj = null; this.plate = null; this.spineFit = 1; this.spineCX = 0; this.spineCY = 0;
        this.valueText = null; this.valueKind = null;
        if (this.def.spine) this.setupSpine();
        this.slotY = 0;     // 以「格」為單位，0 = 最上排的中心往上半格
        this.offsetY = 0;   // 以「格」為單位的額外位移（彈跳、掉落用）
        this.w = 0; this.h = 0;
        this.cm = null;
        this.reset();
    }

    reset() {
        this.mode = 'idle'; this.t = 0; this.winTag = null;
        this.frames = null; this.frameIdx = -1;
        this.root.scale.set(1); this.root.alpha = 1; this.root.filters = null;
        this.offsetY = 0; this.motion = false;
        this.root.zIndex = this.def.z;
        this.dimmed = this.slot.reels && this.slot.reels.dimBaked && !this.def.dimExempt;
        if (this.def.spine) {
            this.main.visible = false; this.hideGlow();
            if (this.spineObj) { this.spineObj.visible = true; this.playSpine(this.def.spine.idle || 'idle', true); }
        } else {
            if (this.spineObj) this.spineObj.visible = false;
            this.setTexture(this.slot.tex(this.type));
            if (this.bright) this.bright.visible = false;
            this.setBright(1);
            if (this.def.glow && !this.def.blank && !this.dimmed) this.showGlow(this.def.glow.color, this.def.glow.blur, 1);
            else this.hideGlow();
            this.refreshVariant();
        }
    }

    /* ---------- Spine 骨骼動畫 ---------- */
    setupSpine() {
        const { PIXI } = this.slot, skeletonData = this.slot.spineFor(this.type);
        if (!skeletonData) return;
        this.spineObj = new this.slot.SpineNS.Spine({ skeletonData });
        this.root.addChild(this.spineObj);
        // 底板：畫在 Spine 後面，大小對齊格子（跟靜態符號的底磚一樣），不隨 Spine 縮放與動畫
        const plateTex = this.def.spine && this.def.spine.plate && this.slot.plateTex[this.def.spine.plate];
        if (plateTex) { this.plate = new PIXI.Sprite(plateTex); this.plate.anchor.set(0.5); this.root.addChildAt(this.plate, 0); }
        // 骨架的座標系統跟畫面沒有固定比例，量一次 setup pose 的範圍，算出「貼滿格子要縮多少」，
        // 之後就只調 root 的位置，spineObj 本身的 scale 維持這個換算值不再變動。
        this.spineObj.skeleton.setToSetupPose();
        this.spineObj.state.update(0); this.spineObj.state.apply(this.spineObj.skeleton);
        this.spineObj.skeleton.updateWorldTransform(0);
        // getBounds() 回傳世界座標：回收再用的符號 root 還留著上一次的位置，不先歸零會把那段位移算進骨架中心（符號整個往左偏、看起來像空格）
        const rx = this.root.x, ry = this.root.y, rsc = this.root.scale.x;
        this.root.position.set(0, 0); this.root.scale.set(1);
        const b = this.spineObj.getBounds();
        this.root.position.set(rx, ry); this.root.scale.set(rsc);
        this.spineCX = b.x + b.width / 2; this.spineCY = b.y + b.height / 2;
        this._spineNatW = Math.max(1, b.width); this._spineNatH = Math.max(1, b.height);
        this.playSpine(this.def.spine.idle || 'idle', true);
    }
    playSpine(name, loop) {
        if (!this.spineObj || !name) return;
        const data = this.slot.spineFor(this.type);
        if (!data || !data.findAnimation(name)) return; // 找不到這個動作名稱就維持原狀，不整格消失
        this.spineObj.state.setAnimation(0, name, !!loop);
    }
    sizeSpine() {
        if (!this.spineObj || !this.w) return;
        if (this.plate) { this.plate.width = this.w; this.plate.height = this.h; }
        const scale = (this.def.spine.scale || 1) * Math.min(this.w / this._spineNatW, this.h / this._spineNatH);
        this.spineObj.scale.set(scale);
        this.spineObj.x = -this.spineCX * scale; this.spineObj.y = -this.spineCY * scale;
    }

    ensureGlowSprite() {
        const { PIXI } = this.slot;
        if (this.glow) return;
        this.glow = new PIXI.Sprite(this.main.texture);
        this.glow.anchor.set(0.5);
        this.root.addChildAt(this.glow, 0);
    }
    // 光暈優先用圖集裡「預先做好」的那張：不用開濾鏡，手機上便宜非常多。
    // 只有播 sprite 動畫（每格圖都不同，沒辦法預先做）時才退回即時濾鏡。
    showGlow(color, blur, alpha) {
        const { PIXI } = this.slot;
        this.ensureGlowSprite();
        const pre = this.slot.glowTex[this.type];
        if (pre && !this.frames) {
            if (this._glowKey !== 'pre') { this.glow.filters = null; this._glowKey = 'pre'; }
            this.glow.texture = pre;
            this.glow.visible = true; this.glow.alpha = alpha;
            this.applySize();
            return;
        }
        const c = parseColor(color);
        const key = color + '|' + blur;
        if (this._glowKey !== key) {
            const cm = new PIXI.ColorMatrixFilter();
            cm.matrix = [0, 0, 0, 0, c.rgb[0], 0, 0, 0, 0, c.rgb[1], 0, 0, 0, 0, c.rgb[2], 0, 0, 0, c.a, 0];
            this.glow.filters = [cm, new PIXI.BlurFilter({ strength: Math.max(1, blur), quality: 3 })];
            this._glowKey = key;
        }
        this.glow.texture = this.main.texture;
        this.glow.visible = true; this.glow.alpha = alpha;
        this.applySize();
    }
    hideGlow() { if (this.glow) { this.glow.visible = false; } }

    // 變亮不用濾鏡：把同一張圖用「加亮」方式再疊一次就好。
    // 濾鏡會讓 Pixi 每格畫面配置一塊暫存畫布，而中獎時符號是一邊縮放一邊變亮的，
    // 尺寸每格都在變 → 每格都要配置新的暫存畫布，這正是連消到第三、四輪冒出零星頓點的原因。
    setBright(v) {
        const over = v - 1;
        if (over <= 0.001) { if (this.bright) this.bright.visible = false; return; }
        if (!this.bright) {
            const { PIXI } = this.slot;
            this.bright = new PIXI.Sprite(this.main.texture);
            this.bright.anchor.set(0.5);
            this.bright.blendMode = 'add';
            this.root.addChildAt(this.bright, this.root.getChildIndex(this.main) + 1);
        }
        this.bright.texture = this.main.texture;
        this.bright.visible = true;
        this.bright.alpha = Math.min(1, over * 0.85);
        this.sizeSprite(this.bright);
    }
    setTexture(tex) {
        this.main.texture = tex;
        if (this.glow && this._glowKey !== 'pre') this.glow.texture = tex;
        this.applySize();
    }
    // 同一顆符號在圖集裡有四種版本：清晰／滾動模糊／變暗／光暈。
    // 換版本只是換同一張圖集上的一塊區域，不會打斷 GPU 的合併繪製，也不用開任何濾鏡。
    refreshVariant() {
        if (this.frames) return; // 正在播 sprite 動畫，交給動畫自己換圖
        const S = this.slot;
        const tex = (this.dimmed && S.dimTex[this.type]) || (this.motion && S.blurTex[this.type]) || S.staticTex[this.type];
        if (!tex || this.main.texture === tex) return;
        this.main.texture = tex;
        if (this.glow && this._glowKey !== 'pre') this.glow.texture = tex;
        this.applySize();
    }
    setMotion(on) { if (this.motion !== on) { this.motion = on; this.refreshVariant(); } }
    setDimmed(on) {
        if (this.def.dimExempt || this.dimmed === on) return;
        this.dimmed = on;
        if (this.glow) this.glow.visible = !on && !!this.def.glow; // 變暗的廢牌不該還在發光
        this.refreshVariant();
    }
    setSize(cellW, cellH) { this.w = cellW * this.def.widthScale; this.h = cellH; this.applySize(); }
    applySize() {
        if (!this.w) return;
        this.sizeSprite(this.main);
        if (this.glow) this.sizeSprite(this.glow);
        if (this.bright && this.bright.visible) this.sizeSprite(this.bright);
        if (this.spineObj) this.sizeSpine();
    }
    sizeSprite(sp) {
        if (!this.w) return;
        const fit = sp => {
            const P = 1 + 2 * (sp.texture._pad || 0); // 圖集的留白要算回去，符號才不會變小
            if (this.def.fit === 'contain') {
                // 等同 CSS background-size: contain（金幣圖不變形），可選擇貼齊格子底部
                const tw = (sp.texture.width || 1) / P, th = (sp.texture.height || 1) / P;
                const k = Math.min(this.w / tw, this.h / th);
                sp.scale.set(k * P);
                sp.y = this.def.alignY === 'bottom' ? (this.h - th * k) / 2 : 0;
            } else { sp.width = this.w * P; sp.height = this.h * P; sp.y = 0; }
        };
        fit(sp);
    }
    place(geo, cellH) {
        this.root.x = geo.x + geo.w / 2 + this.def.offsetX * geo.w;
        this.root.y = geo.y + (this.slotY + 0.5 + this.offsetY) * cellH;
    }

    // 中獎：active=true 代表這個符號有專屬 sprite 動畫（Wild / Scatter / 倍率眼 / 高分符號）
    startWin(active, tag) {
        this.winTag = tag || 'win';
        this.root.zIndex = active ? this.def.zActive : this.def.zWin;
        if (this.def.spine) {
            const name = this.def.spine.win || 'win';
            this.playSpine(name, this.def.spine.winLoop !== false);
            return;
        }
        const sp = active ? this.slot.spriteFrames[this.type] : null;
        if (sp) { this.frames = sp; this.frameIdx = -1; this.frameT = 0; }
        this.mode = (active && this.def.win === 'pop') ? 'pop' : 'pulse';
        this.t = 0;
        const fx = this.slot.skin.winFx || {};
        if (this.mode === 'pulse' && !this.def.glow) this.showGlow(fx.glow || 'gold', 10, 0);
    }

    // 爆破同樣不用濾鏡：放大 + 淡出 + 加亮疊圖，中後段換成預先模糊的那張圖。
    explode() {
        this.mode = 'explode'; this.frames = null;
        this.hideGlow();
        if (this.def.spine) {
            // 骨骼動畫沒有「預先模糊圖」可以換、也不套加亮疊圖（那是貼圖專屬技巧），
            // 但放大 + 淡出是套在外層容器上，Spine 一樣吃得到，所以保留這兩個效果，只拿掉貼圖專屬的部分。
            return this.slot.reels.tween(this.slot.T.explode, e => {
                this.root.scale.set(1.1 + 0.9 * e);
                this.root.alpha = 1 - e;
            }, EASE.easeOut, aliveFn(this));
        }
        const sharp = this.slot.tex(this.type), soft = this.slot.blurTex[this.type] || sharp;
        this.setTexture(sharp);
        let swapped = false;
        return this.slot.reels.tween(this.slot.T.explode, e => {
            this.root.scale.set(1.1 + 0.9 * e);
            this.root.alpha = 1 - e;
            if (!swapped && e > 0.25) { swapped = true; this.setTexture(soft); }
            this.setBright(1 + 1.1 * e);
        }, EASE.easeOut, aliveFn(this));
    }

    update(dt) {
        if (this.frames) {
            this.frameT += dt;
            const f = this.frames, total = f.dur * 1000;
            let p = this.frameT / total;
            p = f.loop ? p % 1 : Math.min(p, 0.9999);
            const idx = Math.min(f.frames.length - 1, Math.floor(p * f.frames.length));
            if (idx !== this.frameIdx) { this.frameIdx = idx; this.setTexture(f.frames[idx]); }
        }
        if (this.mode === 'pulse') {
            // DOM 版 @keyframes winAction：0% → 50%（放大、變亮、發光）→ 100%
            const fx = this.slot.skin.winFx || {};
            const S = fx.scale || 1.15, B = fx.brightness || 1.3;
            this.t += dt;
            const P = (this.def.period || this.slot.T.pulse) * 1000, p = (this.t % P) / P;
            const e = EASE.easeInOut(p < 0.5 ? p * 2 : (1 - p) * 2);
            this.root.scale.set(1 + (S - 1) * e);
            this.setBright(1 + (B - 1) * e);
            if (this.glow && !this.def.glow) this.glow.alpha = e;
        } else if (this.mode === 'pop') {
            // DOM 版 @keyframes wildPop（alternate）：放大 1.15、亮度 1.5 來回
            const fx = this.slot.skin.popFx || {};
            const S = fx.scale || 1.15, B = fx.brightness || 1.5;
            this.t += dt;
            const P = this.slot.T.pop * 1000, q = (this.t % (2 * P)) / P;
            const e = EASE.easeInOut(q < 1 ? q : 2 - q);
            this.root.scale.set(1 + (S - 1) * e);
            this.setBright(1 + (B - 1) * e);
        }
    }

    // ---- 金幣上的數值（Hold&Win） ----
    setValue(text, kind, pop) {
        const { PIXI } = this.slot;
        const style = this.slot.coinTextStyle(kind);
        if (!this.valueText) {
            this.valueText = new PIXI.Text({ text: '', style });
            this.valueText.anchor.set(0.5);
            this.valueText.zIndex = 15;
            this.root.addChild(this.valueText);
        } else this.valueText.style = style;
        this.valueKind = kind || null;
        this.valueText.text = String(text);
        this.valueText.visible = true; this.valueText.alpha = 1; this.valueText.scale.set(1);
        if (this._valueTween) this._valueTween.cancel = true;
        if (pop) this.popValue();
    }
    // DOM 版 @keyframes valuePop：0 → 放大 1.4 → 1，起始帶一團白光
    popValue() {
        const t = this.valueText; if (!t) return;
        const { PIXI } = this.slot;
        if (!this.flash) {
            this.flash = new PIXI.Sprite(this.slot.radialTexture());
            this.flash.anchor.set(0.5);
            this.root.addChildAt(this.flash, this.root.getChildIndex(t));
        }
        t.scale.set(1);
        const fw = t.width * 1.3, fh = t.height * 1.8;
        const f = this.flash; f.visible = true; f.width = fw; f.height = fh;
        const S = keyframes([[0, 0], [0.6, 1.4], [1, 1]], EASE.pop);
        const A = keyframes([[0, 0], [0.6, 1], [1, 1]], EASE.pop);
        const F = keyframes([[0, 1], [0.6, 0.3], [1, 0]], EASE.linear);
        const token = this._valueTween = {};
        this.slot.reels.tween(400, (e, k) => {
            if (token.cancel) return;
            t.scale.set(Math.max(0, S(k))); t.alpha = Math.min(1, Math.max(0, A(k)));
            f.alpha = F(k);
        }, EASE.linear, aliveFn(this)).then(() => { if (!this.dead && !token.cancel) f.visible = false; });
    }
    fadeValue(ms) {
        const t = this.valueText; if (!t || !t.visible) return;
        const from = t.alpha, token = this._valueTween = {};
        this.slot.reels.tween(ms, e => { if (!token.cancel) t.alpha = from * (1 - e); }, EASE.easeOut, aliveFn(this));
    }
    clearValue() { if (this.valueText) { this.valueText.visible = false; this.valueText.text = ''; } if (this.flash) this.flash.visible = false; }

    // 回收而不是丟掉：轉輪每次旋轉要用掉上百個符號物件，反覆建立再丟棄會讓
    // 瀏覽器的記憶體回收不定時介入，造成偶發卡頓。改成重複利用就沒有這個問題。
    destroy() {
        if (this.dead) return;
        this.dead = true; this.gen++;
        this.clearValue();
        this.mode = 'idle'; this.frames = null;
        if (this.bright) this.bright.visible = false;
        if (this.plate) { this.plate.destroy(); this.plate = null; } // 底板貼圖是共用的，只銷毀這個 Sprite
        if (this.spineObj) { this.spineObj.destroy(); this.spineObj = null; } // 特殊符號才會用 Spine，數量少，重進池子時直接重建即可
        this.root.filters = null; this.root.alpha = 1; this.root.scale.set(1);
        if (this.root.parent) this.root.parent.removeChild(this.root);
        const pool = this.slot.reels && this.slot.reels.pool;
        if (pool && pool.length < 240) pool.push(this);
        else this.root.destroy({ children: true });
    }
    revive(type) {
        this.dead = false; this.gen++;
        if (this.type !== type) {
            this.type = type; this.def = this.slot.symDef(type);
            this.main.visible = !this.def.blank;
            if (this.glow) { this.glow.filters = null; this._glowKey = null; }
        }
        // 回收時 Spine 物件已被銷毀；同一種符號再被取出時 type 沒變，所以不能只在換類型時才重建
        if (this.def.spine && !this.spineObj) this.setupSpine();
        this.reset();
    }
}

/* =============================================================================
   ReelsView：轉輪區（對應 DOM 版 .reel-viewport 裡的 #grid）
   ============================================================================= */
class ReelsView {
    constructor(slot, host, gridEl) {
        const { PIXI } = slot;
        this.slot = slot; this.PIXI = PIXI;
        this.app = slot.reelApp; this.host = host; this.gridEl = gridEl;
        this.rows = slot.rows; this.ncols = slot.cols;
        this.tweens = [];
        this.live = new Set();
        this.pool = [];   // 回收再利用的符號物件
        this.columns = [];
        // 每一欄一個容器、依序疊放：跟 DOM 版每個 .column 各自是一個 z-index 圖層的效果相同
        for (let c = 0; c < this.ncols; c++) {
            const container = new PIXI.Container();
            container.sortableChildren = true;
            this.app.stage.addChild(container);
            this.columns.push({ container, views: [] });
        }
        // global 圖層（Hold&Win）：整盤共用一層，金幣 130% 寬可以壓到隔壁欄，跟 DOM 版一樣
        this.dimLayer = new PIXI.Container();           // 變暗濾鏡掛在這一層（廢牌 + 單格重轉帶）
        this.dimCells = new PIXI.Container();
        this.dimBoard = new PIXI.Container(); this.dimBoard.sortableChildren = true;
        this.dimLayer.addChild(this.dimCells, this.dimBoard);
        this.coinCells = new PIXI.Container();          // 單格重轉帶裡的金幣（不變暗）
        this.board = new PIXI.Container(); this.board.sortableChildren = true;
        this.overlay = new PIXI.Container(); // 爆破特效放最上層，不會被隔壁欄蓋住
        this.app.stage.addChild(this.dimLayer, this.coinCells, this.board, this.overlay);
        this.layering = slot.layering; this.dimOn = false; this.dimT = 0; this.dimBaked = false;
        this.measure();
        this.app.ticker.add(t => this.tick(Math.min(t.deltaMS, 100)));
        if (window.ResizeObserver) new ResizeObserver(() => this.onResize()).observe(host);
        window.addEventListener('resize', () => this.onResize());
    }

    tween(ms, fn, ease = EASE.linear, alive) {
        return new Promise(resolve => {
            if (ms <= 0) { fn(1); return resolve(); }
            this.tweens.push({ t: 0, ms, fn, ease, alive, resolve });
        });
    }

    tick(dt) {
        for (let i = this.tweens.length - 1; i >= 0; i--) {
            const tw = this.tweens[i];
            if (tw.alive && !tw.alive()) { this.tweens.splice(i, 1); tw.resolve(); continue; }
            tw.t += dt;
            const k = Math.min(1, tw.t / tw.ms);
            tw.fn(tw.ease(k), k);
            if (k >= 1) { this.tweens.splice(i, 1); tw.resolve(); }
        }
        this.live.forEach(v => { if (v.dead) this.live.delete(v); else v.update(dt); });
    }

    // 量 #grid 裡每個 .column 的實際位置 → 轉輪區版面完全沿用 index.html 的 CSS
    measure() {
        const hr = this.host.getBoundingClientRect();
        const els = [...this.gridEl.children];
        this.geo = els.map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
        });
        if (!this.geo.length) this.geo = [{ x: 0, y: 0, w: hr.width, h: hr.height }];
        this.cellH = this.geo[0].h / this.rows;
    }
    onResize() {
        const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
        this.app.renderer.resize(w, h);
        this.measure();
        this.columns.forEach((col, c) => col.views.forEach(v => {
            if (!v) return;
            v.setSize(this.geo[c].w, this.cellH); v.place(this.geo[c], this.cellH);
            if (v.valueText) v.valueText.style = this.slot.coinTextStyle(v.valueKind);
        }));
    }

    // 'tex' = 換預先模糊的圖（快）；BlurFilter 物件 = 即時模糊（慢，僅在沒有圖集時退回）；null = 關閉
    motionBlurMode() {
        if (this.slot.skin.motionBlur === false) return null;
        if (this.slot.atlas && Object.keys(this.slot.blurTex).length) return 'tex';
        return new this.PIXI.BlurFilter({ strengthX: 0, strengthY: 0, quality: 2 });
    }
    slotYOf(r) { return this.slot.rowOrder === 'topDown' ? r : this.rows - 1 - r; }
    bottomToTop() { const a = [...Array(this.rows).keys()]; return this.slot.rowOrder === 'topDown' ? a.reverse() : a; }
    landParent(v, c) {
        if (this.layering !== 'global') return this.columns[c].container;
        return (this.dimOn && !v.def.dimExempt) ? this.dimBoard : this.board;
    }
    makeView(type, c, slotY, parent) {
        let v = this.pool.pop();
        if (v) v.revive(type); else v = new SymbolView(this.slot, type);
        if (this.dimBaked) v.setDimmed(true);
        v.slotY = slotY; v.c = c;
        v.setSize(this.geo[c].w, this.cellH);
        v.place(this.geo[c], this.cellH);
        (parent || this.landParent(v, c)).addChild(v.root);
        this.live.add(v);
        return v;
    }
    // 某一格中心點在「整個網頁」上的座標（給 index.html 畫 SVG 中獎線用）
    cellClientCenter(c, r) {
        const hr = this.host.getBoundingClientRect(), g = this.geo[c] || this.geo[0];
        return { x: hr.left + g.x + g.w / 2, y: hr.top + g.y + (this.slotYOf(r) + 0.5) * this.cellH };
    }
    view(c, r) { return this.columns[c] && this.columns[c].views[r]; }

    setGrid(grid) {
        this.columns.forEach((col, c) => {
            col.views.forEach(v => v.destroy());
            col.views = grid[c].map((t, r) => this.makeView(t, c, this.slotYOf(r)));
        });
    }

    async spin(grid, { turbo = false, onStop } = {}) {
        const T = this.slot.T;
        await Promise.all(grid.map((targets, c) => (async () => {
            await wait(turbo ? 0 : c * T.reelDelay);
            await this.spinColumn(c, targets, turbo);
            if (onStop) onStop(c);
            if (!turbo) await wait(T.stopPause);
            this.land(c, turbo);
        })()));
    }

    // 一條長帶：[目前盤面 3 顆] + [隨機填充 N 顆] + [目標盤面 3 顆]，整條往下滑到目標就位
    async spinColumn(c, targets, turbo) {
        const { PIXI } = this, T = this.slot.T, rows = this.rows, col = this.columns[c];
        const order = this.bottomToTop();               // 長帶由下往上排
        const cur = order.map(r => col.views[r]).filter(Boolean);
        cur.forEach(v => { v.reset(); v.clearValue(); col.container.addChild(v.root); });
        const fillers = Array.from({ length: T.fillers }, () => 1 + Math.floor(Math.random() * 9));
        const strip = [...cur, ...fillers.map(t => this.makeView(t, c, 0, col.container)), ...order.map(r => this.makeView(targets[r], c, 0, col.container))];
        const travel = cur.length + fillers.length;
        const blur = this.motionBlurMode();
        if (blur && blur !== 'tex') col.container.filters = [blur];
        let prev = 0, blurred = false;
        const layout = off => strip.forEach((v, i) => { v.slotY = (rows - 1 - i) + off; v.place(this.geo[c], this.cellH); });
        layout(0);
        await this.tween(turbo ? T.spinTurbo : T.spin, e => {
            const off = e * travel;
            layout(off);
            if (blur === 'tex') {
                const on = Math.abs(off - prev) > BLUR_ON;
                if (on !== blurred) { blurred = on; strip.forEach(v => v.setMotion(on)); }
            } else if (blur) blur.strengthY = Math.min(18, Math.abs(off - prev) * this.cellH * 0.45);
            prev = off;
        }, EASE.reel);
        if (blur === 'tex') strip.forEach(v => v.setMotion(false));
        col.container.filters = null;
        strip.slice(0, travel).forEach(v => v.destroy());
        const tail = strip.slice(travel);   // 最後幾顆剛好停在盤面上的位置，直接沿用
        col.views = [];
        order.forEach((r, k) => { const v = tail[k]; col.views[r] = v; this.landParent(v, c).addChild(v.root); });
    }

    land(c, turbo) {
        if (turbo) return;
        const geo = () => this.geo[c];
        this.columns[c].views.forEach(v => {
            this.tween(this.slot.T.landBounce, (e, k) => { v.offsetY = LAND_BOUNCE(k); v.place(geo(), this.cellH); }, EASE.linear, aliveFn(v));
        });
    }

    playWin(matches, grid) {
        matches.forEach(key => {
            const [c, r] = key.split(',').map(Number);
            const v = this.view(c, r); if (!v) return;
            v.startWin(v.def.hasSprite);
        });
    }

    activateType(type) {
        this.columns.forEach(col => col.views.forEach(v => { if (v.type === type) v.startWin(true); }));
    }

    explode(matches) {
        matches.forEach(key => {
            const [c, r] = key.split(',').map(Number);
            const v = this.view(c, r); if (!v) return;
            v.explode();
            this.spawnExplosion(v);
        });
    }

    spawnExplosion(v) {
        const ex = this.slot.explosion; if (!ex) return;
        const s = new this.PIXI.Sprite(ex.frames[0]);
        s.anchor.set(0.5);
        const size = this.cellH * ex.size;
        s.width = size; s.height = size;
        s.position.set(v.root.x + v.w * ex.offsetX, v.root.y);
        this.overlay.addChild(s);
        const n = ex.frames.length;
        this.tween(ex.dur * 1000, (e, k) => {
            const i = Math.min(n - 1, Math.floor(k * n));
            if (s.texture !== ex.frames[i]) { s.texture = ex.frames[i]; s.width = size; s.height = size; }
        }).then(() => s.destroy());
    }

    // 第一次旋轉要用到的符號物件，先在載入階段全部做好放進回收池並畫過一次，
    // 這樣第一轉就不必臨時建立上百個物件（也順便把繪圖用的緩衝區撐到該有的大小）。
    prewarm() {
        const T = this.slot.T;
        let n = this.ncols * (T.fillers + this.rows + 2);
        if (this.slot.layering === 'global') n = Math.max(n, this.rows * this.ncols * (T.cellFillers + 2));
        n = Math.min(n, 280);
        const types = Object.keys(this.slot.staticTex).map(Number);
        if (!types.length) return;
        const tmp = [];
        for (let i = 0; i < n; i++) tmp.push(this.makeView(types[i % types.length], 0, -60));
        try { this.app.renderer.render(this.app.stage); } catch (e) {}
        tmp.forEach(v => v.destroy());
    }

    /* ---------- Hold&Win 用 ---------- */
    forEachView(fn) { this.columns.forEach((col, c) => col.views.forEach((v, r) => { if (v && !v.dead) fn(v, c, r); })); }
    clearWins() { this.forEachView(v => { if (v.winTag === 'win') v.reset(); }); } // 觸發時的金幣跳動不清（DOM 版是行內動畫）
    pulseCells(keys) {
        keys.forEach(key => { const [c, r] = key.split(',').map(Number); const v = this.view(c, r); if (v) v.startWin(false, 'hold'); });
    }
    fadeCoinValues(ms) { this.forEachView(v => v.fadeValue(ms)); }
    // list: [{ c, r, text, kind }]；DOM 版每次都重建金幣元素，所以原本的縮放動畫會停掉、數字重新彈出
    setCoinValues(list, coinType, pop) {
        list.forEach(({ c, r, text, kind }) => {
            let v = this.view(c, r);
            if (!v || v.type !== coinType) {
                if (v) v.destroy();
                v = this.makeView(coinType, c, this.slotYOf(r));
                this.columns[c].views[r] = v;
            } else v.reset();
            v.setValue(text, kind, pop);
        });
    }
    // 廢牌變暗（CSS .hold-n-win-mode .symbol:not(.sym-20)）：整層一個濾鏡，淡入淡出 0.3 秒
    setDim(on) {
        if (this.layering !== 'global' || this.dimOn === on) return Promise.resolve();
        const { PIXI } = this;
        const D = Object.assign({ brightness: 0.4, grayscale: 0.4, blur: 1.5, fade: 300 }, this.slot.skin.dim || {});
        const reparent = () => this.forEachView((v, c) => this.landParent(v, c).addChild(v.root));
        const baked = this.slot.atlas && Object.keys(this.slot.dimTex).length;
        if (!this.dimCM) { this.dimCM = new PIXI.ColorMatrixFilter(); this.dimBlur = new PIXI.BlurFilter({ strength: 0, quality: 2 }); }
        // 淡入淡出期間才用即時濾鏡（只有 0.3 秒）；結束後改用圖集裡預先變暗的圖，
        // 濾鏡整個拔掉，重轉時就不必每格畫面都重畫一次暗色圖層。
        if (this.dimBaked) { this.dimBaked = false; this.forEachView(v => v.setDimmed(false)); }
        this.dimLayer.filters = [this.dimCM, this.dimBlur];
        this.dimOn = on;
        if (on) reparent();
        const from = this.dimT, to = on ? 1 : 0, token = this._dimToken = {};
        return this.tween(D.fade, e => {
            if (this._dimToken !== token) return;
            this.dimT = from + (to - from) * e;
            this.dimCM.matrix = dimMatrix(this.dimT, D);
            this.dimBlur.strength = D.blur * this.dimT;
        }).then(() => {
            if (this._dimToken !== token) return;
            if (on) {
                if (!baked) return;
                this.dimBaked = true;
                this.forEachView(v => v.setDimmed(true));
                this.dimLayer.filters = null;
            } else {
                reparent();
                this.dimLayer.filters = null;
            }
        });
    }
    // Hold&Win 重轉：沒鎖定的每一格各自轉（遮罩只露出一格），鎖定的金幣完全不動
    async cellSpin(grid, { turbo = false, locked, onStop, coinValue } = {}) {
        const jobs = [];
        for (let c = 0; c < this.ncols; c++) {
            for (let r = 0; r < this.rows; r++) {
                if (locked && locked.has(`${c},${r}`)) continue;
                jobs.push((async () => {
                    await wait(turbo ? 0 : Math.random() * 100 + c * 20);
                    await this.spinCell(c, r, grid[c][r], turbo, coinValue);
                    if (onStop) onStop(c, r);
                })());
            }
        }
        await Promise.all(jobs);
    }
    async spinCell(c, r, target, turbo, coinValue) {
        const { PIXI } = this, T = this.slot.T, col = this.columns[c];
        const old = col.views[r];
        const n = turbo ? T.cellFillersTurbo : T.cellFillers;
        const coinType = this.slot.skin.coinType || 20;
        const fillers = Array.from({ length: n }, () => Math.random() < T.cellCoinChance ? coinType : 1 + Math.floor(Math.random() * 9));
        const types = [old ? old.type : 99, ...fillers, target];
        const g = this.geo[c], top = g.y + this.slotYOf(r) * this.cellH;
        const mkMask = () => new PIXI.Graphics().rect(g.x, top, g.w, this.cellH).fill(0xffffff);
        // 變暗已經烘進貼圖時，這一格只要「一個」遮罩容器就夠了（遮罩對 GPU 不便宜，能少一半是一半）。
        // 只有在變暗淡入淡出的那 0.3 秒還掛著即時濾鏡，才需要分成兩層。
        const split = this.dimOn && !this.dimBaked;
        const dimC = new PIXI.Container(), m1 = mkMask();
        this.dimCells.addChild(m1, dimC); dimC.mask = m1;
        let coinC = dimC, m2 = null;
        if (split) { coinC = new PIXI.Container(); m2 = mkMask(); this.coinCells.addChild(m2, coinC); coinC.mask = m2; }
        const blur = this.motionBlurMode();
        if (blur && blur !== 'tex') { blur.quality = 1; dimC.filters = [blur]; if (split) coinC.filters = [blur]; }
        const strip = types.map(t => {
            const probe = this.slot.symDef(t);
            return this.makeView(t, c, 0, (split && !probe.dimExempt) ? dimC : coinC);
        });
        if (old) old.root.visible = false;
        const base = this.slotYOf(r), travel = types.length - 1;
        const layout = off => strip.forEach((v, i) => { v.slotY = base - i + off; v.place(this.geo[c], this.cellH); });
        layout(0);
        let prev = 0, blurred = false;
        await this.tween(turbo ? T.cellSpinTurbo : T.cellSpin + Math.random() * T.cellSpinRand, e => {
            const off = e * travel;
            layout(off);
            if (blur === 'tex') {
                const on = Math.abs(off - prev) > BLUR_ON;
                if (on !== blurred) { blurred = on; strip.forEach(v => v.setMotion(on)); }
            } else if (blur) blur.strengthY = Math.min(14, Math.abs(off - prev) * this.cellH * 0.45);
            prev = off;
        }, EASE.css);
        strip.forEach(v => v.destroy());
        dimC.destroy({ children: true }); m1.destroy();
        if (m2) { coinC.destroy({ children: true }); m2.destroy(); }
        if (old) old.destroy();
        const v = this.makeView(target, c, base);
        col.views[r] = v;
        const val = target === coinType && coinValue ? coinValue(c, r) : null;
        if (val) v.setValue(val.text, val.kind, true);
    }

    async refill(newGrid, matches) {
        const rows = this.rows, T = this.slot.T;
        const moves = [];
        this.columns.forEach((col, c) => {
            const survivors = [];
            col.views.forEach((v, r) => { if (matches.has(`${c},${r}`)) v.destroy(); else survivors.push({ v, oldR: r }); });
            const next = [];
            survivors.forEach((s, newR) => {
                s.v.reset();
                s.v.slotY = rows - 1 - newR;
                moves.push({ v: s.v, gen: s.v.gen, c, from: -(s.oldR - newR) });
                next.push(s.v);
            });
            for (let k = 0; k < rows - survivors.length; k++) {
                const newR = survivors.length + k;
                const v = this.makeView(newGrid[c][newR], c, rows - 1 - newR);
                moves.push({ v, gen: v.gen, c, from: -((rows + k) - newR) });
                next.push(v);
            }
            col.views = next;
        });
        moves.forEach(m => { m.v.offsetY = m.from; m.v.place(this.geo[m.c], this.cellH); });
        await this.tween(T.refill, e => {
            moves.forEach(m => { if (m.v.dead || m.v.gen !== m.gen) return; m.v.offsetY = m.from * (1 - e); m.v.place(this.geo[m.c], this.cellH); });
        }, EASE.drop);
    }
}

/* =============================================================================
   FxLayer：噴錢＋彩帶（全螢幕、不擋點擊）。物理公式照搬 DOM 版 CoinManager，
   但改成 WebGL 批次繪製，並依實際影格時間計算，高刷新率螢幕上速度也一致。
   ============================================================================= */
class FxLayer {
    constructor(slot, host) {
        const { PIXI } = slot;
        this.slot = slot; this.PIXI = PIXI; this.app = slot.fxApp; this.host = host;
        this.eff = slot.skin.effects || {};
        this.coins = []; this.sparks = []; this.confetti = [];
        this.pool = { coin: [], spark: [], conf: [] };
        this.coinLayer = new PIXI.Container();
        this.sparkLayer = new PIXI.Container();
        this.confLayer = new PIXI.Container();
        this.app.stage.addChild(this.confLayer, this.coinLayer, this.sparkLayer);
        this.MAX_COINS = 2500;
        this.resize();
        this.app.ticker.add(t => this.tick(Math.min(t.deltaTime, 3), Math.min(t.deltaMS, 50)));
        this.app.ticker.stop(); // 沒有特效時不重畫，省電
        if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(host);
        window.addEventListener('resize', () => this.resize());
    }
    resize() {
        this.w = Math.max(1, this.host.clientWidth); this.h = Math.max(1, this.host.clientHeight);
        this.app.renderer.resize(this.w, this.h);
    }
    wake() { if (!this.app.ticker.started) this.app.ticker.start(); }
    // 預熱用：把剛才試噴的粒子全部收回，畫面不留痕跡
    reset() {
        [[this.coins, this.pool.coin], [this.sparks, this.pool.spark], [this.confetti, this.pool.conf]]
            .forEach(([list, pool]) => { while (list.length) this.recycle(list, list.length - 1, pool); });
        this.app.ticker.stop();
        try { this.app.render(); } catch (e) {}
    }

    fire(amount, originX = 0.5) {
        let count = (amount > 200) ? 50 : amount; if (amount < 5) count = 20;
        const room = Math.max(0, this.MAX_COINS - this.coins.length);
        count = Math.min(count, room);
        const sparkleCount = Math.floor(count / 2);
        for (let i = 0; i < count; i++) this.addCoin(originX);
        for (let i = 0; i < sparkleCount; i++) this.addSpark(originX);
        this.wake();
    }

    addCoin(originX) {
        const { PIXI } = this, w = this.w, h = this.h;
        let s = this.pool.coin.pop();
        if (!s) {
            s = new PIXI.Sprite(this.slot.coinTex); s.anchor.set(0.5);
            const flash = new PIXI.Sprite(this.slot.coinTex); flash.anchor.set(0.5); flash.blendMode = 'add';
            s.addChild(flash); s.flash = flash;
        }
        s.visible = true; s.flash.visible = false;
        s.p = {
            x: w * originX, y: h + 50,
            vx: (Math.random() - 0.5 + (0.5 - originX)) * (w * 0.04),
            vy: -(Math.random() * h * 0.025 + h * 0.015),
            g: h * 0.0005, size: (Math.random() * 30 + 30) * (w / 720) * 3,
            rot: Math.random() * 360, rs: (Math.random() - 0.5) * 10,
            flip: Math.random() * Math.PI, fs: Math.random() * 0.2 + 0.1,
            flashing: false, ft: 0, fd: 30
        };
        this.coinLayer.addChild(s); this.coins.push(s);
    }
    addSpark(originX) {
        const { PIXI } = this, w = this.w, h = this.h;
        let s = this.pool.spark.pop() || new PIXI.Sprite(PIXI.Texture.WHITE);
        s.visible = true;
        const size = Math.random() * 5 + 2;
        s.width = size; s.height = size;
        s.p = { x: w * originX + (Math.random() - 0.5) * 50, y: h + 50, vx: (Math.random() - 0.5) * (w * 0.04), vy: -(Math.random() * h * 0.028 + h * 0.01), g: h * 0.0002, a: 1, decay: Math.random() * 0.02 + 0.01 };
        this.sparkLayer.addChild(s); this.sparks.push(s);
    }

    // 彩帶：顏色與落下時長直接吃動畫編輯器的設定（DOM 版這兩項沒有接進成品）
    spawnConfetti() {
        const { PIXI } = this;
        const colors = (this.eff.confettiColors && this.eff.confettiColors.length) ? this.eff.confettiColors : ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
        const dMin = this.eff.confettiDurMin || 1.5, dMax = Math.max(dMin, this.eff.confettiDurMax || 3.5);
        let s = this.pool.conf.pop() || new PIXI.Sprite(PIXI.Texture.WHITE);
        s.visible = true; s.anchor.set(0.5);
        const size = this.h * 0.015;
        const c = parseColor(colors[Math.floor(Math.random() * colors.length)]).rgb;
        s.tint = (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
        s.p = { x: Math.random() * this.w, y0: -this.h * 0.05, dist: this.h * 1.1, t: 0, dur: (Math.random() * (dMax - dMin) + dMin) * 1000, size, wob: Math.random() * Math.PI * 2 };
        this.confLayer.addChild(s); this.confetti.push(s);
        this.wake();
    }

    recycle(list, i, pool) { const s = list[i]; list.splice(i, 1); s.visible = false; s.parent && s.parent.removeChild(s); pool.push(s); }

    tick(dt, dms) {
        const h = this.h;
        for (let i = this.coins.length - 1; i >= 0; i--) {
            const s = this.coins[i], p = s.p;
            p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            p.rot += p.rs * dt; p.flip += p.fs * dt;
            if (!p.flashing && Math.random() < 0.05 * dt) { p.flashing = true; p.ft = 0; }
            let bright = 0;
            if (p.flashing) { p.ft += dt; bright = Math.sin((p.ft / p.fd) * Math.PI); if (p.ft >= p.fd) p.flashing = false; }
            const base = p.size / this.slot.coinTex.width;
            s.position.set(p.x, p.y); s.rotation = p.rot * Math.PI / 180;
            s.scale.set(base * Math.cos(p.flip), base);
            s.flash.visible = bright > 0.05; s.flash.alpha = bright;
            if (p.y > h + 100) this.recycle(this.coins, i, this.pool.coin);
        }
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const s = this.sparks[i], p = s.p;
            p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.a -= p.decay * dt;
            if (p.a <= 0 || p.y > h + 100) { this.recycle(this.sparks, i, this.pool.spark); continue; }
            s.position.set(p.x, p.y); s.alpha = p.a; s.tint = Math.random() > 0.5 ? 0xffffff : 0xffff00;
        }
        for (let i = this.confetti.length - 1; i >= 0; i--) {
            const s = this.confetti[i], p = s.p;
            p.t += dms;
            const k = p.t / p.dur;
            if (k >= 1) { this.recycle(this.confetti, i, this.pool.conf); continue; }
            s.position.set(p.x, p.y0 + p.dist * k);
            s.rotation = k * Math.PI * 4;
            s.scale.set(p.size / s.texture.width, p.size * Math.cos(p.wob + k * 12) / s.texture.height); // 輕微翻面
            s.alpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
        }
        if (!this.coins.length && !this.sparks.length && !this.confetti.length) {
            this.app.ticker.stop();
            this.app.render();
        }
    }

    // 給 gui.js 的相容介面（原本的 window.CoinManager / window.spawnConfetti）
    coinManagerAPI() { return { init: () => this.resize(), fire: (a, o) => this.fire(a, o) }; }
}

export async function createPixiSlot(PIXI, { config, skin, reelHost, gridEl, fxHost, onProgress, Spine }) {
    const slot = new PixiSlot(PIXI, config, skin, Spine);
    await slot.init(reelHost, gridEl, fxHost, onProgress);
    // 開發用：在瀏覽器主控台輸入 __slot 可以檢查圖集是否成功打包、有沒有符號漏掉
    const api = { reels: slot.reels, fx: slot.fx, slot };
    try {
        window.__slot = api;
        console.info(slot.atlas
            ? `[pixi-view] 符號圖集 ${slot.atlas.size}，共 ${slot.atlas.count} 塊（清晰／模糊／光暈／變暗）`
            : '[pixi-view] 未使用圖集：每顆符號各自一張貼圖（手機上較慢）');
    } catch (e) {}
    return api;
}
