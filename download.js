const BUGI_PREVIEW_EYE_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

let downloadJobs = [];
let activeJobId = null;
/** Ekran uyandırma (Wake Lock); sekme arka planda olsa bile CPU uyku moduna girmesin diye */
let dmWakeLock = null;

function dmUpdateBgThrottleHint() {
    const el = document.getElementById("dm-bg-throttle-hint");
    if (!el) return;
    const busy = !!activeJobId;
    el.style.display = busy && document.visibilityState === "hidden" ? "block" : "none";
}

async function dmAcquireThroughputAssist() {
    try {
        if (chrome.power && chrome.power.requestKeepAwake) {
            chrome.power.requestKeepAwake("system");
        }
    } catch (_e) {}
    try {
        if (typeof navigator !== "undefined" && navigator.wakeLock && navigator.wakeLock.request) {
            dmWakeLock = await navigator.wakeLock.request("screen");
        }
    } catch (_e) {}
}

function dmReleaseThroughputAssist() {
    try {
        if (chrome.power && chrome.power.releaseKeepAwake) {
            chrome.power.releaseKeepAwake();
        }
    } catch (_e) {}
    try {
        if (dmWakeLock && typeof dmWakeLock.release === "function") {
            dmWakeLock.release();
        }
    } catch (_e) {}
    dmWakeLock = null;
    dmUpdateBgThrottleHint();
}
const STORAGE_KEY = "bugi_download_jobs_v1";

function dmT(key) {
    const out = (typeof BugiI18n !== "undefined" && BugiI18n.t) ? BugiI18n.t(key) : key;
    if (out && out !== key) return out;
    return key;
}
function dmTf(key, vars) {
    const out = (typeof BugiI18n !== "undefined" && BugiI18n.tf) ? BugiI18n.tf(key, vars) : key;
    if (out && out !== key) return out;
    if (key === "dm.summaryTotal") return `Total: ${Number((vars && vars.n) || 0)} downloads`;
    if (key === "dm.summaryActive") return `Active: ${Number((vars && vars.n) || 0)}`;
    return key;
}

// Sadece bu sekme açıkken geçerli olacak "aynı klasör" ayarı
let fixedDirEnabled = false;
let fixedDirHandle = null;

// Tamamlananlar için arama sorgusu
let searchQuery = "";
let devModeOn = false;
let dmLastWinTop = null, dmLastWinLeft = null;
const dmActiveSubtitleDownloads = new Set();

let completedSortAsc = false; // false: yeni en üstte
let pendingSortAsc = false;   // false: yeni en üstte

// Variant ses tespiti cache (variantUrl -> "muxed" | "none")
const dmAudioProbeCache = new Map();

let dmIsDebugActive = false;
let dmLegalAccepted = false;
function dmRefreshLegalStatus() {
    chrome.runtime.sendMessage({ action: "GET_LEGAL_STATUS", incognito: !!(chrome.extension && chrome.extension.inIncognitoContext) }, (res) => {
        dmLegalAccepted = !!(res && res.accepted);
    });
}
function dmSendDebug(msg, data) {
    if (!dmIsDebugActive) return;
    try {
        chrome.runtime.sendMessage({ action: "ADD_DEBUG_LOG", source: "DM", msg, data });
    } catch (_e) {}
}

const BUGI_BUILTIN_NOTIFICATION_SOUNDS = [
    { key: "Tuturu", label: "Tutturu", file: "sounds/Tuturu.mp3", kind: "builtin" },
    { key: "kururin", label: "Kurukru", file: "sounds/kururin.mp3", kind: "builtin" }
];
let bugiCustomNotificationSounds = []; // { key, label, dataUrl, kind: "custom" }
let bugiAvailableNotificationSounds = BUGI_BUILTIN_NOTIFICATION_SOUNDS.slice();
let bugiNotifSoundKey = "Tuturu"; // Varsayılan: Tutturu
let bugiNotifVolume = 0.4;
let bugiAutoQueueAll = false; // "Sırayla Hepsini İndir" aktif mi?

// İndirme Yöneticisi paralel segment sayısı (aynı anda kaç segment indirilecek). Popup'taki "Eşzamanlı indirme" ile aynı değer kullanılır.
const DM_MAX_CONCURRENT_DEFAULT = 12;
let dmMaxConcurrent = DM_MAX_CONCURRENT_DEFAULT;

// Sayfalama (DM UI performansı için). Kayıtlar storage'da tam kalır; sadece ekranda sayfalanır.
const DM_PAGE_SIZE_DEFAULT = 100;
let dmPageSize = DM_PAGE_SIZE_DEFAULT;
let completedPage = 1;
let pendingPage = 1;

// Render/storage throttling (indirme sırasında CPU/DOM spam'i azaltır)
// Not: paralel segment indirmede her segment için UI yenilemek titreme yapar; 1sn yeterli.
const DM_RENDER_THROTTLE_MS = 1000;
const DM_SAVE_THROTTLE_MS = 1000;
/** Çok büyük TS dosyalarında OS/Chrome writable.close() dakikalar sürebilir; sonsuz "indiriliyor" hissini önlemek için. */
const DM_CLOSE_TIMEOUT_MS = 45 * 60 * 1000;
let dmRenderTimer = null;
let dmSaveTimer = null;

// Keyed DOM reuse for lists (prevents full re-render flicker)
let dmPendingCardCache = new Map();   // jobId -> cardEl
let dmCompletedCardCache = new Map(); // jobId -> cardEl

class DiskStreamManagerDM {
    constructor() {
        this.reset();
    }
    _sanitizeTsFileName(name) {
        let s = String(name || "video.ts").trim().replace(/[\\/:*?"<>|]/g, "-");
        s = s.replace(/\.(crdownload|tmp|part)$/gi, "");
        if (/\.ts\./i.test(s)) {
            const low = s.toLowerCase();
            const i = low.lastIndexOf(".ts");
            if (i >= 0) s = s.slice(0, i + 3);
        }
        if (!/\.ts$/i.test(s)) {
            s = s.replace(/\.[^.]+$/, "") + ".ts";
        }
        return s || "video.ts";
    }
    reset() {
        this.fileHandle = null;
        this.writable = null;
        this.nextIndex = 0;
        this.buffer = new Map();
        this.isReady = false;
        this.useFallback = false;
        this.fallbackChunks = [];
        this.suggestedName = "video.ts";
        /** Paralel indirmede yazma sırasını garanti etmek için: tek bir zincir (mutex) */
        this._writeLock = Promise.resolve();
    }
    async init(suggestedName) {
        this.reset();
        const cleanName = this._sanitizeTsFileName(suggestedName);
        this.suggestedName = cleanName;
        const pickerTypes = [
            {
                description: dmT("dm.pickerTsVideo"),
                accept: { "video/mp2t": [".ts"] }
            }
        ];
        try {
            // Önce sabit klasör seçili ve yetkili mi diye bak
            if (fixedDirEnabled && fixedDirHandle && fixedDirHandle.getFileHandle) {
                try {
                    this.fileHandle = await fixedDirHandle.getFileHandle(cleanName, { create: true });
                    this.writable = await this.fileHandle.createWritable();
                    this.isReady = true;
                    return true;
                } catch (_e) {
                    // Eğer klasöre yazma başarısız olursa, normal kaydet penceresine geri dön
                }
            }

            if (!window.showSaveFilePicker) throw new Error(dmT("dm.errSavePickerContext"));
            this.fileHandle = await window.showSaveFilePicker({
                suggestedName: cleanName,
                types: pickerTypes
            });
            this.writable = await this.fileHandle.createWritable();
            this.isReady = true;
            return true;
        } catch (_err) {
            // Fallback: RAM'de biriktir
            this.useFallback = true;
            this.isReady = true;
            return true;
        }
    }
    getFileHandle() {
        return this.fileHandle;
    }
    async writeSegment(index, data) {
        if (!this.isReady) return;
        this.buffer.set(index, data);
        const self = this;
        const runDrain = async () => {
            while (self.buffer.has(self.nextIndex)) {
                const chunk = self.buffer.get(self.nextIndex);
                self.buffer.delete(self.nextIndex);
                self.nextIndex++;
                if (self.useFallback) {
                    self.fallbackChunks.push(chunk);
                } else if (self.writable) {
                    await self.writable.write(chunk);
                }
            }
        };
        this._writeLock = this._writeLock.then(runDrain);
        await this._writeLock;
    }
    /** Sıra bağımsız ham yazma (ör: fMP4 init segmenti) */
    async writeRaw(data) {
        if (!this.isReady) return;
        const self = this;
        const run = async () => {
            if (self.useFallback) {
                self.fallbackChunks.push(data);
            } else if (self.writable) {
                await self.writable.write(data);
            }
        };
        this._writeLock = this._writeLock.then(run);
        await this._writeLock;
    }
    getCommittedCount() {
        return this.nextIndex || 0;
    }
    async abortWritable() {
        try { await this._writeLock; } catch (_e) {}
        if (this.writable) {
            try {
                if (typeof this.writable.abort === "function") {
                    await this.writable.abort();
                } else {
                    await this.writable.close();
                }
            } catch (_e) {}
        }
        this.writable = null;
        this.fileHandle = null;
        try { this.buffer.clear(); } catch (_e) {}
        this.nextIndex = 0;
        this.isReady = false;
    }
    async close() {
        // Her durumda: bekleyen yazmaları bitirmeden kapatma
        try { await this._writeLock; } catch (_e) {}
        if (this.useFallback && this.fallbackChunks.length > 0) {
            // mp4 ise video/mp4, değilse video/mp2t
            const isMp4 = String(this.suggestedName || "").toLowerCase().endsWith(".mp4");
            const blob = new Blob(this.fallbackChunks, { type: isMp4 ? "video/mp4" : "video/mp2t" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = this.suggestedName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                URL.revokeObjectURL(url);
                a.remove();
            }, 2000);
        } else if (this.writable) {
            await this.writable.close();
        }
        this.isReady = false;
    }
}

const diskManagerDM = new DiskStreamManagerDM();

// --- MP4 "faststart" (moov öne taşı) finalizer (FFmpeg yok) ---
function dmMp4ReadU32BE(u8, off) {
    return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | (u8[off + 3])) >>> 0;
}
function dmMp4WriteU32BE(u8, off, v) {
    u8[off] = (v >>> 24) & 0xff;
    u8[off + 1] = (v >>> 16) & 0xff;
    u8[off + 2] = (v >>> 8) & 0xff;
    u8[off + 3] = (v >>> 0) & 0xff;
}
function dmMp4ReadU64BE(u8, off) {
    const hi = dmMp4ReadU32BE(u8, off);
    const lo = dmMp4ReadU32BE(u8, off + 4);
    return hi * 4294967296 + lo;
}
function dmMp4WriteU64BE(u8, off, v) {
    const hi = Math.floor(v / 4294967296);
    const lo = (v >>> 0);
    dmMp4WriteU32BE(u8, off, hi >>> 0);
    dmMp4WriteU32BE(u8, off + 4, lo);
}
function dmMp4Ascii4(u8, off) {
    return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}
function dmMp4IsContainerBox(type) {
    return (
        type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" ||
        type === "edts" || type === "dinf" || type === "mvex" || type === "moof" || type === "traf" ||
        type === "mfra" || type === "udta" || type === "meta" || type === "ilst"
    );
}
function dmMp4PatchChunkOffsetsInMoov(moovBytes, delta) {
    const u8 = moovBytes instanceof Uint8Array ? moovBytes : new Uint8Array(moovBytes);
    const walk = (start, end) => {
        let p = start;
        while (p + 8 <= end) {
            let size = dmMp4ReadU32BE(u8, p);
            const type = dmMp4Ascii4(u8, p + 4);
            let header = 8;
            if (size === 0) size = (end - p);
            if (size === 1) {
                if (p + 16 > end) return;
                size = dmMp4ReadU64BE(u8, p + 8);
                header = 16;
            }
            if (size < header || p + size > end) return;

            const boxStart = p;
            const boxEnd = p + size;

            if (type === "stco") {
                const body = boxStart + header;
                if (body + 8 <= boxEnd) {
                    const entryCount = dmMp4ReadU32BE(u8, body + 4);
                    let o = body + 8;
                    for (let i = 0; i < entryCount && (o + 4) <= boxEnd; i++) {
                        const cur = dmMp4ReadU32BE(u8, o);
                        dmMp4WriteU32BE(u8, o, (cur + delta) >>> 0);
                        o += 4;
                    }
                }
            } else if (type === "co64") {
                const body = boxStart + header;
                if (body + 8 <= boxEnd) {
                    const entryCount = dmMp4ReadU32BE(u8, body + 4);
                    let o = body + 8;
                    for (let i = 0; i < entryCount && (o + 8) <= boxEnd; i++) {
                        const cur = dmMp4ReadU64BE(u8, o);
                        dmMp4WriteU64BE(u8, o, cur + delta);
                        o += 8;
                    }
                }
            } else if (dmMp4IsContainerBox(type)) {
                if (type === "meta") {
                    const childStart = boxStart + header + 4;
                    if (childStart < boxEnd) walk(childStart, boxEnd);
                } else {
                    const childStart = boxStart + header;
                    if (childStart < boxEnd) walk(childStart, boxEnd);
                }
            }

            p = boxEnd;
        }
    };
    walk(0, u8.byteLength);
    return u8;
}
async function dmMp4FastStartRelocateMoov(fileHandle) {
    if (!fileHandle || !fileHandle.getFile || !fileHandle.createWritable) return false;
    const file = await fileHandle.getFile(); // snapshot
    const total = file.size || 0;
    if (total < 16) return false;

    let ftypStart = -1, ftypSize = 0;
    let moovStart = -1, moovSize = 0;
    let mdatStart = -1;

    let off = 0;
    while (off + 8 <= total) {
        const hdr = new Uint8Array(await file.slice(off, Math.min(off + 16, total)).arrayBuffer());
        if (hdr.byteLength < 8) break;
        let size = dmMp4ReadU32BE(hdr, 0);
        const type = dmMp4Ascii4(hdr, 4);
        let header = 8;
        if (size === 0) size = (total - off);
        if (size === 1) {
            const hdr2 = hdr.byteLength >= 16 ? hdr : new Uint8Array(await file.slice(off, off + 16).arrayBuffer());
            if (hdr2.byteLength < 16) break;
            size = dmMp4ReadU64BE(hdr2, 8);
            header = 16;
        }
        if (!size || size < header) break;
        if (off + size > total) break;

        if (type === "ftyp") { ftypStart = off; ftypSize = size; }
        if (type === "mdat" && mdatStart < 0) { mdatStart = off; }
        if (type === "moov") { moovStart = off; moovSize = size; }

        off += size;
    }

    if (ftypStart !== 0 || ftypSize <= 0 || moovStart < 0 || moovSize <= 0) return false;
    if (mdatStart >= 0 && moovStart < mdatStart) return false; // already ok

    const moovBuf = new Uint8Array(await file.slice(moovStart, moovStart + moovSize).arrayBuffer());
    const patchedMoov = dmMp4PatchChunkOffsetsInMoov(moovBuf, moovSize);

    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
        const ftypBuf = new Uint8Array(await file.slice(0, ftypSize).arrayBuffer());
        await writable.write(ftypBuf);
        await writable.write(patchedMoov);

        const mid = file.slice(ftypSize, moovStart);
        const r1 = mid.stream().getReader();
        while (true) {
            const { value, done } = await r1.read();
            if (done) break;
            if (value && value.byteLength) await writable.write(value);
        }

        const after = moovStart + moovSize;
        if (after < total) {
            const tail = file.slice(after, total);
            const r2 = tail.stream().getReader();
            while (true) {
                const { value, done } = await r2.read();
                if (done) break;
                if (value && value.byteLength) await writable.write(value);
            }
        }
    } finally {
        await writable.close();
    }
    return true;
}

function dmParseExtXMapUrl(line, baseUrl) {
    // #EXT-X-MAP:URI="init.mp4",BYTERANGE="..."
    try {
        const m = String(line || "").match(/URI="([^"]+)"/i);
        if (!m || !m[1]) return "";
        const uri = m[1];
        if (/^https?:\/\//i.test(uri)) return uri;
        return new URL(uri, baseUrl).href;
    } catch (_e) {
        return "";
    }
}

function formatBytesDM(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + sizes[i];
}

function formatTimeDM(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(v => v < 10 ? "0" + v : String(v)).join(":");
}

function parseTimeDM(input, defaultValue) {
    if (input === null || input === undefined) return defaultValue;
    let s = String(input).trim();
    if (!s) return defaultValue;

    // Sadece saniye (ör: "120")
    if (/^\d+$/.test(s)) {
        const v = parseInt(s, 10);
        return isNaN(v) ? defaultValue : v;
    }

    const parts = s.split(":").map(p => p.trim()).filter(Boolean);
    if (parts.length === 2) {
        const m = parseInt(parts[0], 10);
        const sec = parseInt(parts[1], 10);
        if (isNaN(m) || isNaN(sec)) return defaultValue;
        return m * 60 + sec;
    }
    if (parts.length === 3) {
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const sec = parseInt(parts[2], 10);
        if (isNaN(h) || isNaN(m) || isNaN(sec)) return defaultValue;
        return h * 3600 + m * 60 + sec;
    }
    return defaultValue;
}

function cloneJobForRange(job, startSec, endSec) {
    const segments = Array.isArray(job.segments) ? job.segments : [];
    if (!segments.length) return null;

    const safeStart = Math.max(0, startSec || 0);
    const safeEnd = Math.max(safeStart, endSec || 0);

    const newSegments = [];
    let acc = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] || {};
        const dur = typeof seg.duration === "number" ? seg.duration : 0;
        const segStart = acc;
        const segEnd = acc + dur;
        acc = segEnd;

        if (segEnd <= safeStart) continue;
        if (segStart >= safeEnd) break;

        newSegments.push({
            url: seg.url,
            index: (typeof seg.index === "number" ? seg.index : i),
            duration: dur
        });
    }

    if (!newSegments.length) return null;

    const newId = Date.now().toString() + "_" + Math.random().toString(16).slice(2);
    const totalDur = Math.max(0, safeEnd - safeStart);

    const clone = {
        id: newId,
        title: job.title,
        pageUrl: job.pageUrl,
        sourceUrl: job.sourceUrl,
        isAudio: job.isAudio,
        audioLang: job.audioLang,
        createdAt: Date.now(),
        totalDuration: totalDur,
        segments: newSegments,
        status: "queued",
        finishedSegments: 0,
        totalBytes: 0
    };

    if (job.customTitle) clone.customTitle = job.customTitle;
    if (job.customSiteLabel) clone.customSiteLabel = job.customSiteLabel;

    return clone;
}

function saveJobs() {
    chrome.storage.local.set({ [STORAGE_KEY]: downloadJobs });
}

function saveJobsThrottled() {
    if (dmSaveTimer) return;
    dmSaveTimer = setTimeout(() => {
        dmSaveTimer = null;
        saveJobs();
    }, DM_SAVE_THROTTLE_MS);
}

function requestRenderJobs() {
    if (dmRenderTimer) return;
    dmRenderTimer = setTimeout(() => {
        dmRenderTimer = null;
        renderJobs();
    }, DM_RENDER_THROTTLE_MS);
}

function loadJobs() {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
        const list = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
        downloadJobs = list;
        renderJobs();
    });
}

function bugiLoadNotificationSettings() {
    chrome.storage.local.get(["notifSoundKey", "notifVolume", "notifCustomSounds"], (res) => {
        if (Array.isArray(res.notifCustomSounds)) {
            bugiCustomNotificationSounds = res.notifCustomSounds.map((s) => ({
                key: s.key,
                label: s.label,
                dataUrl: s.dataUrl,
                kind: "custom"
            }));
        }
        bugiAvailableNotificationSounds = BUGI_BUILTIN_NOTIFICATION_SOUNDS.concat(bugiCustomNotificationSounds);
        if (typeof res.notifSoundKey === "string") {
            bugiNotifSoundKey = res.notifSoundKey;
        }
        if (typeof res.notifVolume === "number") {
            bugiNotifVolume = Math.min(1, Math.max(0, res.notifVolume));
        }
    });
}

function dmUpdateDebugButtonUI(active) {
    const btn = document.getElementById("btn-dm-debug-log");
    if (!btn) return;
    if (active) {
        btn.textContent = dmT("dm.debugSaving");
        btn.style.background = "#d32f2f";
        btn.style.borderColor = "#f44336";
        btn.style.color = "#fff";
        btn.style.fontWeight = "700";
    } else {
        btn.textContent = dmT("dm.debugStart");
        btn.style.background = "";
        btn.style.borderColor = "";
        btn.style.color = "";
        btn.style.fontWeight = "";
    }
}

function bugiPlayCompletedSound() {
    const sound = bugiAvailableNotificationSounds.find((s) => s.key === bugiNotifSoundKey) || bugiAvailableNotificationSounds[0];
    if (!sound) return;
    try {
        const audio = sound.kind === "custom"
            ? new Audio(sound.dataUrl)
            : new Audio(chrome.runtime.getURL(sound.file));
        audio.volume = bugiNotifVolume;
        audio.play().catch(() => {});
    } catch (_e) {
        // Otomatik oynatma engellenirse sessiz geç
    }
}

function bugiRunAutoQueue() {
    if (!bugiAutoQueueAll) return;
    if (activeJobId) return; // Zaten bir iş çalışıyor veya duraklatılmış
    const next = downloadJobs.find(j => j.status === "queued");
    if (!next) {
        bugiAutoQueueAll = false; // Kuyruk bitti
        return;
    }
    startJob(next.id);
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function paginate(list, page, pageSize) {
    const size = Math.max(1, pageSize || 1);
    const totalItems = list.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / size));
    const safePage = clamp(page || 1, 1, totalPages);
    const start = (safePage - 1) * size;
    const end = start + size;
    return {
        totalItems,
        totalPages,
        page: safePage,
        slice: list.slice(start, end)
    };
}

function updatePager(kind, pagination) {
    const pagerEl = document.getElementById(kind + "-pager");
    const infoEl = document.getElementById(kind + "-pager-info");
    const prevBtn = document.getElementById(kind + "-prev");
    const nextBtn = document.getElementById(kind + "-next");
    if (!pagerEl || !infoEl || !prevBtn || !nextBtn) return;

    const show = pagination.totalPages > 1;
    pagerEl.style.display = show ? "flex" : "none";
    infoEl.textContent = dmTf("dm.pagerInfo", {
        total: pagination.totalItems,
        page: pagination.page,
        pages: pagination.totalPages
    });

    prevBtn.disabled = pagination.page <= 1;
    nextBtn.disabled = pagination.page >= pagination.totalPages;
}

class VirtualListDM {
    constructor(containerEl, createEl) {
        this.container = containerEl;
        this.createEl = createEl;
        this.items = [];
        this.heights = [];
        this.prefix = [0]; // prefix[i] = top of item i
        // Conservative default: avoid overlap before first measurements
        this.estimatedHeight = 320; // px
        this.overscan = 6;
        this._raf = null;
        this._measuring = false;
        this.cache = new Map(); // key -> DOM element

        this.container.style.position = "relative";
        // Ensure scroll works even if CSS flex sizing differs across browsers/zoom
        this.container.style.overflowY = "auto";
        this.container.style.overflowX = "hidden";
        this.container.style.minHeight = "0";
        this.container.style.height = "100%";

        this.spacer = document.createElement("div");
        this.spacer.style.height = "0px";
        this.inner = document.createElement("div");
        this.inner.style.position = "absolute";
        this.inner.style.top = "0";
        this.inner.style.left = "0";
        this.inner.style.right = "0";

        this.container.innerHTML = "";
        this.container.appendChild(this.spacer);
        this.container.appendChild(this.inner);

        this.container.addEventListener("scroll", () => this.scheduleRender());
        window.addEventListener("resize", () => this.scheduleRender());
    }

    getCached(key) {
        return this.cache.get(String(key));
    }

    setItems(items) {
        this.items = Array.isArray(items) ? items : [];
        const n = this.items.length;
        if (this.heights.length !== n) {
            this.heights = Array.from({ length: n }, () => this.estimatedHeight);
        } else {
            // If items changed but length is same, keep previous measurements but never go below estimate
            for (let i = 0; i < n; i++) {
                this.heights[i] = Math.max(this.heights[i] || this.estimatedHeight, this.estimatedHeight);
            }
        }
        this.rebuildPrefix();
        this.scheduleRender(true);
    }

    rebuildPrefix() {
        const n = this.items.length;
        this.prefix = new Array(n + 1);
        this.prefix[0] = 0;
        for (let i = 0; i < n; i++) {
            this.prefix[i + 1] = this.prefix[i] + (this.heights[i] || this.estimatedHeight);
        }
        const computedTotal = this.prefix[n] || 0;
        // Defensive: never let total collapse (would kill scroll range)
        const total = Math.max(computedTotal, n * (this.estimatedHeight || 1));
        this.spacer.style.height = total + "px";
        this.inner.style.height = total + "px";
    }

    findIndexAt(offset) {
        // binary search on prefix
        let lo = 0;
        let hi = this.items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.prefix[mid + 1] <= offset) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    scheduleRender(force = false) {
        if (force) {
            if (this._raf) cancelAnimationFrame(this._raf);
            this._raf = null;
        }
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = null;
            this.render();
        });
    }

    render() {
        const n = this.items.length;
        if (n === 0) {
            this.inner.replaceChildren();
            this.spacer.style.height = "0px";
            return;
        }
        const scrollTop = this.container.scrollTop || 0;
        const viewH = this.container.clientHeight || 0;
        const start = Math.max(0, this.findIndexAt(scrollTop) - this.overscan);
        const end = Math.min(n, this.findIndexAt(scrollTop + viewH) + this.overscan);

        const nodes = [];
        for (let i = start; i < end; i++) {
            const job = this.items[i];
            const key = String(job && job.id != null ? job.id : i);
            let el = this.cache.get(key);
            if (!el) {
                el = this.createEl(job);
                this.cache.set(key, el);
            } else if (typeof updateJobCardElement === "function") {
                // reuse node, update content in-place
                updateJobCardElement(el, job);
            }
            el.style.position = "absolute";
            el.style.left = "0";
            el.style.right = "0";
            el.style.top = (this.prefix[i] || 0) + "px";
            nodes.push(el);
        }
        this.inner.replaceChildren(...nodes);

        // Measure rendered items to refine heights (avoid overlap on varying content)
        if (this._measuring) return;
        this._measuring = true;
        requestAnimationFrame(() => {
            try {
                let changed = false;
                const children = Array.from(this.inner.children);
                for (let idx = 0; idx < children.length; idx++) {
                    const child = children[idx];
                    const itemIndex = start + idx;
                    const h = child.offsetHeight || this.estimatedHeight;
                    const prev = this.heights[itemIndex] || this.estimatedHeight;
                    if (Math.abs(h - prev) > 2) {
                        this.heights[itemIndex] = h;
                        changed = true;
                    }
                }
                if (changed) {
                    // Update estimate slowly toward average of visible items
                    const sample = children.map((c) => c.offsetHeight || this.estimatedHeight);
                    if (sample.length) {
                        const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
                        this.estimatedHeight = Math.max(120, Math.min(420, Math.round((this.estimatedHeight * 0.8) + (avg * 0.2))));
                    }
                    this.rebuildPrefix();
                    this.scheduleRender(true);
                }
            } finally {
                this._measuring = false;
            }
        });
    }
}

function computeDisplayNameDM(job) {
    let displayName = job.customTitle || job.outputName || job.title || dmT("dm.unnamedVideo");
    const lowerName = String(displayName).toLowerCase();
    // job.isMp4: tek parça MP4 URL indirme işi
    // job.outputMp4: HLS fMP4 (EXT-X-MAP) akışı; init + parçaları birleştir
    // job.transmuxToMp4: TS segmentleri mux.js ile fMP4'e dönüştür
    const wantsMp4 = !!job.isMp4 || !!job.outputMp4 || !!job.transmuxToMp4;
    if (wantsMp4) {
        if (!lowerName.endsWith(".mp4")) displayName += ".mp4";
    } else {
        if (!lowerName.endsWith(".ts")) displayName += ".ts";
    }
    return displayName;
}

function computeStatusTextDM(job) {
    if (job.status === "downloading") return dmT("dm.statusDownloading");
    if (job.status === "finalizing") return dmT("dm.statusFinalizing");
    if (job.status === "paused") return job._autoPaused ? dmT("dm.statusPausedOffline") : dmT("dm.statusPaused");
    if (job.status === "completed") return dmT("dm.statusCompleted");
    if (job.status === "error") return dmT("dm.statusError");
    if (job.status === "cancelled") return dmT("dm.statusCancelled");
    return dmT("dm.statusQueued");
}

function formatDateTimeDM(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
}

function computeProgressDM(job) {
    const isMp4Job = !!job.isMp4;
    const totalSegsRaw = (job.segments && job.segments.length) || 0;
    let doneSegsRaw = job.finishedSegments || 0;
    if (job.status === "finalizing" && totalSegsRaw > 0) doneSegsRaw = totalSegsRaw;
    const totalSegs = isMp4Job ? 1 : totalSegsRaw;
    const doneSegs = isMp4Job ? (job.status === "completed" ? 1 : 0) : doneSegsRaw;
    const percent = totalSegs ? (doneSegs / totalSegs) * 100 : 0;
    return { isMp4Job, totalSegsRaw, doneSegsRaw, totalSegs, doneSegs, percent };
}

function renderJobActionsDM(job, actionsEl) {
    if (!actionsEl) return;
    actionsEl.replaceChildren();

    const openBtn = document.createElement("button");
    openBtn.textContent = dmT("dm.btnOpenPage");
    openBtn.onclick = () => {
        if (job.pageUrl) window.open(job.pageUrl, "_blank");
    };
    actionsEl.appendChild(openBtn);

    if (job.status === "queued") {
        const startBtn = document.createElement("button");
        startBtn.textContent = dmT("dm.btnStart");
        startBtn.onclick = () => startJob(job.id);
        actionsEl.appendChild(startBtn);
    } else if (job.status === "downloading") {
        const pauseBtn = document.createElement("button");
        pauseBtn.textContent = dmT("dm.btnPause");
        pauseBtn.onclick = () => pauseJob(job.id, false);
        actionsEl.appendChild(pauseBtn);
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = dmT("dm.btnCancel");
        cancelBtn.onclick = () => cancelJob(job.id);
        actionsEl.appendChild(cancelBtn);
    } else if (job.status === "finalizing") {
        const hint = document.createElement("span");
        hint.style.fontSize = "11px";
        hint.style.color = "#aaa";
        hint.textContent = dmT("dm.finalizingHint");
        actionsEl.appendChild(hint);
    } else if (job.status === "paused") {
        const resumeBtn = document.createElement("button");
        resumeBtn.textContent = dmT("dm.btnResume");
        resumeBtn.onclick = () => resumeJob(job.id);
        actionsEl.appendChild(resumeBtn);
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = dmT("dm.btnCancel");
        cancelBtn.onclick = () => cancelJob(job.id);
        actionsEl.appendChild(cancelBtn);
    } else if (job.status === "completed" || job.status === "error") {
        const retryBtn = document.createElement("button");
        retryBtn.textContent = job.status === "error" ? dmT("dm.btnRetry") : dmT("dm.btnRedownload");
        retryBtn.className = "job-btn-retry";
        if (job.isMp4) {
            retryBtn.onclick = () => startJob(job.id);
        } else {
            retryBtn.onclick = () => openRetryDialog(job.id);
        }
        actionsEl.appendChild(retryBtn);
    }
}

function updateJobCardElement(card, job) {
    if (!card || !job) return;
    const refs = card._refs || {};
    if (!card._refs) card._refs = refs;

    // lazily discover refs once
    if (!refs.title) refs.title = card.querySelector(".js-job-title") || card.querySelector(".job-title");
    if (!refs.status) refs.status = card.querySelector(".js-job-status");
    if (!refs.created) refs.created = card.querySelector(".js-job-created");
    if (!refs.site) refs.site = card.querySelector(".js-job-site");
    if (!refs.fill) refs.fill = card.querySelector(".js-job-progress");
    if (!refs.stats) refs.stats = card.querySelector(".js-job-stats");
    if (!refs.footerLeft) refs.footerLeft = card.querySelector(".js-job-footer-left");
    if (!refs.actions) refs.actions = card.querySelector(".js-job-actions");

    if (refs.title) refs.title.textContent = computeDisplayNameDM(job);
    if (refs.status) refs.status.textContent = computeStatusTextDM(job);

    // created line
    if (refs.created) {
        if (job.status !== "completed" && job.createdAt) {
            refs.created.style.display = "";
            refs.created.textContent = dmTf("dm.createdLine", { date: formatDateTimeDM(job.createdAt) });
        } else {
            refs.created.style.display = "none";
            refs.created.textContent = "";
        }
    }

    // site/meta top
    if (refs.site) {
        const host = (() => {
            try { return new URL(job.pageUrl || job.sourceUrl || "").hostname || ""; } catch (_e) { return ""; }
        })();
        const startStr = job.startTime ? formatDateTimeDM(job.startTime) : "";
        const endStr = job.endTime ? formatDateTimeDM(job.endTime) : "";
        const urlLabel = job.pageUrl || job.sourceUrl || "";
        if (job.customSiteLabel) {
            const timePart = [startStr, endStr].filter(Boolean).join(" - ");
            refs.site.textContent = timePart ? `${job.customSiteLabel} • ${timePart}` : job.customSiteLabel;
        } else {
            const parts = [];
            parts.push("Site");
            if (host) parts.push(host);
            if (urlLabel) parts.push(urlLabel);
            if (startStr || endStr) parts.push([startStr, endStr].filter(Boolean).join(" - "));
            refs.site.textContent = parts.join(" • ");
        }
    }

    const { isMp4Job, totalSegs, doneSegs, percent } = computeProgressDM(job);
    if (refs.fill) refs.fill.style.width = percent.toFixed(1) + "%";

    // stats line (elapsed/remain/speed)
    if (refs.stats) {
        const hasStarted = !!job.startTime;
        let elapsedStr = "";
        let remainStr = "";
        let speedStr = "";
        if (hasStarted) {
            const now = Date.now();
            let endMs;
            if (job.status === "paused" && job.pauseTime) {
                endMs = job.pauseTime;
            } else if (job.endTime && (job.status === "completed" || job.status === "error" || job.status === "cancelled")) {
                endMs = job.endTime;
            } else {
                endMs = now;
            }
            const elapsedSec = Math.max(0.001, (endMs - job.startTime) / 1000);
            elapsedStr = `${dmT("content.statElapsed")} ${formatTimeDM(Math.floor(elapsedSec))}`;

            const totalBytes = job.totalBytes || 0;
            const avgSpeedBps = totalBytes / elapsedSec; // byte/s
            if (avgSpeedBps > 0) {
                const mbPerSec = totalBytes / (1024 * 1024) / elapsedSec;
                const mbps = (avgSpeedBps * 8) / (1024 * 1024);
                speedStr = `${dmT("content.statSpeed")} ${mbPerSec.toFixed(2)} MB/s (${mbps.toFixed(1)} Mbps)`;
            } else {
                speedStr =
                    job.status === "downloading"
                        ? `${dmT("content.statSpeed")} ${dmT("media.calculatingBlock")}`
                        : `${dmT("content.statSpeed")} 0`;
            }

            if (job.status === "finalizing") {
                remainStr = dmT("dm.statClosingFile");
                if (avgSpeedBps > 0) {
                    const mbPerSec = totalBytes / (1024 * 1024) / elapsedSec;
                    const mbps = (avgSpeedBps * 8) / (1024 * 1024);
                    speedStr = `${dmT("dm.statAvgSpeed")} ${mbPerSec.toFixed(2)} MB/s (${mbps.toFixed(1)} Mbps)`;
                }
            } else if (job.status === "downloading" && doneSegs > 0 && avgSpeedBps > 0) {
                const avgSegSize = totalBytes / doneSegs;
                const remainingSegs = totalSegs - doneSegs;
                const remainingBytes = remainingSegs * avgSegSize;
                const remainingSec = remainingBytes / avgSpeedBps;
                remainStr = `${dmT("content.statRemaining")} ${formatTimeDM(remainingSec)}`;
            } else if (job.status === "completed") {
                remainStr = dmT("dm.remainZero");
            }
        }
        const pieces = [elapsedStr, remainStr, speedStr];
        if (job.errorCount && job.errorCount > 0) {
            pieces.push(`${dmT("content.statErrors")} ${job.errorCount}`);
        }
        refs.stats.textContent = pieces.filter(Boolean).join(" • ");
    }

    // footer left
    if (refs.footerLeft) {
        const sizeStr = job.totalBytes
            ? formatBytesDM(job.totalBytes)
            : job.estimatedBytes
              ? "~" + formatBytesDM(job.estimatedBytes)
              : `${dmT("content.statSize")} ${dmT("media.calculatingBlock")}`;
        const durStr = job.totalDuration ? formatTimeDM(job.totalDuration) : "";
        if (isMp4Job) {
            refs.footerLeft.textContent = `${dmT("dm.footerMp4Label")}${durStr ? ` • ${durStr}` : ""}${sizeStr ? ` • ${sizeStr}` : ""}`;
        } else {
            refs.footerLeft.textContent =
                (totalSegs ? dmTf("dm.segmentsProgress", { done: doneSegs, total: totalSegs }) : "") +
                (durStr ? ` • ${durStr}` : "") +
                (sizeStr ? ` • ${sizeStr}` : "");
        }
    }

    // actions only if status changed (avoid button churn on every tick)
    if (refs.actions) {
        const lastStatus = card._lastStatus;
        if (lastStatus !== job.status) {
            card._lastStatus = job.status;
            renderJobActionsDM(job, refs.actions);
        }
    }
}

function updateLiveJobUI(job) {
    if (!job || !job.id) return;
    const id = String(job.id);
    const el = dmPendingCardCache.get(id) || dmCompletedCardCache.get(id);
    if (el && el.isConnected) updateJobCardElement(el, job);
    const totalEl = document.getElementById("summary-total");
    const activeEl = document.getElementById("summary-active");
    if (totalEl) totalEl.textContent = dmTf("dm.summaryTotal", { n: downloadJobs.length });
    if (activeEl) {
        const pending = downloadJobs.filter(j => j.status !== "completed");
        const activeCount = pending.filter(j => j.status === "downloading" || j.status === "finalizing").length;
        activeEl.textContent = dmTf("dm.summaryActive", { n: activeCount });
    }
}

function renderListInPlace(containerEl, jobs, cache) {
    if (!containerEl) return;
    const existing = new Map();
    Array.from(containerEl.children).forEach((child) => {
        const id = child && child.dataset ? child.dataset.jobId : null;
        if (id) existing.set(String(id), child);
    });

    const used = new Set();
    // Do NOT force scrollTop here; it can make scrolling feel "locked"
    for (const job of jobs) {
        const id = String(job.id);
        let el = existing.get(id);
        if (!el) el = createJobCard(job);
        else updateJobCardElement(el, job);
        used.add(id);
        cache.set(id, el);
        containerEl.appendChild(el); // moves to correct order
    }
    // Remove leftovers
    for (const [id, el] of existing.entries()) {
        if (!used.has(id)) {
            try { el.remove(); } catch (_e) {}
            cache.delete(id);
        }
    }
}

function renderJobs() {
    const leftEl = document.getElementById("downloads-left-list");
    const rightEl = document.getElementById("downloads-right-list");
    const emptyCompletedEl = document.getElementById("completed-empty");
    const emptyPendingEl = document.getElementById("pending-empty");
    const totalEl = document.getElementById("summary-total");
    const activeEl = document.getElementById("summary-active");
    if (!leftEl || !rightEl) return;

    // Lists are updated in-place; do not wipe DOM each tick

    const completed = downloadJobs.filter(j => j.status === "completed");
    const pending = downloadJobs.filter(j => j.status !== "completed");

    const activeCount = pending.filter(j => j.status === "downloading" || j.status === "finalizing").length;

    const q = (searchQuery || "").trim().toLowerCase();
    let completedToRender = completed;
    if (q) {
        completedToRender = completed.filter((job) => {
            const name = (job.customTitle || job.outputName || job.title || "").toString();
            const url = (job.pageUrl || job.sourceUrl || "").toString();
            const sizeStr = job.totalBytes ? formatBytesDM(job.totalBytes) : (job.estimatedBytes ? formatBytesDM(job.estimatedBytes) : "");
            const start = job.startTime ? new Date(job.startTime) : null;
            const end = job.endTime ? new Date(job.endTime) : null;
            const fmt = (d) => {
                if (!d) return "";
                const dd = String(d.getDate()).padStart(2, "0");
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const yyyy = d.getFullYear();
                const hh = String(d.getHours()).padStart(2, "0");
                const mi = String(d.getMinutes()).padStart(2, "0");
                const ss = String(d.getSeconds()).padStart(2, "0");
                return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
            };
            const dateStr = [fmt(start), fmt(end)].filter(Boolean).join(" ");
            const haystack = [name, url, sizeStr, dateStr].join(" ").toLowerCase();
            return haystack.includes(q);
        });
    }

    const completedSorted = completedToRender
        .slice()
        .sort((a, b) => {
            const ta = a.endTime || a.createdAt || 0;
            const tb = b.endTime || b.createdAt || 0;
            return completedSortAsc ? ta - tb : tb - ta;
        });

    const pendingSorted = pending
        .slice()
        .filter((job) => {
            if (!q) return true;
            const name = (job.customTitle || job.outputName || job.title || "").toString();
            const url = (job.pageUrl || job.sourceUrl || "").toString();
            const sizeStr = job.totalBytes ? formatBytesDM(job.totalBytes) : (job.estimatedBytes ? formatBytesDM(job.estimatedBytes) : "");
            const start = job.startTime ? new Date(job.startTime) : null;
            const end = job.endTime ? new Date(job.endTime) : null;
            const fmt = (d) => {
                if (!d) return "";
                const dd = String(d.getDate()).padStart(2, "0");
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const yyyy = d.getFullYear();
                const hh = String(d.getHours()).padStart(2, "0");
                const mi = String(d.getMinutes()).padStart(2, "0");
                const ss = String(d.getSeconds()).padStart(2, "0");
                return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
            };
            const dateStr = [fmt(start), fmt(end)].filter(Boolean).join(" ");
            const haystack = [name, url, sizeStr, dateStr].join(" ").toLowerCase();
            return haystack.includes(q);
        })
        .sort((a, b) => {
            const pa = a.createdAt || 0;
            const pb = b.createdAt || 0;
            return pendingSortAsc ? pa - pb : pb - pa;
        });

    // UI'da pager butonları yoksa kullanıcı ikinci sayfaya geçemez.
    // Bu durumda "sayfalama"yı tamamen kapatıp tüm kayıtları gösteriyoruz.
    const canPaginate =
        !!(document.getElementById("completed-prev") &&
           document.getElementById("completed-next") &&
           document.getElementById("pending-prev") &&
           document.getElementById("pending-next"));

    const completedPagination = canPaginate
        ? paginate(completedSorted, completedPage, dmPageSize)
        : {
            totalItems: completedSorted.length,
            totalPages: 1,
            page: 1,
            slice: completedSorted
        };
    completedPage = completedPagination.page;

    const pendingPagination = canPaginate
        ? paginate(pendingSorted, pendingPage, dmPageSize)
        : {
            totalItems: pendingSorted.length,
            totalPages: 1,
            page: 1,
            slice: pendingSorted
        };
    pendingPage = pendingPagination.page;

    // Empty state (arama varsa mesajı değiştir)
    if (emptyCompletedEl) {
        if (completedPagination.totalItems === 0) {
            emptyCompletedEl.style.display = "block";
            emptyCompletedEl.textContent = q ? dmT("dm.emptyCompletedSearch") : dmT("dm.emptyCompleted");
        } else {
            emptyCompletedEl.style.display = "none";
        }
    }
    if (emptyPendingEl) {
        if (pendingPagination.totalItems === 0) {
            emptyPendingEl.style.display = "block";
            emptyPendingEl.innerHTML = q ? dmT("dm.emptyPendingSearch") : dmT("dm.emptyPendingHtml");
        } else {
            emptyPendingEl.style.display = "none";
        }
    }

    // Pagers
    updatePager("completed", completedPagination);
    updatePager("pending", pendingPagination);

    renderListInPlace(leftEl, completedPagination.slice, dmCompletedCardCache);
    renderListInPlace(rightEl, pendingPagination.slice, dmPendingCardCache);

    if (totalEl) totalEl.textContent = dmTf("dm.summaryTotal", { n: downloadJobs.length });
    if (activeEl) activeEl.textContent = dmTf("dm.summaryActive", { n: activeCount });
}

function createJobCard(job) {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.jobId = String(job.id);

    const header = document.createElement("div");
    header.className = "job-header";
    const title = document.createElement("div");
    title.className = "job-title";
    title.classList.add("js-job-title");
    // 1. satır: Dosya adı (uzantıyı tipine göre koru)
    title.textContent = computeDisplayNameDM(job);
    title.style.cursor = "text";
    title.title = dmT("dm.titleEditHint");
    title.onclick = (e) => {
        e.stopPropagation();
        startInlineEditTitle(job.id, title);
    };
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✖";
    closeBtn.style.border = "none";
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "#888";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "14px";
    closeBtn.style.marginLeft = "4px";
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        removeJob(job.id);
    };
    header.appendChild(closeBtn);

    card.appendChild(header);

    // 2. satır: Durum
    const statusLine = document.createElement("div");
    statusLine.className = "job-meta js-job-status";
    statusLine.textContent = computeStatusTextDM(job);
    card.appendChild(statusLine);

    // Sıradaki / aktif işler için oluşturulma zamanı
    const createdLine = document.createElement("div");
    createdLine.className = "job-meta js-job-created";
    if (job.status !== "completed" && job.createdAt) {
        createdLine.textContent = dmTf("dm.createdLine", { date: formatDateTimeDM(job.createdAt) });
    } else {
        createdLine.style.display = "none";
    }
    card.appendChild(createdLine);

    // 3. satır: Site • URL • başlangıç - bitiş
    const metaTop = document.createElement("div");
    metaTop.className = "job-meta js-job-site";
    const host = (() => {
        try { return new URL(job.pageUrl || job.sourceUrl || "").hostname || ""; } catch (_e) { return ""; }
    })();
    const startDate = job.startTime ? new Date(job.startTime) : null;
    const endDate = job.endTime ? new Date(job.endTime) : null;
    const fmt = (d) => {
        if (!d) return "";
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
    };
    const startStr = fmt(startDate);
    const endStr = fmt(endDate);
    const urlLabel = (() => {
        const u = job.pageUrl || job.sourceUrl || "";
        return u ? u : "";
    })();

    if (job.customSiteLabel) {
        const timePart = [startStr, endStr].filter(Boolean).join(" - ");
        metaTop.textContent = timePart ? `${job.customSiteLabel} • ${timePart}` : job.customSiteLabel;
    } else {
        const parts = [];
        parts.push("Site");
        if (host) parts.push(host);
        if (urlLabel) parts.push(urlLabel);
        if (startStr || endStr) parts.push([startStr, endStr].filter(Boolean).join(" - "));
        metaTop.textContent = parts.join(" • ");
    }
    metaTop.style.cursor = "text";
    metaTop.title = dmT("dm.siteEditHint");
    metaTop.onclick = (e) => {
        e.stopPropagation();
        startInlineEditSite(job.id, metaTop);
    };
    card.appendChild(metaTop);

    // 4. satır: Geçen / Kalan / Hız
    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = "progress-fill js-job-progress";
    const { isMp4Job, totalSegs, doneSegs, percent } = computeProgressDM(job);
    fill.style.width = percent.toFixed(1) + "%";
    progressBar.appendChild(fill);
    card.appendChild(progressBar);

    const statsLine = document.createElement("div");
    statsLine.className = "job-meta js-job-stats";
    const hasStarted = !!job.startTime;
    let elapsedStr = "";
    let remainStr = "";
    let speedStr = "";

    if (hasStarted) {
        const now = Date.now();
        let endMs;
        if (job.status === "paused" && job.pauseTime) {
            endMs = job.pauseTime;
        } else if (job.endTime && (job.status === "completed" || job.status === "error" || job.status === "cancelled")) {
            endMs = job.endTime;
        } else {
            endMs = now;
        }
        const elapsedSec = Math.max(0.001, (endMs - job.startTime) / 1000);
        elapsedStr = `${dmT("content.statElapsed")} ${formatTimeDM(Math.floor(elapsedSec))}`;

        const totalBytes = job.totalBytes || 0;
        const avgSpeedBps = totalBytes / elapsedSec; // byte/s
        if (avgSpeedBps > 0) {
            const mbPerSec = totalBytes / (1024 * 1024) / elapsedSec;
            const mbps = (avgSpeedBps * 8) / (1024 * 1024);
            speedStr = `${dmT("content.statSpeed")} ${mbPerSec.toFixed(2)} MB/s (${mbps.toFixed(1)} Mbps)`;
        } else {
            speedStr =
                job.status === "downloading"
                    ? `${dmT("content.statSpeed")} ${dmT("media.calculatingBlock")}`
                    : `${dmT("content.statSpeed")} 0`;
        }

        if (job.status === "finalizing") {
            remainStr = dmT("dm.statClosingFile");
            if (avgSpeedBps > 0) {
                const mbPerSec = totalBytes / (1024 * 1024) / elapsedSec;
                const mbps = (avgSpeedBps * 8) / (1024 * 1024);
                speedStr = `${dmT("dm.statAvgSpeed")} ${mbPerSec.toFixed(2)} MB/s (${mbps.toFixed(1)} Mbps)`;
            }
        } else if (job.status === "downloading" && doneSegs > 0 && avgSpeedBps > 0) {
            const avgSegSize = totalBytes / doneSegs;
            const remainingSegs = totalSegs - doneSegs;
            const remainingBytes = remainingSegs * avgSegSize;
            const remainingSec = remainingBytes / avgSpeedBps;
            remainStr = `${dmT("content.statRemaining")} ${formatTimeDM(remainingSec)}`;
        } else if (job.status === "completed") {
            remainStr = dmT("dm.remainZero");
        }
    }

    const pieces = [elapsedStr, remainStr, speedStr];
    if (job.errorCount && job.errorCount > 0) {
        pieces.push(`${dmT("content.statErrors")} ${job.errorCount}`);
    }
    statsLine.textContent = pieces.filter(Boolean).join(" • ");
    card.appendChild(statsLine);

    // 5. satır: parça sayısı / süre / boyut
    const footer = document.createElement("div");
    footer.className = "job-footer";
    const left = document.createElement("div");
    left.classList.add("js-job-footer-left");
    const sizeStr = job.totalBytes
        ? formatBytesDM(job.totalBytes)
        : job.estimatedBytes
          ? "~" + formatBytesDM(job.estimatedBytes)
          : `${dmT("content.statSize")} ${dmT("media.calculatingBlock")}`;
    const durStr = job.totalDuration ? formatTimeDM(job.totalDuration) : "";
    if (isMp4Job) {
        left.textContent = `${dmT("dm.footerMp4Label")}${durStr ? ` • ${durStr}` : ""}${sizeStr ? ` • ${sizeStr}` : ""}`;
    } else {
        left.textContent =
            (totalSegs ? dmTf("dm.segmentsProgress", { done: doneSegs, total: totalSegs }) : "") +
            (durStr ? ` • ${durStr}` : "") +
            (sizeStr ? ` • ${sizeStr}` : "");
    }

    const right = document.createElement("div");
    right.className = "job-actions js-job-actions";
    card._lastStatus = job.status;
    renderJobActionsDM(job, right);

    footer.appendChild(left);
    footer.appendChild(right);
    card.appendChild(footer);

    // cache refs for fast in-place update
    card._refs = { title, status: statusLine, created: createdLine, site: metaTop, fill, stats: statsLine, footerLeft: left, actions: right };

    // Orijinal başlık / site bilgilerini, kullanıcı sonradan değiştirdiyse göster
    (function () {
        const captured = job.captured || {};
        const origTitle = captured.originalTitle || "";
        const origUrl = captured.originalPageUrl || "";
        let origHost = captured.originalHost || "";
        if (!origHost && origUrl) {
            try { origHost = new URL(origUrl).hostname || ""; } catch (_e) {}
        }

        const hasCustomTitle = !!job.customTitle;
        const hasCustomSite = !!job.customSiteLabel;
        const urlChanged = !!(origUrl && job.pageUrl && job.pageUrl !== origUrl);
        const shouldShow = (hasCustomTitle && !!origTitle) || hasCustomSite || urlChanged;
        if (!shouldShow) return;

        const dev = document.createElement("div");
        dev.className = "job-meta";
        dev.style.marginTop = "4px";
        dev.style.fontSize = "10px";
        dev.style.color = "#777";
        const parts = [];
        if (origTitle) parts.push(dmTf("dm.devOriginalTitle", { title: origTitle }));
        if (origHost) parts.push(dmTf("dm.devOriginalSite", { host: origHost }));
        if (origUrl) parts.push(dmTf("dm.devOriginalUrl", { url: origUrl }));
        dev.textContent = parts.join("  ");
        card.appendChild(dev);
    })();

    // Hata alan işler için: son hatayı ve sorunlu segmenti açma butonu
    if (job.status === "error" && Array.isArray(job.failedSegments) && job.failedSegments.length) {
        const err = document.createElement("div");
        err.className = "job-meta";
        err.style.marginTop = "4px";
        const msg = job.lastError ? dmTf("dm.errorLastPrefix", { msg: job.lastError }) : dmT("dm.errorDetailPresent");
        const textSpan = document.createElement("span");
        textSpan.textContent = msg + " ";
        err.appendChild(textSpan);

        const btn = document.createElement("button");
        btn.textContent = dmT("dm.openErrorChunk");
        btn.style.marginLeft = "4px";
        btn.onclick = () => {
            const firstFail = job.failedSegments && job.failedSegments[0];
            if (firstFail && firstFail.url) {
                try { window.open(firstFail.url, "_blank"); } catch (_e) {}
            }
        };
        err.appendChild(btn);
        card.appendChild(err);
    }

    return card;
}

function renderJobCard(job, containerEl) {
    containerEl.appendChild(createJobCard(job));
}

function findJob(id) {
    return downloadJobs.find(j => j.id === id);
}

function removeJob(id) {
    const job = findJob(id);
    if (!job) return;
    if (job.status === "downloading" || job.status === "finalizing") {
        alert(dmT("dm.alertDeleteActiveWait"));
        return;
    }
    downloadJobs = downloadJobs.filter(j => j.id !== id);
    saveJobs();
    renderJobs();
}

function cancelJob(id) {
    const job = findJob(id);
    if (!job) return;
    if (job.status === "finalizing") {
        alert(dmT("dm.alertFinalizingWait"));
        return;
    }
    job._cancelRequested = true;
    job._paused = false;
    job._autoPaused = false;
    job.status = "cancelled";
    activeJobId = null;
    dmUpdateBgThrottleHint();
    saveJobs();
    renderJobs();
}

function pauseJob(id, isAuto) {
    const job = findJob(id);
    if (!job || job.status !== "downloading") return;
    job._paused = true;
    job._autoPaused = !!isAuto;
    job.pauseTime = Date.now();
    job.status = "paused";
    saveJobs();
    renderJobs();
}

function resumeJob(id) {
    const job = findJob(id);
    if (!job || job.status !== "paused") return;
    if (!navigator.onLine) {
        alert(dmT("dm.alertOfflineTryLater"));
        return;
    }
    job._paused = false;
    job._autoPaused = false;
    job.pauseTime = null;
    job.status = "downloading";
    saveJobs();
    renderJobs();
}

function addJob(job) {
    if (!job || !job.id) return;
    if (downloadJobs.some(j => j.id === job.id)) return;
    job.status = "queued";
    job.finishedSegments = 0;
    job.totalBytes = 0;
    job.errorCount = job.errorCount || 0;
    job.lastError = job.lastError || "";
    downloadJobs.push(job);
    saveJobs();
    renderJobs();
    if (bugiAutoQueueAll && !activeJobId) {
        bugiRunAutoQueue();
    }
}


async function openRetryDialog(id) {
    const job = findJob(id);
    if (!job) return;

    const existing = document.getElementById("retry-modal-backdrop");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "retry-modal-backdrop";
    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);

    const snap = await dmEnsureSnapshot(job);
    if (snap && snap.masterBody && String(snap.masterBody).includes("#EXT-X-STREAM-INF")) {
        dmOpenMasterMenu(job, snap, backdrop, {
            defaultResumeIndex: typeof job.finishedSegments === "number" ? job.finishedSegments : 0
        });
        return;
    }

    // Master yoksa: en azından tek kalite / playlist akışını taklit et
    if (snap && snap.analyzedBody && snap.analyzedUrl) {
        dmOpenSingleConfirm(job, snap, backdrop, {
            defaultResumeIndex: typeof job.finishedSegments === "number" ? job.finishedSegments : 0
        });
        return;
    }

    // Son fallback: elimizde sadece segment listesi var (eski kayıtlar)
    if (job.segments && job.segments.length) {
        dmOpenRangeFromSegments(job, dmSegmentsFromJob(job), backdrop, job.sourceUrl || job.pageUrl || "", {
            defaultResumeIndex: typeof job.finishedSegments === "number" ? job.finishedSegments : 0
        });
        return;
    }

    alert(dmT("dm.alertNoRedownload"));
}

async function dmEnsureSnapshot(job) {
    job.captured = job.captured || {};
    if (job.captured.snapshot) return job.captured.snapshot;

    // Eski kayıtlar için: captured.playlists veya sourceUrl üzerinden snapshot üretmeye çalış
    const snap = {
        v: 1,
        masterUrl: "",
        masterBody: "",
        variantBodies: {},
        audioBodies: {},
        analyzedUrl: "",
        analyzedBody: "",
        analyzedBw: 0,
        analyzedIsAudio: !!job.isAudio,
        analyzedAudioLang: job.audioLang || ""
    };

    const src = job.sourceUrl || "";
    const captured = job.captured || {};
    let body = "";
    try {
        if (captured.playlists && src && captured.playlists[src]) {
            body = dmTryDecodeBase64Playlist(captured.playlists[src]);
        }
    } catch (_e) {}

    // Önce sourceUrl için dene
    if (body && String(body).includes("#EXT-X-STREAM-INF")) {
        snap.masterUrl = src;
        snap.masterBody = body;
    } else if (body && String(body).includes("#EXTINF:")) {
        snap.analyzedUrl = src;
        snap.analyzedBody = body;
        snap.analyzedBw = 2000000;
    }

    // Eğer hala master/analyzed bulunamadıysa, background'daki intercept hafızasından
    // sayfaya ait en iyi playlist'i almaya çalış (evrensel, domain bağımsız çözüm).
    if (!snap.masterBody && !snap.analyzedBody) {
        const pageUrl = (job.pageUrl || (captured && captured.originalPageUrl) || "").trim();
        if (pageUrl && chrome && chrome.runtime && chrome.runtime.sendMessage) {
            try {
                const res = await new Promise((resolve) => {
                    try {
                        chrome.runtime.sendMessage(
                            { action: "GET_BEST_PLAYLIST_FOR_PAGE", pageUrl },
                            (resp) => resolve(resp || null)
                        );
                    } catch (_e) {
                        resolve(null);
                    }
                });
                if (res && res.found && res.body) {
                    const text = String(res.body);
                    if (text.includes("#EXT-X-STREAM-INF")) {
                        snap.masterUrl = res.url || src || pageUrl;
                        snap.masterBody = text;
                    } else if (text.includes("#EXTINF:")) {
                        snap.analyzedUrl = res.url || src || pageUrl;
                        snap.analyzedBody = text;
                        snap.analyzedBw = 2000000;
                    }
                }
            } catch (_e) {}
        }
    }

    // En azından segment listesi varsa analyzed olarak kur
    if (!snap.masterBody && !snap.analyzedBody && Array.isArray(job.segments) && job.segments.length) {
        snap.analyzedUrl = src || (job.pageUrl || "");
        snap.analyzedBody = ""; // yok
        snap.analyzedBw = 2000000;
    }

    // Eğer hiçbir veri yoksa null döndür
    const hasSomething = !!(snap.masterBody || snap.analyzedBody || (job.segments && job.segments.length));
    if (!hasSomething) return null;

    job.captured.snapshot = snap;
    saveJobs();
    return snap;
}

function dmInferPreviewMode(url) {
    const u = String(url || "").toLowerCase();
    if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(u)) return "mp4";
    return "hls";
}

function dmOpenBugiPreview({ url, mode, referer, rangeStartSec, rangeEndSec }) {
    if (!url) return;
    const existing = document.getElementById("idm-preview-window");
    if (existing) existing.remove();
    const winTitle = mode === "vtt" ? dmT("content.previewWindowTitleVtt") : dmT("content.previewWindowTitleGeneric");
    const win = dmCreateWindow("idm-preview-window", winTitle, null, null);
    win.container.style.width = "min(680px, 96vw)";
    win.container.style.maxWidth = "96vw";
    win.body.style.minHeight = "440px";
    win.body.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", dmT("pv.iframeTitle"));
    iframe.src = chrome.runtime.getURL("preview.html");
    iframe.style.cssText = "width:100%;height:440px;border:0;border-radius:6px;background:#000;";
    iframe.setAttribute("allow", "autoplay; fullscreen");
    win.body.appendChild(iframe);
    const ref = referer || "";
    const m = mode === "mp4" ? "mp4" : mode === "vtt" ? "vtt" : "hls";
    const startSec = Number.isFinite(rangeStartSec) ? Math.max(0, rangeStartSec) : null;
    const endSec = Number.isFinite(rangeEndSec) ? Math.max(0, rangeEndSec) : null;
    iframe.onload = () => {
        try {
            iframe.contentWindow.postMessage(
                { type: "BUGI_PREVIEW_INIT", url, referer: ref, mode: m, rangeStartSec: startSec, rangeEndSec: endSec },
                "*"
            );
        } catch (_e) {}
    };
    document.body.appendChild(win.container);
}

function dmOpenMasterMenu(job, snap, backdrop, opts) {
    const win = dmCreateWindow("idm-menu-window", dmT("content.qualityTitle"), () => backdrop.remove());
    backdrop.appendChild(win.container);

    const qualityContainer = document.createElement("div");
    qualityContainer.id = "idm-quality-container";
    win.body.appendChild(qualityContainer);

    dmParseMasterAndRenderMenu(job, snap, qualityContainer, backdrop, opts);

    // Altyazılar (önce kaydedilmiş veriden, yoksa açık sekmeden senkronize etmeye çalış)
    dmMaybeRenderSubtitles(job, win.body);
}

function dmOpenSingleConfirm(job, snap, backdrop, opts) {
    const win = dmCreateWindow("idm-menu-window", dmT("content.confirmTitle"), () => backdrop.remove());
    backdrop.appendChild(win.container);

    dmMaybeRenderSubtitles(job, win.body);

    const infoDiv = document.createElement("div");
    infoDiv.style.textAlign = "center";
    infoDiv.style.padding = "10px";
    infoDiv.innerText = dmT("content.singleQualityInfo");
    win.body.appendChild(infoDiv);

    const ref = job.pageUrl || job.sourceUrl || "";

    const startRow = document.createElement("div");
    startRow.className = "idm-btn-row idm-btn-row--gap6 idm-btn-row--mb0";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "idm-action-btn";
    btn.style.flex = "1";
    btn.style.minWidth = "0";
    btn.textContent = dmT("content.startDownload");
    startRow.appendChild(btn);
    if (snap.analyzedUrl) {
        const eyeSingle = document.createElement("button");
        eyeSingle.type = "button";
        eyeSingle.className = "idm-action-btn idm-preview-eye idm-preview-eye--action";
        eyeSingle.innerHTML = BUGI_PREVIEW_EYE_SVG;
        eyeSingle.title = dmT("content.previewRangeTitle");
        eyeSingle.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dmOpenBugiPreview({
                url: snap.analyzedUrl,
                mode: dmInferPreviewMode(snap.analyzedUrl),
                referer: ref
            });
        };
        startRow.appendChild(eyeSingle);
    }
    win.body.appendChild(startRow);

    btn.onclick = async () => {
        const bw = snap.analyzedBw || 2000000;
        const segs = dmAnalyzeSegments(snap.analyzedBody, snap.analyzedUrl);
        win.container.remove();
        dmOpenRangeUI(job, backdrop, segs, bw, {
            playlistUrl: snap.analyzedUrl,
            isAudio: !!snap.analyzedIsAudio,
            audioLang: snap.analyzedAudioLang || ""
        }, snap, opts);
    };
}

function dmMaybeRenderSubtitles(job, container) {
    if (!job || !container) return;
    job.captured = job.captured || {};
    job.captured.media = job.captured.media || {};

    const localSubs = Array.isArray(job.captured.media.subtitles) ? job.captured.media.subtitles : [];
    if (localSubs.length) {
        dmRenderSubtitleSection(container, localSubs, job);
        return;
    }

    const pageUrl = (job.pageUrl || (job.captured && job.captured.originalPageUrl) || "").trim();
    if (!pageUrl) return;

    chrome.runtime.sendMessage({ action: "GET_MEDIA_FOR_PAGE", pageUrl }, (meta) => {
        try {
            if (!meta) return;
            const subs = Array.isArray(meta.subtitles) ? meta.subtitles : [];
            const audios = Array.isArray(meta.audios) ? meta.audios : [];
            if (!subs.length && !audios.length) return;

            job.captured = job.captured || {};
            job.captured.media = job.captured.media || {};
            if (subs.length) job.captured.media.subtitles = subs;
            if (audios.length) job.captured.media.audios = audios;
            saveJobs();

            if (subs.length) dmRenderSubtitleSection(container, subs, job);
        } catch (_e) {}
    });
}

function dmParseMasterAndRenderMenu(job, snap, container, backdrop, opts) {
    const text = String(snap.masterBody || "");
    const baseUrl = String(snap.masterUrl || job.sourceUrl || job.pageUrl || "");
    const lines = text.split("\n");
    const qualities = new Map();
    const audioTracks = [];

    const dmAudioIconHtml = (mode) => {
        const isMuxed = mode === "muxed";
        const color = isMuxed ? "#4caf50" : "#8a8a8a";
        const opacity = isMuxed ? "1" : "0.85";
        const slash = mode !== "muxed"
            ? `<path d="M4 4 L20 20" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`
            : "";
        const title =
            mode === "muxed"
                ? dmT("content.audioIconMuxed")
                : mode === "separate"
                  ? dmT("content.audioIconSeparate")
                  : dmT("content.audioIconNone");
        return `
            <span title="${title}"
                  style="display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-left:6px; opacity:${opacity};">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M11 5 L6.5 9 H3.5 C2.7 9 2 9.7 2 10.5 V13.5 C2 14.3 2.7 15 3.5 15 H6.5 L11 19 Z"
                      stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
                <path d="M15.5 9.5 C16.6 10.6 16.6 13.4 15.5 14.5" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
                <path d="M18.2 7.0 C20.5 9.3 20.5 14.7 18.2 17.0" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
                ${slash}
              </svg>
            </span>
        `;
    };

    const dmInferAudioModeFromStreamInf = (line) => {
        const l = String(line || "");
        if (/AUDIO="/i.test(l)) return "separate";
        const codecsMatch = l.match(/CODECS="([^"]+)"/i);
        if (codecsMatch && codecsMatch[1]) {
            const codecs = codecsMatch[1].toLowerCase();
            if (codecs.includes("mp4a")) return "muxed";
            return "none";
        }
        return "muxed";
    };

    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (line.startsWith("#EXT-X-MEDIA")) {
            const typeMatch = line.match(/TYPE=([^,]+)/);
            const type = typeMatch ? typeMatch[1].replace(/"/g, "") : "";
            const nameMatch = line.match(/NAME="([^"]+)"/);
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = line.match(/URI="([^"]+)"/);
            const uri = uriMatch ? uriMatch[1] : "";
            if (type === "AUDIO" && uri) {
                let fullUrl = uri;
                if (!uri.startsWith("http")) {
                    try { fullUrl = new URL(uri, baseUrl).href; } catch (_e) {}
                }
                audioTracks.push({
                    url: fullUrl,
                    name: nameMatch ? nameMatch[1] : "",
                    lang: langMatch ? langMatch[1] : ""
                });
            }
        }
        if (line.includes("#EXT-X-STREAM-INF")) {
            const bwPeak = (line.match(/BANDWIDTH=(\d+)/) || [0, 0])[1];
            const bwAvg = (line.match(/AVERAGE-BANDWIDTH=(\d+)/) || [0, 0])[1];
            const res = (line.match(/RESOLUTION=(\d+x\d+)/) || [0, dmT("dm.resolutionDefault")])[1];
            const urlLine = lines[i + 1] ? lines[i + 1].trim() : "";
            if (urlLine && !urlLine.startsWith("#")) {
                let fullUrl = urlLine;
                if (!urlLine.startsWith("http")) {
                    try { fullUrl = new URL(urlLine, baseUrl).href; } catch (_e) {}
                }
                if (!qualities.has(fullUrl)) {
                    qualities.set(fullUrl, {
                        res,
                        // BANDWIDTH çoğu zaman peak bitrate; AVERAGE-BANDWIDTH varsa tahminde onu kullanacağız.
                        bw: parseInt(bwPeak, 10) || 0,
                        avgBw: parseInt(bwAvg, 10) || 0,
                        audioMode: dmInferAudioModeFromStreamInf(line),
                        url: fullUrl
                    });
                }
            }
        }
    }

    const sorted = Array.from(qualities.values()).sort((a, b) => (b.bw || 0) - (a.bw || 0));
    if (!sorted.length) {
        container.innerHTML = `<div style="text-align:center; padding:10px;">${dmT("dm.listParseFailCenter")}</div>`;
        return;
    }

    const qTitle = document.createElement("div");
    qTitle.style.fontSize = "11px";
    qTitle.style.color = "#aaa";
    qTitle.style.marginBottom = "6px";
    qTitle.style.marginTop = "10px";
    qTitle.innerText = dmT("content.qualitiesTitle");
    container.appendChild(qTitle);

    const previewReferer = job.pageUrl || job.sourceUrl || "";

    sorted.forEach((q) => {
        const row = document.createElement("div");
        row.className = "idm-btn-row";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "idm-list-btn";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "space-between";
        btn.style.gap = "8px";
        btn.style.flex = "1";
        btn.style.minWidth = "0";
        btn.style.textAlign = "left";

        const leftSpan = document.createElement("span");
        leftSpan.style.flex = "1";
        leftSpan.style.minWidth = "0";
        const rightWrap = document.createElement("span");
        rightWrap.style.display = "inline-flex";
        rightWrap.style.alignItems = "center";
        rightWrap.style.gap = "6px";
        rightWrap.style.flexShrink = "0";
        const sizeSpan = document.createElement("span");
        sizeSpan.style.color = "#aaa";
        let approxStr = dmT("content.sizeCalculating");
        sizeSpan.textContent = approxStr;

        rightWrap.appendChild(sizeSpan);
        btn.appendChild(leftSpan);
        btn.appendChild(rightWrap);

        const eyeBtn = document.createElement("button");
        eyeBtn.type = "button";
        eyeBtn.className = "idm-list-btn idm-preview-eye";
        eyeBtn.title = dmT("content.previewQualityHls");
        eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
        eyeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dmOpenBugiPreview({ url: q.url, mode: "hls", referer: previewReferer });
        };
        row.appendChild(btn);
        row.appendChild(eyeBtn);

        const renderLeft = () => {
            try {
                leftSpan.innerHTML = `<b>${q.res}</b>${dmAudioIconHtml(q.audioMode)}`;
            } catch (_e) {
                leftSpan.innerHTML = `<b>${q.res}</b>`;
            }
        };
        renderLeft();

        // Size hesap: varsa kayıtlı variant body üzerinden
        const storedBody = snap.variantBodies && snap.variantBodies[q.url] ? snap.variantBodies[q.url] : "";

        // Kayıtlı body varsa, arka planda gerçek boyut örnekleme tahmini yap
        if (storedBody) {
            (async () => {
                // Audio probe: indirdiğin kalite dosyasında gerçekten ses var mı?
                const probed = await dmProbeVariantAudioMode(q.url, storedBody, job.pageUrl || job.sourceUrl || "");
                if (probed === "muxed" || probed === "none") {
                    q.audioMode = probed;
                    renderLeft();
                }
                const headApprox = await dmEstimateSizeByHeadSampling(storedBody, q.url);
                if (headApprox) {
                    renderLeft();
                    sizeSpan.textContent = `~${headApprox}`;
                    return;
                }
                const estimateBw = q.avgBw || q.bw || 2000000;
                const approx = dmEstimateSizeFromPlaylist(storedBody, estimateBw);
                if (approx) {
                    renderLeft();
                    sizeSpan.textContent = `~${approx}`;
                }
            })().catch(() => {});
        }

        btn.onclick = async () => {
            // önce kayıtlı body dene
            let body = storedBody;
            if (!body) {
                body = await dmGetPlaylistBody(job, snap, q.url);
                if (body) {
                    snap.variantBodies = snap.variantBodies || {};
                    snap.variantBodies[q.url] = body;
                    dmPersistSnapshot(job.id, snap);
                    // Audio probe (yeni alınan body)
                    const probed2 = await dmProbeVariantAudioMode(q.url, body, job.pageUrl || job.sourceUrl || "");
                    if (probed2 === "muxed" || probed2 === "none") {
                        q.audioMode = probed2;
                    }
                    // 1) gerçek segment boyutlarına göre tahmin
                    const headApprox2 = await dmEstimateSizeByHeadSampling(body, q.url);
                    if (headApprox2) {
                        renderLeft();
                        sizeSpan.textContent = `~${headApprox2}`;
                    } else {
                        // 2) fallback: bitrate tahmini
                        const estimateBw2 = q.avgBw || q.bw || 2000000;
                        const approx = dmEstimateSizeFromPlaylist(body, estimateBw2);
                        if (approx) {
                            renderLeft();
                            sizeSpan.textContent = `~${approx}`;
                        }
                    }
                }
            }
            if (!body) {
                alert(dmT("dm.qualityListExpired"));
                return;
            }
            const segs = dmAnalyzeSegments(body, q.url);
            document.getElementById("idm-menu-window")?.remove();
            const estimateBw = q.avgBw || q.bw || 2000000;
            dmOpenRangeUI(job, backdrop, segs, estimateBw, { playlistUrl: q.url, isAudio: false, audioLang: "" }, snap, opts);
        };

        container.appendChild(row);
    });

    // Ses Parçaları (Dublaj)
    const audioList = audioTracks.length
        ? audioTracks
        : (job.captured && job.captured.media && Array.isArray(job.captured.media.audios) ? job.captured.media.audios : []);

    if (audioList && audioList.length) {
        const audioSection = document.createElement("div");
        audioSection.style.marginTop = "15px";

        const title = document.createElement("div");
        title.style.fontSize = "11px";
        title.style.color = "#aaa";
        title.style.marginBottom = "6px";
        title.innerText = dmT("content.audioPartsTitle");
        audioSection.appendChild(title);

        audioList.forEach((a, idx) => {
            const row = document.createElement("div");
            row.className = "idm-btn-row";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "idm-list-btn";
            btn.style.display = "flex";
            btn.style.alignItems = "center";
            btn.style.justifyContent = "space-between";
            btn.style.gap = "8px";
            btn.style.flex = "1";
            btn.style.minWidth = "0";
            btn.style.textAlign = "left";
            const labelParts = [];
            if (a.name) labelParts.push(a.name);
            if (a.lang) labelParts.push(a.lang);
            let label = labelParts.length ? labelParts.join(" / ") : dmTf("content.audioTrackN", { n: idx + 1 });
            const leftSpan = document.createElement("span");
            leftSpan.style.flex = "1";
            leftSpan.style.minWidth = "0";
            leftSpan.innerHTML = `<b>${label}</b>`;
            const rightWrap = document.createElement("span");
            rightWrap.style.display = "inline-flex";
            rightWrap.style.alignItems = "center";
            rightWrap.style.gap = "6px";
            rightWrap.style.flexShrink = "0";
            const hintSpan = document.createElement("span");
            hintSpan.style.color = "#aaa";
            hintSpan.textContent = dmT("content.audioOnlyBadge");
            rightWrap.appendChild(hintSpan);
            btn.appendChild(leftSpan);
            btn.appendChild(rightWrap);

            const eyeBtn = document.createElement("button");
            eyeBtn.type = "button";
            eyeBtn.className = "idm-list-btn idm-preview-eye";
            eyeBtn.title = dmT("media.previewTitleAudio");
            eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
            eyeBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                dmOpenBugiPreview({ url: a.url, mode: "hls", referer: previewReferer });
            };
            row.appendChild(btn);
            row.appendChild(eyeBtn);
            btn.onclick = async () => {
                let body = (snap.audioBodies && snap.audioBodies[a.url]) ? snap.audioBodies[a.url] : "";
                if (!body) {
                    body = await dmGetPlaylistBody(job, snap, a.url);
                    if (body) {
                        snap.audioBodies = snap.audioBodies || {};
                        snap.audioBodies[a.url] = body;
                        dmPersistSnapshot(job.id, snap);
                    }
                }
                if (!body) {
                    alert(dmT("dm.audioListExpired"));
                    return;
                }
                const segs = dmAnalyzeSegments(body, a.url);
                document.getElementById("idm-menu-window")?.remove();
                dmOpenRangeUI(job, backdrop, segs, 192000, { playlistUrl: a.url, isAudio: true, audioLang: (a.lang || a.name || "").trim() }, snap, opts);
            };
            audioSection.appendChild(row);
        });

        container.appendChild(audioSection);
    }
}

function dmPersistSnapshot(jobId, snap) {
    const j = findJob(jobId);
    if (!j) return;
    j.captured = j.captured || {};
    j.captured.snapshot = snap;
    saveJobs();
}

async function dmGetPlaylistBody(job, snap, url) {
    // Önce background intercept
    const inter = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url }, resolve));
    if (inter && inter.found && inter.body) {
        return dmTryDecodeBase64Playlist(inter.body);
    }
    // Sonra fetchUrl
    const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "fetchUrl", url, referer: job.pageUrl || "" }, resolve));
    if (resp && resp.success && resp.data) return dmTryDecodeBase64Playlist(resp.data);
    return "";
}

async function dmBase64ToBytesFast(b64) {
    try {
        const r = await fetch(`data:application/octet-stream;base64,${b64}`);
        const ab = await r.arrayBuffer();
        return new Uint8Array(ab);
    } catch (_e) {
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }
}

function dmOpenRangeUI(job, backdrop, parsedSegmentsData, selectedBw, meta, snap, opts) {
    // Aralık UI (content.js ile birebir)
    const totalDur = parsedSegmentsData[parsedSegmentsData.length - 1]?.endTime || 0;
    const win = dmCreateWindow("idm-range-window", dmT("content.rangeWindowTitle"), () => backdrop.remove(), () => {
        win.container.remove();
        dmOpenMasterMenu(job, snap, backdrop, opts);
    });
    backdrop.appendChild(win.container);
    win.body.innerHTML = "";

    const previewRef = job.pageUrl || job.sourceUrl || "";

    const rangeContainer = document.createElement("div");
    const defaultResume = opts && typeof opts.defaultResumeIndex === "number" ? Math.max(0, opts.defaultResumeIndex) : 0;
    const hasInit = !!(parsedSegmentsData && parsedSegmentsData.initSegmentUrl);
    const canTransmux = !hasInit; // init varsa zaten fMP4 -> doğrudan mp4 yazıyoruz
    const defaultMp4 = true; // kullanıcı isteği: mümkünse mp4
    rangeContainer.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
            <div id="grp-start"></div>
            <div id="grp-end"></div>
        </div>
        <div id="range-info" style="background:#333; padding:10px; border-radius:4px; font-size:12px; text-align:center; color:#ccc; margin-bottom:10px;">
            <div>${dmT("content.videoTotalLabel")} <b style="color:#4fc3f7">${formatTimeDM(totalDur)}</b></div>
            <div id="selected-range" style="margin-top:5px;">${dmT("content.rangeSelectedCalculating")}</div>
        </div>
        <div style="background:#1f1f1f; border:1px solid #333; border-radius:6px; padding:10px; margin-bottom:10px;">
            <label style="display:flex; align-items:center; gap:8px; font-size:11px; color:#ddd; cursor:pointer;">
                <input type="checkbox" id="out-mp4" ${defaultMp4 ? "checked" : ""} ${(!canTransmux && !hasInit) ? "disabled" : ""} style="margin:0;">
                <span>${dmT("dm.rangeSaveMp4")}</span>
            </label>
            <div style="font-size:10px; color:#888; margin-top:6px; line-height:1.4;">
                ${hasInit ? dmT("dm.rangeHelpFm4") : dmT("dm.rangeHelpTsTransmux")}
            </div>
        </div>
        <div style="background:#1f1f1f; border:1px solid #333; border-radius:6px; padding:10px; margin-bottom:10px;">
            <label style="display:flex; align-items:center; gap:8px; font-size:11px; color:#ddd; cursor:pointer;">
                <input type="checkbox" id="resume-from-seg" ${defaultResume > 0 ? "checked" : ""} style="margin:0;">
                <span>${dmT("dm.rangeResumeLabel")}</span>
            </label>
            <div style="display:flex; gap:8px; margin-top:6px; align-items:center;">
                <input id="resume-seg-index" type="number" min="0" step="1" value="${defaultResume}" style="flex:1; background:#111; border:1px solid #444; color:#f5f5f5; padding:4px 8px; border-radius:4px; font-size:11px;">
                <span style="font-size:10px; color:#888;">${dmT("dm.rangeResumeHint")}</span>
            </div>
            <div style="font-size:10px; color:#888; margin-top:6px; line-height:1.4;">
                ${dmT("dm.rangeResumeNote")}
            </div>
        </div>
        <div class="idm-btn-row idm-btn-row--gap6 idm-btn-row--mb0" style="margin-top:5px;">
            <button type="button" id="btn-start-dl" class="idm-action-btn" style="flex:1;">${dmT("content.startDownload")}</button>
            <button type="button" id="btn-range-preview-eye" class="idm-action-btn idm-preview-eye idm-preview-eye--action" title="${dmT("content.previewRangeTitle")}">${BUGI_PREVIEW_EYE_SVG}</button>
        </div>
    `;
    win.body.appendChild(rangeContainer);

    const rangeEye = rangeContainer.querySelector("#btn-range-preview-eye");
    if (rangeEye && meta && meta.playlistUrl) {
        rangeEye.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const s = dmHmsToSeconds(startInp.input.value);
            const en = dmHmsToSeconds(endInp.input.value);
            if (!Number.isFinite(s) || !Number.isFinite(en) || s >= en) {
                alert(dmT("content.rangeInvalidPreview"));
                return;
            }
            dmOpenBugiPreview({
                url: meta.playlistUrl,
                mode: dmInferPreviewMode(meta.playlistUrl),
                referer: previewRef,
                rangeStartSec: s,
                rangeEndSec: en
            });
        };
    } else if (rangeEye) {
        rangeEye.style.display = "none";
    }

    const startInp = dmCreateTimeInputGroup(dmT("content.rangeStartLabel"), "00:00:00", () => validate(startInp, "start"));
    const endInp = dmCreateTimeInputGroup(dmT("content.rangeEndLabel"), formatTimeDM(totalDur), () => validate(endInp, "end"));
    rangeContainer.querySelector("#grp-start").appendChild(startInp.container);
    rangeContainer.querySelector("#grp-end").appendChild(endInp.container);

    const validate = (inpObj, type) => {
        let sec = dmHmsToSeconds(inpObj.input.value);
        if (isNaN(sec) || sec < 0) sec = 0;
        if (sec > totalDur) {
            sec = totalDur;
            inpObj.input.value = formatTimeDM(sec);
        }
        let snapped = sec;
        for (let seg of parsedSegmentsData) {
            if (sec >= seg.startTime && sec <= seg.endTime) {
                snapped = type === "start" ? seg.startTime : seg.endTime;
                break;
            }
        }
        if (type === "end" && sec >= totalDur) snapped = totalDur;
        inpObj.input.value = formatTimeDM(snapped);
        updateInfo();
    };

    const updateInfo = () => {
        const s = dmHmsToSeconds(startInp.input.value);
        const e = dmHmsToSeconds(endInp.input.value);
        if (s >= e) {
            rangeContainer.querySelector("#selected-range").innerHTML =
                `<span style="color:#e74c3c">${dmT("content.rangeInvalidOrder")}</span>`;
            return;
        }
        if (e > totalDur) endInp.input.value = formatTimeDM(totalDur);
        let diff = e - s;
        let mb = (((selectedBw || 2000000) * diff) / 8388608) * 0.93;
        rangeContainer.querySelector("#selected-range").innerHTML = dmTf("content.rangeEstLineHtml", {
            dur: formatTimeDM(diff),
            mb: mb.toFixed(2)
        });
    };

    rangeContainer.querySelector("#btn-start-dl").onclick = () => {
        const s = dmHmsToSeconds(startInp.input.value);
        const e = dmHmsToSeconds(endInp.input.value);
        if (s >= e) return alert(dmT("content.rangeInvalid"));

        const segs = parsedSegmentsData.filter((seg) => seg.startTime < e && seg.endTime > s);
        if (!segs.length) return alert(dmT("content.noSegments"));

        // Resume-from-segment (retry için): seçili aralık içindeki segmentlerden, mutlak segment index'e göre kırp
        let effectiveSegs = segs;
        const resumeChk = rangeContainer.querySelector("#resume-from-seg");
        const resumeInp = rangeContainer.querySelector("#resume-seg-index");
        if (resumeChk && resumeChk.checked && resumeInp) {
            const v = parseInt(resumeInp.value, 10);
            const resumeFrom = isNaN(v) ? 0 : Math.max(0, v);
            if (resumeFrom > 0) {
                effectiveSegs = segs.filter((seg) => (typeof seg.index === "number" ? seg.index : 0) >= resumeFrom);
                if (!effectiveSegs.length) {
                    alert(dmT("dm.segmentRangeNone"));
                    return;
                }
            }
        }

        const jobId = Date.now().toString() + "_" + Math.random().toString(16).slice(2);
        const totalDurRange = e - s;
        const baseTitle = job.title || "video";
        const newJob = {
            id: jobId,
            title: baseTitle,
            sourceUrl: meta.playlistUrl,
            pageUrl: job.pageUrl,
            isAudio: !!meta.isAudio,
            audioLang: meta.audioLang || "",
            createdAt: Date.now(),
            totalDuration: totalDurRange,
            segments: segs.map((seg, idx) => ({
                url: seg.url,
                index: typeof seg.index === "number" ? seg.index : idx,
                duration: seg.duration
            })),
            // EXT-X-MAP (fMP4) varsa bunu da taşı
            initSegmentUrl: parsedSegmentsData && parsedSegmentsData.initSegmentUrl ? parsedSegmentsData.initSegmentUrl : "",
            outputMp4: !!(parsedSegmentsData && parsedSegmentsData.initSegmentUrl),
            transmuxToMp4: false,
            snapshot: (() => { try { return JSON.parse(JSON.stringify(snap)); } catch (_e) { return null; } })(),
            media: job.captured && job.captured.media ? JSON.parse(JSON.stringify(job.captured.media)) : undefined
        };

        // Çıktı formatı seçimi (TS -> MP4 transmux)
        const outMp4El = rangeContainer.querySelector("#out-mp4");
        const wantMp4 = !!(outMp4El && outMp4El.checked);
        if (wantMp4 && !newJob.outputMp4) {
            newJob.transmuxToMp4 = true;
        }

        // effectiveSegs'e göre gerçek segment listesini override et
        newJob.segments = effectiveSegs.map((seg, idx) => ({
            url: seg.url,
            index: typeof seg.index === "number" ? seg.index : idx,
            duration: seg.duration
        }));

        chrome.runtime.sendMessage({ action: "REGISTER_DOWNLOAD_JOB", job: newJob });
        backdrop.remove();
    };

    setTimeout(updateInfo, 50);
}

function dmAnalyzeSegments(text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const parsed = [];
    let t = 0;
    let count = 0;
    let initSegmentUrl = "";
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (!initSegmentUrl && line.startsWith("#EXT-X-MAP:")) {
            initSegmentUrl = dmParseExtXMapUrl(line, baseUrl);
            continue;
        }
        if (line.startsWith("#EXTINF:")) {
            const durPart = line.split(":")[1];
            const dur = parseFloat(durPart ? durPart.replace(",", "") : 0);
            const url = lines[i + 1] ? lines[i + 1].trim() : "";
            if (url && !url.startsWith("#")) {
                let fullUrl = url;
                try { fullUrl = new URL(url, baseUrl).href; } catch (_e) {}
                parsed.push({ url: fullUrl, startTime: t, endTime: t + dur, duration: dur, index: count++ });
                t += dur;
            }
        }
    }
    // Array'a metadata ekle (minimum değişiklik için)
    parsed.initSegmentUrl = initSegmentUrl || "";
    return parsed;
}

function dmEstimateSizeFromPlaylist(text, bandwidth) {
    const lines = String(text || "").split(/\r?\n/);
    let totalDur = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (line.startsWith("#EXTINF:")) {
            const durPart = line.split(":")[1];
            const dur = parseFloat(durPart ? durPart.replace(",", "") : 0);
            if (!isNaN(dur) && dur > 0) totalDur += dur;
        }
    }
    if (!totalDur) return null;
    const bw = bandwidth || 2000000;
    const bytes = ((bw / 8) * totalDur) * 0.93;
    return formatBytesDM(bytes);
}

function dmParseSegmentsForSampling(text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const segments = [];
    let totalDur = 0;
    let pendingByteRangeLen = null;
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (line.startsWith("#EXT-X-BYTERANGE:")) {
            try {
                const val = line.split(":")[1] || "";
                const lenPart = val.split("@")[0];
                const n = parseInt(String(lenPart).trim(), 10);
                pendingByteRangeLen = (isFinite(n) && n > 0) ? n : null;
            } catch (_e) {
                pendingByteRangeLen = null;
            }
            continue;
        }
        if (line.startsWith("#EXTINF:")) {
            const durPart = line.split(":")[1];
            const dur = parseFloat(durPart ? durPart.replace(",", "") : 0);
            const url = lines[i + 1] ? lines[i + 1].trim() : "";
            if (!url || url.startsWith("#")) continue;
            let fullUrl = url;
            try { fullUrl = new URL(url, baseUrl).href; } catch (_e) {}
            const d = (!isNaN(dur) && dur > 0) ? dur : 0;
            segments.push({ url: fullUrl, duration: d, byteRangeLen: pendingByteRangeLen });
            totalDur += d;
            pendingByteRangeLen = null;
        }
    }
    return { segments, totalDur };
}

function dmPickSampleIndices(n, k) {
    const nn = Math.max(0, n || 0);
    const kk = Math.max(1, k || 1);
    if (nn <= 1) return [0];
    const count = Math.min(kk, nn);
    if (count === 1) return [0];
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(Math.floor((i * (nn - 1)) / (count - 1)));
    }
    return Array.from(new Set(out));
}

async function dmEstimateSizeByHeadSampling(body, baseUrl) {
    const parsed = dmParseSegmentsForSampling(body, baseUrl);
    const segs = parsed.segments || [];
    const totalDur = parsed.totalDur || 0;
    if (!segs.length || !totalDur) return null;

    const sampleIdx = dmPickSampleIndices(segs.length, 6);
    let sumBytes = 0;
    let sumDur = 0;
    let okCount = 0;

    for (const idx of sampleIdx) {
        const s = segs[idx];
        if (!s || !s.url) continue;
        let len = null;
        if (typeof s.byteRangeLen === "number" && isFinite(s.byteRangeLen) && s.byteRangeLen > 0) {
            len = s.byteRangeLen;
        } else {
        const head = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "headUrlAuth", url: s.url }, (r) => resolve(r || null)));
        if (head && head.success && typeof head.contentLength === "number" && head.contentLength > 0) {
            len = head.contentLength;
        } else {
            const probe = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "probeSizeAuth", url: s.url }, (r) => resolve(r || null)));
            if (probe && probe.success && typeof probe.totalSize === "number" && probe.totalSize > 0) {
                len = probe.totalSize;
            }
        }
        }
        if (len && len > 0) {
            sumBytes += len;
            sumDur += (s.duration || 0);
            okCount++;
        }
    }

    if (okCount < 2 || sumDur <= 0) return null;

    const bytesPerSec = sumBytes / sumDur;
    const estimatedBytes = bytesPerSec * totalDur;
    if (!isFinite(estimatedBytes) || estimatedBytes <= 0) return null;
    return formatBytesDM(estimatedBytes);
}

function dmParseInitSegmentUrlFromPlaylist(text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (line.startsWith("#EXT-X-MAP:")) {
            const m = line.match(/URI="([^"]+)"/i);
            if (m && m[1]) {
                const uri = m[1];
                try {
                    return /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).href;
                } catch (_e) {
                    return uri;
                }
            }
        }
    }
    return "";
}

function dmMp4InitHasAudioTrack(bytes) {
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const max = Math.min(u8.length, 512 * 1024);
        for (let i = 0; i + 32 < max; i++) {
            if (u8[i] === 0x68 && u8[i + 1] === 0x64 && u8[i + 2] === 0x6c && u8[i + 3] === 0x72) {
                const handlerOff = i + 12;
                if (handlerOff + 4 < max) {
                    const a = String.fromCharCode(u8[handlerOff], u8[handlerOff + 1], u8[handlerOff + 2], u8[handlerOff + 3]);
                    if (a === "soun") return true;
                }
            }
        }
    } catch (_e) {}
    return false;
}

function dmMp4InitHasVideoTrack(bytes) {
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const max = Math.min(u8.length, 512 * 1024);
        for (let i = 0; i + 32 < max; i++) {
            if (u8[i] === 0x68 && u8[i + 1] === 0x64 && u8[i + 2] === 0x6c && u8[i + 3] === 0x72) { // hdlr
                const handlerOff = i + 12;
                if (handlerOff + 4 < max) {
                    const a = String.fromCharCode(u8[handlerOff], u8[handlerOff + 1], u8[handlerOff + 2], u8[handlerOff + 3]);
                    if (a === "vide") return true;
                }
            }
        }
    } catch (_e) {}
    return false;
}

function dmTsSegmentHasAudio(bytes) {
    const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const len = u8.length;
        if (len < 188 * 3) return false;
        const read16 = (a, b) => ((a << 8) | b) & 0xffff;
        let pmtPid = null;

        for (let off = 0; off + 188 <= len && off < 188 * 400; off += 188) {
            if (u8[off] !== 0x47) continue;
            const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
            const pusi = !!(u8[off + 1] & 0x40);
            const afc = (u8[off + 3] >> 4) & 0x03;
            let pos = off + 4;
            if (afc === 2 || afc === 0) continue;
            if (afc === 3) {
                const afl = u8[pos];
                pos += 1 + afl;
            }
            if (pid !== 0x0000 || !pusi) continue;
            const pointer = u8[pos];
            pos += 1 + pointer;
            if (pos + 8 >= off + 188) continue;
            if (u8[pos] !== 0x00) continue;
            const sectionLength = ((u8[pos + 1] & 0x0f) << 8) | u8[pos + 2];
            const sectionEnd = pos + 3 + sectionLength;
            let p = pos + 8;
            while (p + 4 <= sectionEnd - 4) {
                const programNumber = read16(u8[p], u8[p + 1]);
                const programMapPid = ((u8[p + 2] & 0x1f) << 8) | u8[p + 3];
                if (programNumber !== 0) {
                    pmtPid = programMapPid;
                    break;
                }
                p += 4;
            }
            if (pmtPid != null) break;
        }

        if (pmtPid == null) return false;

        for (let off = 0; off + 188 <= len && off < 188 * 800; off += 188) {
            if (u8[off] !== 0x47) continue;
            const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
            const pusi = !!(u8[off + 1] & 0x40);
            const afc = (u8[off + 3] >> 4) & 0x03;
            let pos = off + 4;
            if (afc === 2 || afc === 0) continue;
            if (afc === 3) {
                const afl = u8[pos];
                pos += 1 + afl;
            }
            if (pid !== pmtPid || !pusi) continue;
            const pointer = u8[pos];
            pos += 1 + pointer;
            if (pos + 12 >= off + 188) continue;
            if (u8[pos] !== 0x02) continue;
            const sectionLength = ((u8[pos + 1] & 0x0f) << 8) | u8[pos + 2];
            const sectionEnd = pos + 3 + sectionLength;
            const programInfoLength = ((u8[pos + 10] & 0x0f) << 8) | u8[pos + 11];
            let p = pos + 12 + programInfoLength;
            while (p + 5 <= sectionEnd - 4) {
                const streamType = u8[p];
                const esInfoLength = ((u8[p + 3] & 0x0f) << 8) | u8[p + 4];
                if (AUDIO_TYPES.has(streamType)) return true;
                p += 5 + esInfoLength;
            }
            break;
        }
    } catch (_e) {}
    return false;
}

function dmTsDetectVideoStreamType(bytes) {
    // Return stream_type for first video stream in PMT.
    // Common: 0x1b (H.264/AVC), 0x24 (H.265/HEVC)
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const len = u8.length;
        if (len < 188 * 3) return null;
        const read16 = (a, b) => ((a << 8) | b) & 0xffff;
        let pmtPid = null;

        for (let off = 0; off + 188 <= len && off < 188 * 400; off += 188) {
            if (u8[off] !== 0x47) continue;
            const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
            const pusi = !!(u8[off + 1] & 0x40);
            const afc = (u8[off + 3] >> 4) & 0x03;
            let pos = off + 4;
            if (afc === 2 || afc === 0) continue;
            if (afc === 3) {
                const afl = u8[pos];
                pos += 1 + afl;
            }
            if (pid !== 0x0000 || !pusi) continue;
            const pointer = u8[pos];
            pos += 1 + pointer;
            if (pos + 8 >= off + 188) continue;
            if (u8[pos] !== 0x00) continue;
            const sectionLength = ((u8[pos + 1] & 0x0f) << 8) | u8[pos + 2];
            const sectionEnd = pos + 3 + sectionLength;
            let p = pos + 8;
            while (p + 4 <= sectionEnd - 4) {
                const programNumber = read16(u8[p], u8[p + 1]);
                const programMapPid = ((u8[p + 2] & 0x1f) << 8) | u8[p + 3];
                if (programNumber !== 0) {
                    pmtPid = programMapPid;
                    break;
                }
                p += 4;
            }
            if (pmtPid != null) break;
        }
        if (pmtPid == null) return null;

        for (let off = 0; off + 188 <= len && off < 188 * 800; off += 188) {
            if (u8[off] !== 0x47) continue;
            const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
            const pusi = !!(u8[off + 1] & 0x40);
            const afc = (u8[off + 3] >> 4) & 0x03;
            let pos = off + 4;
            if (afc === 2 || afc === 0) continue;
            if (afc === 3) {
                const afl = u8[pos];
                pos += 1 + afl;
            }
            if (pid !== pmtPid || !pusi) continue;
            const pointer = u8[pos];
            pos += 1 + pointer;
            if (pos + 12 >= off + 188) continue;
            if (u8[pos] !== 0x02) continue;
            const sectionLength = ((u8[pos + 1] & 0x0f) << 8) | u8[pos + 2];
            const sectionEnd = pos + 3 + sectionLength;
            const programInfoLength = ((u8[pos + 10] & 0x0f) << 8) | u8[pos + 11];
            let p = pos + 12 + programInfoLength;
            while (p + 5 <= sectionEnd - 4) {
                const streamType = u8[p];
                const esInfoLength = ((u8[p + 3] & 0x0f) << 8) | u8[p + 4];
                // video stream types
                if (streamType === 0x1b || streamType === 0x24) return streamType;
                p += 5 + esInfoLength;
            }
            break;
        }
    } catch (_e) {}
    return null;
}

async function dmProbeVariantAudioMode(variantUrl, playlistBody, referer) {
    const key = String(variantUrl || "");
    if (!key) return null;
    if (dmAudioProbeCache.has(key)) return dmAudioProbeCache.get(key);
    const ref = referer || "";

    try {
        const initUrl = dmParseInitSegmentUrlFromPlaylist(playlistBody, key);
        if (initUrl) {
            const initResp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "fetchUrl", url: initUrl, isBinary: true, referer: ref }, (r) => resolve(r || null)));
            if (initResp && initResp.success && typeof initResp.data === "string") {
                const bytes = await dmBase64ToBytesFast(initResp.data);
                const mode = dmMp4InitHasAudioTrack(bytes) ? "muxed" : "none";
                dmAudioProbeCache.set(key, mode);
                return mode;
            }
        }

        const parsed = dmParseSegmentsForSampling(playlistBody, key);
        const first = parsed.segments && parsed.segments.length ? parsed.segments[0] : null;
        if (first && first.url) {
            const segResp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "fetchUrl", url: first.url, isBinary: true, referer: ref }, (r) => resolve(r || null)));
            if (segResp && segResp.success && typeof segResp.data === "string") {
                const bytes = await dmBase64ToBytesFast(segResp.data);
                const mode = dmTsSegmentHasAudio(bytes) ? "muxed" : "none";
                dmAudioProbeCache.set(key, mode);
                return mode;
            }
        }
    } catch (_e) {}
    return null;
}

function dmTryDecodeBase64Playlist(data) {
    if (typeof data !== "string") return data;
    const upperOrig = data.toUpperCase();
    if (upperOrig.includes("#EXTM3U") || upperOrig.includes("#EXT-X-STREAM-INF") || upperOrig.includes("#EXTINF:")) return data;
    let cleaned = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (cleaned && !/[^A-Za-z0-9+/=]/.test(cleaned)) {
        try {
            const decoded = atob(cleaned);
            const upperDec = decoded.toUpperCase();
            if (upperDec.includes("#EXTM3U") || upperDec.includes("#EXTINF:") || upperDec.includes("#EXT-X-STREAM-INF")) return decoded;
        } catch (_e) {}
    }
    const candidates = data.match(/[A-Za-z0-9+/=]{40,}/g);
    if (candidates) {
        for (let token of candidates) {
            const tokenClean = token.replace(/-/g, "+").replace(/_/g, "/");
            if (!tokenClean || /[^A-Za-z0-9+/=]/.test(tokenClean)) continue;
            try {
                const decoded = atob(tokenClean);
                const upperDec2 = decoded.toUpperCase();
                if (upperDec2.includes("#EXTM3U") || upperDec2.includes("#EXTINF:") || upperDec2.includes("#EXT-X-STREAM-INF")) return decoded;
            } catch (_e) {}
        }
    }
    return data;
}

function dmCreateWindow(id, titleText, onClose, onBack) {
    const old = document.getElementById(id);
    if (old) old.remove();
    const win = document.createElement("div");
    win.id = id;
    win.className = "idm-window";
    win.style.position = "fixed";
    if (dmLastWinTop === null) {
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const w = 320;
        const left = Math.max(20, (vw - w) / 2);
        const top = Math.max(20, (vh - 260) / 2);
        win.style.left = left + "px";
        win.style.top = top + "px";
        win.style.transform = "none";
    } else {
        win.style.top = dmLastWinTop;
        win.style.left = dmLastWinLeft;
        win.style.transform = "none";
    }
    win.innerHTML = `<div class="idm-window-header"><span class="idm-window-title">${titleText}</span><div class="idm-window-controls"></div></div><div class="idm-window-body"></div>`;
    const controls = win.querySelector(".idm-window-controls");
    if (onBack) {
        const backBtn = document.createElement("button");
        backBtn.className = "idm-win-btn idm-win-back";
        backBtn.innerText = "←";
        backBtn.onclick = (e) => { e.stopPropagation(); onBack(); };
        controls.appendChild(backBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.className = "idm-win-btn idm-win-close";
    closeBtn.innerText = "✖";
    closeBtn.onclick = () => { win.remove(); if (onClose) onClose(); };
    controls.appendChild(closeBtn);

    // Sürükle-bırak (content.js ile aynı his)
    const header = win.querySelector(".idm-window-header");
    let isDragging = false, shiftX = 0, shiftY = 0;
    header.onmousedown = (e) => {
        // butonlara basınca drag başlatma
        const t = e.target;
        if (t && t.closest && t.closest("button")) return;
        isDragging = true;
        const rect = win.getBoundingClientRect();
        win.style.left = rect.left + "px";
        win.style.top = rect.top + "px";
        win.style.transform = "none";
        shiftX = e.clientX - rect.left;
        shiftY = e.clientY - rect.top;
        document.onmousemove = (evt) => {
            if (!isDragging) return;
            evt.preventDefault();
            win.style.left = (evt.clientX - shiftX) + "px";
            win.style.top = (evt.clientY - shiftY) + "px";
            dmLastWinLeft = win.style.left;
            dmLastWinTop = win.style.top;
        };
        document.onmouseup = () => {
            isDragging = false;
            document.onmousemove = null;
        };
    };
    return { container: win, body: win.querySelector(".idm-window-body") };
}

function dmRenderSubtitleSection(container, subtitles, job) {
    const old = container.querySelector("#idm-subtitles-section");
    if (old) old.remove();
    if (!subtitles || !subtitles.length) return;

    // Aynı (dil + label + url) kombinasyonunu sadece bir kez göster
    const map = new Map();
    subtitles.forEach((s) => {
        if (!s || !s.url) return;
        const url = String(s.url);
        const label = (s.label || s.lang || "Subtitle").toString().trim();
        const lang = (s.lang || "").toString().toLowerCase();
        const key = `${lang}::${label.toLowerCase()}::${url}`;
        if (!map.has(key)) {
            map.set(key, Object.assign({}, s, { label, lang, url }));
        }
    });
    const uniqueSubs = Array.from(map.values());
    if (!uniqueSubs.length) return;

    const section = document.createElement("div");
    section.id = "idm-subtitles-section";
    section.style.marginBottom = "12px";

    const title = document.createElement("div");
    title.style.fontSize = "11px";
    title.style.color = "#aaa";
    title.style.marginBottom = "6px";
    title.innerText = dmT("content.subtitlesSectionTitle");
    section.appendChild(title);

    uniqueSubs.forEach((s, idx) => {
        const row = document.createElement("div");
        row.className = "idm-btn-row";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "idm-list-btn";
        btn.style.flex = "1";
        btn.style.minWidth = "0";
        btn.style.textAlign = "left";
        let baseLabel = s.label || s.lang || dmTf("content.subtitleN", { n: idx + 1 });
        let linkHint = "";
        try {
            const u = new URL(s.url);
            const last = u.pathname.split("/").filter(Boolean).pop() || "";
            if (last) linkHint = last;
        } catch (_e) {}
        if (linkHint && baseLabel.indexOf(linkHint) === -1 && devModeOn) {
            baseLabel += ` [${linkHint}]`;
        }
        btn.innerHTML = ` ${baseLabel} <span style="color:#aaa; float:right">.vtt</span>`;
        btn.onclick = () => dmDownloadSubtitleTrack(job, s);

        const eyeBtn = document.createElement("button");
        eyeBtn.type = "button";
        eyeBtn.className = "idm-list-btn idm-preview-eye";
        eyeBtn.title = dmT("media.previewTitleSub");
        eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
        eyeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dmOpenBugiPreview({
                url: s.url,
                mode: "vtt",
                referer: job.pageUrl || (job.captured && job.captured.originalPageUrl) || ""
            });
        };

        row.appendChild(btn);
        row.appendChild(eyeBtn);
        section.appendChild(row);
    });

    container.appendChild(section);
}

function dmDownloadSubtitleTrack(job, sub) {
    if (!job || !sub || !sub.url) return;
    const url = sub.url;
    if (dmActiveSubtitleDownloads.has(url)) return;
    dmActiveSubtitleDownloads.add(url);

    const referer = job.pageUrl || (job.captured && job.captured.originalPageUrl) || "";

    chrome.runtime.sendMessage(
        {
            action: "fetchUrl",
            url,
            referer
        },
        async (resp) => {
            if (!resp || !resp.success || typeof resp.data !== "string") {
                alert(
                    dmT("content.subDownloadFail") +
                        " " +
                        (resp && resp.error ? String(resp.error) : dmT("content.unknownError"))
                );
                dmActiveSubtitleDownloads.delete(url);
                return;
            }

            try {
                let safe = (job.customTitle || job.title || "subtitle").replace(/[\\/:*?"<>|]/g, "-").trim();
                safe = safe.replace(/[\x00-\x1f]/g, "");
                if (safe.length > 120) safe = safe.substring(0, 120);

                let suffix = "";
                const lang = (sub.lang || "").toString().trim();
                const label = (sub.label || "").toString().trim();
                if (lang && /^[a-z]{2,5}$/i.test(lang)) suffix = "_" + lang.toLowerCase();
                else if (label && label.length <= 20 && /[a-zA-Z]/.test(label) && !/\.(jpg|png|webp)$/i.test(label)) suffix = "_" + label.replace(/\s+/g, "-");

                const suggestedName = `${safe}${suffix}.vtt`;

                if (window.showSaveFilePicker) {
                    const handle = await window.showSaveFilePicker({
                        suggestedName,
                        types: [{ description: dmT("dm.pickerWebVtt"), accept: { "text/vtt": [".vtt"] } }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(new Blob([resp.data], { type: "text/vtt" }));
                    await writable.close();
                } else {
                    const blob = new Blob([resp.data], { type: "text/vtt" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = suggestedName;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        URL.revokeObjectURL(a.href);
                        a.remove();
                    }, 1000);
                }
            } catch (e) {
                if (!e || e.name !== "AbortError") {
                    alert(dmT("content.subSaveFail") + " " + e.toString());
                }
            } finally {
                dmActiveSubtitleDownloads.delete(url);
            }
        }
    );
}

function dmCreateTimeInputGroup(label, defaultValue, onBlurCallback) {
    const container = document.createElement("div");
    container.innerHTML = `<label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">${label}</label>`;
    const wrapper = document.createElement("div");
    wrapper.className = "idm-time-wrapper";
    const parts = defaultValue.split(":");
    const inpH = dmCreatePartInput(parts[0], 23);
    const inpM = dmCreatePartInput(parts[1], 59);
    const inpS = dmCreatePartInput(parts[2], 59);
    wrapper.append(inpH, dmCreateColon(), inpM, dmCreateColon(), inpS);
    container.appendChild(wrapper);
    const inputs = [inpH, inpM, inpS];
    inputs.forEach((inp, idx) => {
        inp.oninput = () => {
            inp.value = inp.value.replace(/[^0-9]/g, "");
            if (inp.value.length >= 2) {
                if (parseInt(inp.value) > parseInt(inp.getAttribute("max"))) inp.value = inp.getAttribute("max");
                if (idx < 2) { inputs[idx + 1].focus(); inputs[idx + 1].select(); } else inp.blur();
            }
        };
        inp.onfocus = () => inp.select();
        inp.onblur = () => {
            if (inp.value.length === 1) inp.value = "0" + inp.value;
            if (inp.value.length === 0) inp.value = "00";
            setTimeout(() => { if (!wrapper.contains(document.activeElement)) onBlurCallback(); }, 50);
        };
    });
    Object.defineProperty(container, "value", {
        get: () => `${inpH.value}:${inpM.value}:${inpS.value}`,
        set: (v) => {
            const p = v.split(":");
            if (p.length === 3) { inpH.value = p[0]; inpM.value = p[1]; inpS.value = p[2]; }
        }
    });
    return { container, input: container };
}

function dmCreatePartInput(v, max) {
    const i = document.createElement("input");
    i.className = "idm-time-input";
    i.value = v;
    i.maxLength = 2;
    i.setAttribute("max", max);
    return i;
}
function dmCreateColon() {
    const s = document.createElement("span");
    s.innerText = ":";
    s.className = "idm-time-colon";
    return s;
}
function dmHmsToSeconds(str) {
    const p = String(str || "00:00:00").split(":").map(Number);
    return (p[0] * 3600) + (p[1] * 60) + p[2];
}

function dmSegmentsFromJob(job) {
    // job.segments'ten süreleri kullanarak basit zaman ekseni kur
    const segs = Array.isArray(job.segments) ? job.segments : [];
    let t = 0;
    return segs.map((s, idx) => {
        const dur = typeof s.duration === "number" ? s.duration : 0;
        const startTime = t;
        const endTime = t + dur;
        t = endTime;
        return { url: s.url, duration: dur, startTime, endTime, index: typeof s.index === "number" ? s.index : idx };
    });
}

function dmOpenRangeFromSegments(job, segs, backdrop, playlistUrl, opts) {
    dmOpenRangeUI(
        job,
        backdrop,
        segs,
        2000000,
        { playlistUrl, isAudio: !!job.isAudio, audioLang: job.audioLang || "" },
        (job.captured && job.captured.snapshot) ? job.captured.snapshot : null,
        opts
    );
}

function createRangeTimeInputGroup(label, defaultValue, onBlurCallback) {
    const container = document.createElement("div");
    container.innerHTML = `<label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">${label}</label>`;
    const wrapper = document.createElement("div");
    wrapper.className = "idm-time-wrapper";
    const parts = defaultValue.split(":");
    const inpH = createRangePartInput(parts[0], 23);
    const inpM = createRangePartInput(parts[1], 59);
    const inpS = createRangePartInput(parts[2], 59);
    wrapper.append(inpH, createRangeColon(), inpM, createRangeColon(), inpS);
    container.appendChild(wrapper);
    const inputs = [inpH, inpM, inpS];
    inputs.forEach((inp, idx) => {
        inp.oninput = () => {
            inp.value = inp.value.replace(/[^0-9]/g, "");
            if (inp.value.length >= 2) {
                if (parseInt(inp.value) > parseInt(inp.getAttribute("max"))) {
                    inp.value = inp.getAttribute("max");
                }
                if (idx < 2) {
                    inputs[idx + 1].focus();
                    inputs[idx + 1].select();
                } else inp.blur();
            }
        };
        inp.onfocus = () => inp.select();
        inp.onblur = () => {
            if (inp.value.length === 1) inp.value = "0" + inp.value;
            if (inp.value.length === 0) inp.value = "00";
            setTimeout(() => {
                if (!wrapper.contains(document.activeElement)) onBlurCallback();
            }, 50);
        };
    });
    return {
        container,
        get value() {
            return `${inpH.value}:${inpM.value}:${inpS.value}`;
        },
        set value(v) {
            const p = v.split(":");
            if (p.length === 3) {
                inpH.value = p[0];
                inpM.value = p[1];
                inpS.value = p[2];
            }
        }
    };
}

function createRangePartInput(v, max) {
    const i = document.createElement("input");
    i.className = "idm-time-input";
    i.value = v;
    i.maxLength = 2;
    i.setAttribute("max", max);
    return i;
}

function createRangeColon() {
    const s = document.createElement("span");
    s.innerText = ":";
    s.className = "idm-time-colon";
    return s;
}

function hmsToSecondsRange(str) {
    const p = str.split(":").map(Number);
    return (p[0] * 3600) + (p[1] * 60) + p[2];
}

function validateRange(inpObj, type, totalDur, rangeContainer) {
    let val = inpObj.value;
    let sec = hmsToSecondsRange(val);
    if (isNaN(sec) || sec < 0) sec = 0;
    if (sec > totalDur) {
        sec = totalDur;
        inpObj.value = formatTimeDM(sec);
    }
    // DM içinde snapping yapmıyoruz; sadece süre aralığını güncelliyoruz
    const updateInfoEl = rangeContainer.querySelector("#selected-range");
    if (updateInfoEl) {
        const s = hmsToSecondsRange(
            type === "start" ? inpObj.value : rangeContainer.querySelector("#grp-start input").value
        );
        const e = hmsToSecondsRange(
            type === "end" ? inpObj.value : rangeContainer.querySelector("#grp-end input").value
        );
        if (s >= e) {
            updateInfoEl.innerHTML = `<span style="color:#e74c3c">${dmT("content.rangeInvalidOrder")}</span>`;
        }
    }
}

async function startJob(id) {
    if (!dmLegalAccepted) {
        alert(dmT("alert.legalRequiredDownload"));
        chrome.runtime.sendMessage({ action: "OPEN_LEGAL_POPUP" }, () => {});
        return;
    }
    const job = findJob(id);
    if (!job) return;
    dmSendDebug("startJob", { id, isMp4: !!job.isMp4, outputMp4: !!job.outputMp4, transmuxToMp4: !!job.transmuxToMp4 });

    // MP4 planı iptal: burada TS segmentleri olduğu gibi indiriyoruz.
    // Eğer playlist fMP4 (#EXT-X-MAP) ise, TS dosyası üretmek için MP4 pipeline gerekir (iptal edildi).
    job.outputMp4 = false;
    job.transmuxToMp4 = false;
    if (job.initSegmentUrl) {
        job.status = "error";
        job.endTime = Date.now();
        job.lastError = dmT("dm.jobErrorFm4Only");
        activeJobId = null;
        saveJobs();
        renderJobs();
        bugiRunAutoQueue();
        return;
    }

    // MP4 işler için: tarayıcı indirmesi (downloads API) kullan; aktif HLS indirmesini engelleme
    if (job.isMp4) {
        if (!job.sourceUrl) return;
        job.status = "downloading";
        job.startTime = job.startTime || Date.now();
        renderJobs();

        const rawTitle = job.pageTitle || job.title || "video";
        const baseTitle = rawTitle.replace(/[\\/:*?\"<>|]/g, "-").trim();
        const fileName = (baseTitle || "video") + ".mp4";

        // Sabit klasör açıksa tarayıcı indirmesi klasörü zaten senin sistem ayarına göre;
        // sadece Save As davranışını fixedDirEnabled'a göre belirleyelim
        const saveAs = !fixedDirEnabled;
        chrome.runtime.sendMessage(
            { action: "DOWNLOAD_MP4", url: job.sourceUrl, filename: fileName, saveAs },
            (resp) => {
                if (!resp || !resp.success) {
                    job.status = "error";
                    job.endTime = Date.now();
                } else {
                    job.status = "completed";
                    job.endTime = Date.now();
                }
                saveJobs();
                renderJobs();
                bugiRunAutoQueue();
            }
        );
        return;
    }

    if (!job.segments || !job.segments.length) return;
    if (job.status === "downloading" || job.status === "finalizing") return;

    if (activeJobId && activeJobId !== id) {
        alert(dmT("dm.alertOtherJobActive"));
        return;
    }

    activeJobId = id;
    dmUpdateBgThrottleHint();
    job.status = "downloading";
    job._paused = false;
    job._autoPaused = false;
    job.startTime = job.startTime || Date.now();
    // finishedSegments: "diske yazılmış ardışık segment sayısı" (resume güvenliği için)
    job.finishedSegments = Math.max(0, parseInt(job.finishedSegments, 10) || 0);
    job.totalBytes = job.totalBytes || 0;
    job._cancelRequested = false;
    job.errorCount = job.errorCount || 0;
    job.lastError = job.lastError || "";
    job.failedSegments = Array.isArray(job.failedSegments) ? job.failedSegments : [];
    renderJobs();

    const baseTitle = (job.title || "video").replace(/[\\/:*?"<>|]/g, "-").trim();
    const dubPart = job.isAudio ? " dub" : "";
    const fileName = (baseTitle + dubPart).trim() + ".ts";
    job.outputName = fileName;
    dmSendDebug("output file", { fileName, wantsMp4Out: false, hasMuxJs: false });

    const ok = await diskManagerDM.init(fileName);
    if (!ok) {
        job.status = "cancelled";
        job.endTime = Date.now();
        activeJobId = null;
        dmUpdateBgThrottleHint();
        saveJobs();
        renderJobs();
        bugiRunAutoQueue();
        return;
    }

    await dmAcquireThroughputAssist();
    try {
    const segs = job.segments.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    const startIndex = job.finishedSegments || 0;

    const maxConcurrent = Math.max(1, Math.min(32, dmMaxConcurrent));
    let nextIndex = startIndex;

    // Not: fMP4 (EXT-X-MAP) için init segment yazma / MP4 birleştime iptal edildi.

    // MP4 transmux pipeline iptal edildi.

    const runOneSegment = async () => {
        if (job._cancelRequested) return;
        while (job._paused) {
            await new Promise((r) => setTimeout(r, 500));
            if (job._cancelRequested) return;
        }
        if (nextIndex >= segs.length) return;
        const i = nextIndex++;
        const seg = segs[i];
        try {
            let ok = false;
            ok = await fetchSegmentAndWrite(job, seg, i);
            if (!ok) {
                job.failedSegments.push({ index: i, url: seg.url });
                // Yazma sırası için bu segment kritik: delik bırakıp tamamlanamaz.
                // Aynı işi duraklat ve "Devam Et" ile aynı segmentten tekrar dene.
                job._paused = true;
                job._autoPaused = true;
                job.pauseTime = Date.now();
                job.status = "paused";
                job.lastError = job.lastError || dmT("dm.jobErrorSegmentRetry");
                // Bu segmenti tekrar denemek için index'i geri sar
                nextIndex = Math.min(nextIndex, i);
                saveJobs();
                renderJobs();
                return;
            }
            // finishedSegments: gerçekten diske yazılmış ardışık parça sayısı
            job.finishedSegments = Math.max(job.finishedSegments || 0, diskManagerDM.getCommittedCount());
            saveJobsThrottled();
            // Sadece aktif kartı güncelle (tüm listeyi yeniden çizme)
            updateLiveJobUI(job);
        } catch (e) {
            job.errorCount = (job.errorCount || 0) + 1;
            job.lastError = e ? String(e) : dmT("content.unknownError");
            job.failedSegments.push({ index: i, url: seg.url });
            job._paused = true;
            job._autoPaused = true;
            job.pauseTime = Date.now();
            job.status = "paused";
            job.finishedSegments = Math.max(job.finishedSegments || 0, diskManagerDM.getCommittedCount());
            nextIndex = Math.min(nextIndex, i);
            saveJobsThrottled();
            updateLiveJobUI(job);
        }
    };

    const worker = async () => {
        while (nextIndex < segs.length && !job._cancelRequested) {
            await runOneSegment();
        }
    };

    const workerCount = Math.min(maxConcurrent, segs.length - startIndex);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    // MP4 transmux pipeline iptal edildi.

    if (job._cancelRequested) {
        await diskManagerDM.close();
        job.status = "cancelled";
        job.endTime = Date.now();
        activeJobId = null;
        saveJobs();
        renderJobs();
        bugiRunAutoQueue();
        return;
    }

    job.finishedSegments = segs.length;
    job.status = "finalizing";
    saveJobs();
    renderJobs();
    updateLiveJobUI(job);

    let closeFailed = false;
    try {
        await Promise.race([
            diskManagerDM.close(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("FINALIZE_TIMEOUT")), DM_CLOSE_TIMEOUT_MS))
        ]);
    } catch (e) {
        closeFailed = true;
        const msg =
            e && String(e.message) === "FINALIZE_TIMEOUT"
                ? dmT("dm.finalizeTimeoutDetail")
                : e
                  ? String(e)
                  : dmT("dm.finalizeFailGeneric");
        job.lastError = msg;
        job.status = "error";
        job.endTime = Date.now();
        try { await diskManagerDM.abortWritable(); } catch (_e) {}
    }

    if (!closeFailed) {
        job.status = "completed";
        job.endTime = Date.now();
        bugiPlayCompletedSound();
    }

    activeJobId = null;
    saveJobs();
    renderJobs();
    bugiRunAutoQueue();
    } finally {
        dmReleaseThroughputAssist();
    }
}

function fetchSegmentAndWrite(job, seg, logicalIndex, attempt = 1) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            {
                action: "fetchUrl",
                url: seg.url,
                isBinary: true,
                referer: job.pageUrl || job.sourceUrl || ""
            },
            async (resp) => {
                const maxAttempts = 3;
                try {
                    // resp.data boş string gelebilir (bytes=0 ise b64 => ""), bu durumda bunu
                    // "başarısız" saymayalım; 0 byte chunk yazılabilmeli.
                    if (!resp || !resp.success || typeof resp.data !== "string") {
                        if (attempt < maxAttempts) {
                            setTimeout(() => {
                                fetchSegmentAndWrite(job, seg, logicalIndex, attempt + 1).then(resolve);
                            }, 500 * attempt);
                            return;
                        }
                        job.errorCount = (job.errorCount || 0) + 1;
                        job.lastError = (resp && resp.error) ? String(resp.error) : dmT("content.unknownError");
                        resolve(false);
                        return;
                    }
                    if (typeof resp.data !== "string") throw new Error(dmT("dm.errSegmentBinary"));
                    const bytes = await dmBase64ToBytesFast(resp.data);
                    job.totalBytes += bytes.byteLength;
                    await diskManagerDM.writeSegment(logicalIndex, bytes);
                    resolve(true);
                } catch (e) {
                    if (attempt < maxAttempts) {
                        setTimeout(() => {
                            fetchSegmentAndWrite(job, seg, logicalIndex, attempt + 1).then(resolve);
                        }, 500 * attempt);
                        return;
                    }
                    job.errorCount = (job.errorCount || 0) + 1;
                    job.lastError = e ? String(e) : dmT("content.unknownError");
                    resolve(false);
                }
            }
        );
    });
}

function fetchSegmentBytesAndBuffer(job, seg, logicalIndex, map, onBufferedDelta, attempt = 1) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            {
                action: "fetchUrl",
                url: seg.url,
                isBinary: true,
                referer: job.pageUrl || job.sourceUrl || ""
            },
            async (resp) => {
                const maxAttempts = 3;
                try {
                    // resp.data boş string gelebilir (bytes=0 ise b64 => ""), bunu başarısız saymayalım.
                    if (!resp || !resp.success || typeof resp.data !== "string") {
                        if (attempt < maxAttempts) {
                            setTimeout(() => {
                                fetchSegmentBytesAndBuffer(job, seg, logicalIndex, map, onBufferedDelta, attempt + 1).then(resolve);
                            }, 500 * attempt);
                            return;
                        }
                        job.errorCount = (job.errorCount || 0) + 1;
                        job.lastError = (resp && resp.error) ? String(resp.error) : dmT("content.unknownError");
                        resolve(false);
                        return;
                    }
                    if (typeof resp.data !== "string") throw new Error(dmT("dm.errSegmentBinary"));
                    const bytes = await dmBase64ToBytesFast(resp.data);
                    job.totalBytes += bytes.byteLength;
                    if (!map || typeof map.set !== "function") throw new Error(dmT("dm.errBufferNotReady"));
                    map.set(logicalIndex, bytes);
                    dmSendDebug("buffered", { index: logicalIndex, bytes: bytes.byteLength });
                    try { onBufferedDelta && onBufferedDelta(bytes.byteLength); } catch (_e) {}
                    resolve(true);
                } catch (e) {
                    if (attempt < maxAttempts) {
                        setTimeout(() => {
                            fetchSegmentBytesAndBuffer(job, seg, logicalIndex, map, onBufferedDelta, attempt + 1).then(resolve);
                        }, 500 * attempt);
                        return;
                    }
                    job.errorCount = (job.errorCount || 0) + 1;
                    job.lastError = e ? String(e) : dmT("content.unknownError");
                    resolve(false);
                }
            }
        );
    });
}

function startInlineEditTitle(id, titleEl) {
    const job = findJob(id);
    if (!job || !titleEl) return;
    if (titleEl._editing) return;
    titleEl._editing = true;

    const currentTitle = job.customTitle || job.title || "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentTitle || "";
    input.style.width = "100%";
    input.style.background = "transparent";
    input.style.border = "1px solid #555";
    input.style.borderRadius = "4px";
    input.style.color = "#f5f5f5";
    input.style.padding = "2px 4px";
    input.style.fontSize = "14px";
    input.style.fontFamily = "inherit";

    const finish = (commit) => {
        if (commit) {
            const v = input.value.trim();
            job.customTitle = v || undefined;
            saveJobs();
        }
        titleEl._editing = false;
        renderJobs();
    };

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    });

    titleEl.textContent = "";
    titleEl.appendChild(input);
    input.focus();
    input.select();
}

function startInlineEditSite(id, metaEl) {
    const job = findJob(id);
    if (!job || !metaEl) return;
    if (metaEl._editing) return;
    metaEl._editing = true;

    const currentSite = metaEl.textContent || job.customSiteLabel || "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentSite;
    input.placeholder = dmT("dm.placeholderSiteEdit");
    input.style.width = "100%";
    input.style.background = "transparent";
    input.style.border = "1px solid #555";
    input.style.borderRadius = "4px";
    input.style.color = "#f5f5f5";
    input.style.padding = "2px 4px";
    input.style.fontSize = "11px";
    input.style.fontFamily = "inherit";

    const finish = (commit) => {
        if (commit) {
            const v = input.value.trim();
            job.customSiteLabel = v || undefined;
            saveJobs();
        }
        metaEl._editing = false;
        renderJobs();
    };

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    });

    metaEl.textContent = "";
    metaEl.appendChild(input);
    input.focus();
    input.select();
}

document.addEventListener("DOMContentLoaded", () => {
    void (async () => {
        try {
            if (typeof BugiI18n !== "undefined" && BugiI18n.initFromStorage) {
                await BugiI18n.initFromStorage();
                if (BugiI18n.applyDom) BugiI18n.applyDom(document.documentElement);
            }
        } catch (_e) {}
        renderJobs();
    })();

    chrome.runtime.sendMessage({ action: "GET_UPDATE_STATUS" }, (resp) => {
        const st = resp && resp.status ? resp.status : null;
        if (st && st.hasUpdate) {
            alert(dmT("dm.updatePrompt"));
        }
    });
    dmRefreshLegalStatus();

    const fixedDirCheckbox = document.getElementById("fixed-dir-checkbox");
    const fixedDirLabel = document.getElementById("fixed-dir-label");
    const dmDebugBtn = document.getElementById("btn-dm-debug-log");
    const searchInput = document.getElementById("search-input");
    const pageSizeSelect = document.getElementById("page-size-select");
    const leftListEl = document.getElementById("downloads-left-list");
    const rightListEl = document.getElementById("downloads-right-list");
    const completedSortEl = document.getElementById("completed-sort-toggle");
    const pendingSortEl = document.getElementById("pending-sort-toggle");
    const completedClearEl = document.getElementById("completed-clear");
    const pendingClearEl = document.getElementById("pending-clear");
    const pendingRunAllEl = document.getElementById("pending-run-all");
    const completedPrev = document.getElementById("completed-prev");
    const completedNext = document.getElementById("completed-next");
    const pendingPrev = document.getElementById("pending-prev");
    const pendingNext = document.getElementById("pending-next");

    // Lists are flex-sized via CSS; do not force heights in JS (can break scrolling).

    loadJobs();
    bugiLoadNotificationSettings();

    document.addEventListener("visibilitychange", async () => {
        dmUpdateBgThrottleHint();
        if (document.visibilityState === "visible" && activeJobId) {
            try {
                if (typeof navigator !== "undefined" && navigator.wakeLock && navigator.wakeLock.request) {
                    dmWakeLock = await navigator.wakeLock.request("screen");
                }
            } catch (_e) {}
        }
    });

    // Debug durumu: popup ile aynı anahtar
    chrome.storage.local.get(["isDebugActive"], (res) => {
        dmIsDebugActive = !!res.isDebugActive;
        dmUpdateDebugButtonUI(dmIsDebugActive);
    });

    if (dmDebugBtn) {
        dmDebugBtn.addEventListener("click", () => {
            if (!dmIsDebugActive) {
                chrome.storage.local.set({ isDebugActive: true }, () => {
                    dmIsDebugActive = true;
                    dmUpdateDebugButtonUI(true);
                    dmSendDebug(dmT("dm.debugLogStarted"));
                });
            } else {
                chrome.runtime.sendMessage({ action: "GET_DEBUG_LOGS" }, (resp) => {
                    const logs = (resp && resp.logs) ? resp.logs : dmT("dm.debugNoLogData");
                    try {
                        const blob = new Blob([logs], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `bugi_dm_debug_${new Date().getTime()}.txt`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                    } catch (_e) {}

                    chrome.storage.local.set({ isDebugActive: false }, () => {
                        dmIsDebugActive = false;
                        dmUpdateDebugButtonUI(false);
                    });
                });
            }
        });
    }

    // Sekme kapanırsa throttle beklemesin: son durumu yaz
    window.addEventListener("beforeunload", () => {
        try { saveJobs(); } catch (_e) {}
    });

    // Geliştirici modu ve klasör ayarını oku
    chrome.storage.local.get(['devMode', 'maxConcurrent', 'dmPageSize'], (res) => {
        devModeOn = !!res.devMode;
        dmMaxConcurrent = Math.min(32, Math.max(1, parseInt(res.maxConcurrent, 10) || DM_MAX_CONCURRENT_DEFAULT));
        dmPageSize = clamp(parseInt(res.dmPageSize, 10) || DM_PAGE_SIZE_DEFAULT, 1, 5000);
        if (pageSizeSelect) pageSizeSelect.value = String(dmPageSize);
        // Sabit klasör ayarı her açılışta varsayılan olarak kapalı başlasın
        fixedDirEnabled = false;
        fixedDirHandle = null;
        if (fixedDirCheckbox) fixedDirCheckbox.checked = false;
        chrome.storage.local.set({ bugiFixedDirEnabled: false });
        renderJobs();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.devMode) {
            devModeOn = !!changes.devMode.newValue;
            renderJobs();
        }
        if (area === "local" && changes.isDebugActive !== undefined) {
            dmIsDebugActive = !!changes.isDebugActive.newValue;
            dmUpdateDebugButtonUI(dmIsDebugActive);
        }
        if (area === 'local' && changes.maxConcurrent) {
            const v = changes.maxConcurrent.newValue;
            dmMaxConcurrent = Math.min(32, Math.max(1, parseInt(v, 10) || DM_MAX_CONCURRENT_DEFAULT));
        }
        if (area === 'local' && changes.dmPageSize) {
            const v = changes.dmPageSize.newValue;
            dmPageSize = clamp(parseInt(v, 10) || DM_PAGE_SIZE_DEFAULT, 1, 5000);
            if (pageSizeSelect) pageSizeSelect.value = String(dmPageSize);
            completedPage = 1;
            pendingPage = 1;
            renderJobs();
        }
        // Bildirim sesi ayarları DM açıkken değişince anında uygula
        if (area === "local" && (changes.notifSoundKey || changes.notifVolume || changes.notifCustomSounds)) {
            bugiLoadNotificationSettings();
        }
        if (area === "local" && (changes.bugiLegalAcceptedV1 !== undefined || changes.bugiLegalAcceptedVersionV1 !== undefined)) {
            dmRefreshLegalStatus();
        }
        if (area === "local" && changes.uiLocale) {
            void (async () => {
                try {
                    if (typeof BugiI18n !== "undefined" && BugiI18n.initFromStorage) {
                        await BugiI18n.initFromStorage();
                        if (BugiI18n.applyDom) BugiI18n.applyDom(document.documentElement);
                    }
                } catch (_e) {}
                renderJobs();
            })();
        }
    });
    if (fixedDirCheckbox) {
        fixedDirCheckbox.addEventListener("change", async () => {
            if (fixedDirCheckbox.checked) {
                try {
                    if (!window.showDirectoryPicker) {
                        alert(dmT("dm.alertFolderUnsupported"));
                        fixedDirCheckbox.checked = false;
                        return;
                    }
                    const dir = await window.showDirectoryPicker();

                    // Klasör seçildiği anda okuma/yazma iznini de almaya çalış (ilk indirmede tekrar sormasın)
                    let perm = "granted";
                    try {
                        if (dir.queryPermission) {
                            perm = await dir.queryPermission({ mode: "readwrite" });
                        }
                        if (perm === "prompt" && dir.requestPermission) {
                            perm = await dir.requestPermission({ mode: "readwrite" });
                        }
                    } catch (_e) {
                        // izin isteği hatası durumunda perm olduğu gibi kalır
                    }

                    if (perm !== "granted") {
                        alert(dmT("dm.alertFolderDenied"));
                        fixedDirEnabled = false;
                        fixedDirHandle = null;
                        fixedDirCheckbox.checked = false;
                        chrome.storage.local.set({ bugiFixedDirEnabled: false });
                        if (fixedDirLabel) fixedDirLabel.textContent = "";
                        return;
                    }

                    fixedDirHandle = dir;
                    fixedDirEnabled = true;
                    chrome.storage.local.set({ bugiFixedDirEnabled: true });
                    if (fixedDirLabel) {
                        fixedDirLabel.innerHTML = dmTf("dm.fixedDirNoteHtml", { name: dir.name });
                    }
                } catch (_e) {
                    fixedDirEnabled = false;
                    fixedDirHandle = null;
                    fixedDirCheckbox.checked = false;
                    chrome.storage.local.set({ bugiFixedDirEnabled: false });
                    if (fixedDirLabel) fixedDirLabel.textContent = "";
                }
            } else {
                fixedDirEnabled = false;
                fixedDirHandle = null;
                chrome.storage.local.set({ bugiFixedDirEnabled: false });
                if (fixedDirLabel) fixedDirLabel.textContent = "";
            }
        });
    }

    if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener("input", () => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                searchQuery = searchInput.value || "";
                completedPage = 1;
                pendingPage = 1;
                renderJobs();
            }, 200);
        });
    }

    if (pageSizeSelect) {
        pageSizeSelect.addEventListener("change", () => {
            const v = clamp(parseInt(pageSizeSelect.value, 10) || DM_PAGE_SIZE_DEFAULT, 1, 5000);
            dmPageSize = v;
            chrome.storage.local.set({ dmPageSize: v });
            completedPage = 1;
            pendingPage = 1;
            renderJobs();
        });
    }

    if (completedPrev) completedPrev.addEventListener("click", () => { completedPage = Math.max(1, completedPage - 1); renderJobs(); });
    if (completedNext) completedNext.addEventListener("click", () => { completedPage = completedPage + 1; renderJobs(); });
    if (pendingPrev) pendingPrev.addEventListener("click", () => { pendingPage = Math.max(1, pendingPage - 1); renderJobs(); });
    if (pendingNext) pendingNext.addEventListener("click", () => { pendingPage = pendingPage + 1; renderJobs(); });

    if (completedSortEl) {
        completedSortEl.addEventListener("click", () => {
            completedSortAsc = !completedSortAsc;
            completedPage = 1;
            renderJobs();
        });
    }
    if (pendingSortEl) {
        pendingSortEl.addEventListener("click", () => {
            pendingSortAsc = !pendingSortAsc;
            pendingPage = 1;
            renderJobs();
        });
    }
    if (completedClearEl) {
        completedClearEl.addEventListener("click", () => {
            if (!downloadJobs.some(j => j.status === "completed")) return;
            if (!confirm(dmT("dm.confirmClearCompleted"))) return;
            downloadJobs = downloadJobs.filter(j => j.status !== "completed");
            saveJobs();
            renderJobs();
        });
    }
    if (pendingClearEl) {
        pendingClearEl.addEventListener("click", () => {
            const hasPending = downloadJobs.some(j => j.status !== "completed");
            if (!hasPending) return;
            if (!confirm(dmT("dm.confirmClearPending"))) return;
            if (activeJobId) {
                cancelJob(activeJobId);
            }
            downloadJobs = downloadJobs.filter(j => j.status === "completed");
            saveJobs();
            renderJobs();
        });
    }

    if (pendingRunAllEl) {
        pendingRunAllEl.addEventListener("click", () => {
            if (!downloadJobs.some(j => j.status === "queued")) {
                alert(dmT("dm.alertNoQueued"));
                return;
            }
            bugiAutoQueueAll = true;
            if (!activeJobId) {
                bugiRunAutoQueue();
            }
        });
    }

    // İnternet bağlantısı gittiğinde aktif indirmeyi otomatik duraklat
    window.addEventListener("offline", () => {
        if (!activeJobId) return;
        const job = findJob(activeJobId);
        if (!job || job.status !== "downloading") return;
        pauseJob(activeJobId, true);
        alert(dmT("dm.alertOfflinePaused"));
    });

    BugiJsonImport.init({
        addJob,
        dmAnalyzeSegments,
        dmTryDecodeBase64Playlist
    });
    BugiJsonImport.installGlobalDrop();
});

chrome.runtime.onMessage.addListener((req, _sender, _sendResponse) => {
    if (req && req.action === "REGISTER_DOWNLOAD_JOB" && req.job) {
        addJob(req.job);
    }
});

