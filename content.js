// =========================================================================
// AYARLAR & GLOBAL DEĞİŞKENLER
// =========================================================================
let MAX_CONCURRENT_DOWNLOADS = 8;
const SAFETY_FACTOR = 0.93;
let lastWinTop = null, lastWinLeft = null;
const isTopFrame = window.self === window.top;
let currentUrl = "",
    videoType = "HLS",
    downloadQueue = [],
    activeDownloads = 0,
    totalSegments = 0,
    parsedSegmentsData = [],
    selectedQualityBandwidth = 0,
    isPaused = false,
    isCancelled = false,
    isDownloading = false,
    isMinimized = false,
    retryCount = 0;
let detectedSubtitles = [];
let subtitleRefreshTimer = null;
let currentMenuSourceUrl = "";
let detectedAudios = [];
let errorLogEntries = [];
let errorLogGenerated = false;
let segmentRetryCount = {};
const MAX_SEGMENT_RETRY = 3;
let finishedSegments = new Set();
let segmentsBase64Wrapped = false;
let segmentEncodingChecked = false;
let isDevMode = false;
let isExtensionEnabled = true; // YENİ: Eklenti Açık/Kapalı Durumu
let currentDownloadAudioLang = ""; // YENİ: Aktif dublaj dili (dosya adı için)
const activeSubtitleDownloads = new Set(); // Aynı altyazıyı çoklu indirmeyi engelle
let downloadStats = {
    startTime: null,
    totalBytes: 0,
    lastBytes: 0,
    lastTime: null
};
let uiUpdateInterval = null;
let videoHuntInterval = null;
/** Ayarlardan: açıksa ağır DOM+shadow tarama (popup değişince sekme yenilenir). */
let forceVideoHuntMode = false;
let interceptedPlaylists = {};

/** Engellenen yayın siteleri (popup ile aynı mantık). */
const CONTENT_FORCED_BLOCKED_HOST_FRAGMENTS_FALLBACK = [
    "www.youtube.com",
    "netflix.com",
    "disneyplus.com",
    "primevideo.com",
    "hulu.com",
    "max.com",
    "hbomax.com",
    "tv.apple.com"
];
const FORCED_BLOCKED_SITES_REMOTE_KEY = "forcedBlockedSitesRemote";
let contentForcedBlockedHostFragments = CONTENT_FORCED_BLOCKED_HOST_FRAGMENTS_FALLBACK.slice();

const VIDEO_HUNT_LIGHT_INTERVAL_MS = 2800;
const VIDEO_HUNT_FORCE_INTERVAL_MS = 1000;

function shouldSuppressCorsLikeError(err) {
    if (forceVideoHuntMode) return false;
    const msg = String(err || "").toLowerCase();
    return msg.includes("failed to fetch")
        || msg.includes("typeerror")
        || msg.includes("cors")
        || msg.includes("cross-origin");
}

function mergeBlockedSitesList(storedList) {
    const blocked = Array.isArray(storedList) ? storedList.slice() : [];
    contentForcedBlockedHostFragments.forEach((site) => {
        if (!blocked.includes(site)) blocked.push(site);
    });
    return blocked;
}

const BUGI_PREVIEW_EYE_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

// Tekrar indir için snapshot (siteye gitmeden aynı UI)
let reDlSnapshot = {
    v: 1,
    masterUrl: "",
    masterBody: "",
    // url -> decoded playlist body
    variantBodies: {},
    audioBodies: {},
    analyzedUrl: "",
    analyzedBody: "",
    analyzedBw: 0,
    analyzedIsAudio: false,
    analyzedAudioLang: ""
};

// Kalite listesi: Tekrar indir (download.js) ile aynı ses göstergesi + probe cache
const contentAudioProbeCache = new Map();

function contentAudioIconHtml(mode) {
    const isMuxed = mode === "muxed";
    const color = isMuxed ? "#4caf50" : "#8a8a8a";
    const opacity = isMuxed ? "1" : "0.85";
    const slash = mode !== "muxed"
        ? `<path d="M4 4 L20 20" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`
        : "";
    const title =
        mode === "muxed"
            ? BugiI18n.t("content.audioIconMuxed")
            : mode === "separate"
              ? BugiI18n.t("content.audioIconSeparate")
              : BugiI18n.t("content.audioIconNone");
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
}

function contentInferAudioModeFromStreamInf(line) {
    const l = String(line || "");
    if (/AUDIO="/i.test(l)) return "separate";
    const codecsMatch = l.match(/CODECS="([^"]+)"/i);
    if (codecsMatch && codecsMatch[1]) {
        const codecs = codecsMatch[1].toLowerCase();
        if (codecs.includes("mp4a")) return "muxed";
        return "none";
    }
    return "muxed";
}

async function contentBase64ToBytesFast(b64) {
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

function contentParseInitSegmentUrlFromPlaylist(text, baseUrl) {
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

function contentMp4InitHasAudioTrack(bytes) {
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

function contentTsSegmentHasAudio(bytes) {
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

function contentParseSegmentsForSampling(text, baseUrl) {
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

function contentPickSampleIndices(n, k) {
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

async function contentEstimateSizeByHeadSampling(body, baseUrl) {
    const parsed = contentParseSegmentsForSampling(body, baseUrl);
    const segs = parsed.segments || [];
    const totalDur = parsed.totalDur || 0;
    if (!segs.length || !totalDur) return null;

    const sampleIdx = contentPickSampleIndices(segs.length, 6);
    let sumBytes = 0;
    let sumDur = 0;
    let okCount = 0;
    const ref = window.location.href || "";

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
    return formatBytes(estimatedBytes);
}

async function contentProbeVariantAudioMode(variantUrl, playlistBody, referer) {
    const key = String(variantUrl || "");
    if (!key) return null;
    if (contentAudioProbeCache.has(key)) return contentAudioProbeCache.get(key);
    const ref = referer || "";

    try {
        const initUrl = contentParseInitSegmentUrlFromPlaylist(playlistBody, key);
        if (initUrl) {
            const initResp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "fetchUrl", url: initUrl, isBinary: true, referer: ref }, (r) => resolve(r || null)));
            if (initResp && initResp.success && typeof initResp.data === "string") {
                const bytes = await contentBase64ToBytesFast(initResp.data);
                const mode = contentMp4InitHasAudioTrack(bytes) ? "muxed" : "none";
                contentAudioProbeCache.set(key, mode);
                return mode;
            }
        }

        const parsed = contentParseSegmentsForSampling(playlistBody, key);
        const first = parsed.segments && parsed.segments.length ? parsed.segments[0] : null;
        if (first && first.url) {
            const segResp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "fetchUrl", url: first.url, isBinary: true, referer: ref }, (r) => resolve(r || null)));
            if (segResp && segResp.success && typeof segResp.data === "string") {
                const bytes = await contentBase64ToBytesFast(segResp.data);
                const mode = contentTsSegmentHasAudio(bytes) ? "muxed" : "none";
                contentAudioProbeCache.set(key, mode);
                return mode;
            }
        }
    } catch (_e) {}
    return null;
}


// content.js - En üste ekle
function sendDebug(msg, data = "") {
    if (!isDevMode) return; // İsteğe bağlı: Sadece devMode açıksa logla
    chrome.runtime.sendMessage({
        action: "ADD_DEBUG_LOG", 
        source: "CONTENT", 
        msg: msg, 
        data: data
    }).catch(() => {}); // Sekme kapandığında vs. hata fırlatmasını önler
}

function syncInjectInterceptionState() {
    try {
        window.postMessage({
            action: "BUGIVID_SET_INTERCEPT_ENABLED",
            enabled: !!isExtensionEnabled
        }, "*");
    } catch (_e) {}
}

// =========================================================================
// 1. BAŞLANGIÇ
// =========================================================================
/** İlk çizimden önce sözlük yüklensin (content script’te fetch / yarış için). */
const bugiContentI18nReady = (async () => {
    try {
        if (typeof BugiI18n !== "undefined" && BugiI18n.initFromStorage) {
            await BugiI18n.initFromStorage();
        }
    } catch (_e) {}
})();

void (async function bugiContentBootstrap() {
    await bugiContentI18nReady;
    chrome.storage.local.get(
        ["blockedSites", "maxConcurrent", "devMode", "extensionEnabled", "forceVideoHunt", FORCED_BLOCKED_SITES_REMOTE_KEY],
        (result) => {
            if (result.maxConcurrent) {
                MAX_CONCURRENT_DOWNLOADS = parseInt(result.maxConcurrent) || 8;
                concurrentManager.setMaxConcurrent(MAX_CONCURRENT_DOWNLOADS);
            }
            if (result.devMode) isDevMode = true;
            if (result.extensionEnabled === false) isExtensionEnabled = false; // YENİ
            forceVideoHuntMode = !!result.forceVideoHunt;
            const remoteForced = Array.isArray(result && result[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? result[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
            contentForcedBlockedHostFragments = Array.from(new Set(CONTENT_FORCED_BLOCKED_HOST_FRAGMENTS_FALLBACK.concat(remoteForced)));
            syncInjectInterceptionState();

            const blocked = mergeBlockedSitesList(result.blockedSites);
            if (blocked.some((site) => window.location.hostname.includes(site))) return;

            if (isExtensionEnabled) {
                setTimeout(() => {
                    try {
                        injectStyles();
                    } catch (_e) {}
                    startVideoHunt();
                }, 1000);
            }
        }
    );
})();

// YENİ: Popup'tan şalter kapatılınca sayfada ANINDA etkisini gösterir
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
        if (changes.uiLocale !== undefined) {
            void (async () => {
                try {
                    if (typeof BugiI18n !== "undefined" && BugiI18n.initFromStorage) {
                        await BugiI18n.initFromStorage();
                    }
                } catch (_e) {}
                const mainBtn = document.querySelector("#idm-btn-wrapper .idm-main-btn");
                if (mainBtn && typeof BugiI18n !== "undefined" && BugiI18n.t) {
                    mainBtn.textContent = BugiI18n.t("content.downloadMain");
                }
            })();
        }
        if (changes.devMode !== undefined) {
            isDevMode = changes.devMode.newValue;
        }
        if (changes[FORCED_BLOCKED_SITES_REMOTE_KEY] !== undefined) {
            const remoteForced = Array.isArray(changes[FORCED_BLOCKED_SITES_REMOTE_KEY].newValue)
                ? changes[FORCED_BLOCKED_SITES_REMOTE_KEY].newValue
                : [];
            contentForcedBlockedHostFragments = Array.from(new Set(CONTENT_FORCED_BLOCKED_HOST_FRAGMENTS_FALLBACK.concat(remoteForced)));
        }
        if (changes.extensionEnabled !== undefined) {
            isExtensionEnabled = changes.extensionEnabled.newValue;
            syncInjectInterceptionState();
            if (isExtensionEnabled) {
                injectStyles();
                chrome.storage.local.get(["forceVideoHunt"], (r) => {
                    forceVideoHuntMode = !!(r && r.forceVideoHunt);
                    startVideoHunt();
                });
            } else {
                // Şalter kapandığında ekrandaki her şeyi temizle
                stopVideoHunt();
                const wrapper = document.getElementById("idm-btn-wrapper");
                if (wrapper) wrapper.remove();
                document.querySelectorAll(".idm-window").forEach(w => w.remove());
            }
        }
    }
});

// YENİ: Popup'tan geliştirici modu değiştiğinde anında algıla
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.devMode !== undefined) {
        isDevMode = changes.devMode.newValue;
    }
    if (area === "local" && (changes.bugiLegalAcceptedV1 !== undefined || changes.bugiLegalAcceptedVersionV1 !== undefined)) {
        refreshLegalAcceptance();
    }
});

let isLegalAccepted = false;
function refreshLegalAcceptance() {
    chrome.runtime.sendMessage({ action: "GET_LEGAL_STATUS", incognito: !!(chrome.extension && chrome.extension.inIncognitoContext) }, (res) => {
        isLegalAccepted = !!(res && res.accepted);
    });
}
refreshLegalAcceptance();

// =========================================================================
// 2. MESAJ DİNLEYİCİSİ
// =========================================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    const needsLegalAcceptance = req && (
        req.action === "SPAWN_UI_ON_TOP" ||
        req.action === "DOWNLOAD_SUBTITLE" ||
        req.action === "DOWNLOAD_AUDIO"
    );
    if (needsLegalAcceptance) {
        if (!isLegalAccepted) {
            alert(BugiI18n.t("content.legalRequired"));
            chrome.runtime.sendMessage({ action: "OPEN_LEGAL_POPUP" }).catch(() => {});
            sendResponse && sendResponse({ success: false, blockedByLegal: true });
            return true;
        }
    }

    if (req.action === "UPDATE_CONCURRENCY") {
        const val = parseInt(req.value);
        if (val > 0) {
            MAX_CONCURRENT_DOWNLOADS = val;
            concurrentManager.setMaxConcurrent(val);
            if (document.getElementById("speed-display")) {
                document.getElementById("speed-display").innerText = val;
            }
            if (isDownloading && !isPaused) processQueue();
        }
    }

    if (req.action === "urlCaught") {
        if (req.type === "SUBTITLE") {
            addSubtitleFromUrl(req.url);
            return;
        }
        currentUrl = req.url;
        videoType = req.type || "HLS";
        sendDebug("CONTENT_URL_CAUGHT", {
            url: currentUrl,
            type: videoType
        });
        startVideoHunt();
    }

    if (req.action === "SPAWN_UI_ON_TOP" && isTopFrame) {
        videoType = req.type || "HLS";
        sendDebug("SPAWN_UI_ON_TOP_ALINDI", {
            url: req.url,
            type: videoType
        });
        toggleMenu(req.url);
    }

    if (req.action === "GET_MEDIA_META") {
        chrome.runtime.sendMessage({ action: "GET_TAB_MEDIA_META" }, (bgMeta) => {
            try {
                const bgSubs = (bgMeta && bgMeta.subtitles) ? bgMeta.subtitles : [];
                const bgAudios = (bgMeta && bgMeta.audios) ? bgMeta.audios : [];
                bgSubs.forEach((s) => { if (s && s.url) addSubtitleFromUrl(s.url, s); });
                bgAudios.forEach((a) => { if (a && a.url) addAudioSource(a); });
            } catch (_e) {}

            const subs = collectSubtitleSources();
            const audios = collectAudioSources();
            sendResponse({ subtitles: subs, audios: audios });
        });
        return true;
    }

    if (req.action === "DOWNLOAD_SUBTITLE") {
        const t = req.track || {};
        addSubtitleFromUrl(t.url, t);
        downloadSubtitleTrack(t);
    }

    if (req.action === "OPEN_VTT_PREVIEW" && isTopFrame) {
        const u = req.url;
        if (u) {
            openBugiPreview({ url: u, mode: "vtt", referer: window.location.href });
        }
        return;
    }

    if (req.action === "OPEN_STREAM_PREVIEW" && isTopFrame) {
        const u = req.url;
        if (u) {
            openBugiPreview({
                url: u,
                mode: req.mode === "mp4" ? "mp4" : req.mode === "vtt" ? "vtt" : "hls",
                referer: window.location.href
            });
        }
        return;
    }

    if (req.action === "DOWNLOAD_AUDIO") {
        const t = req.track || {};
        if (!t.url) return;
        // Popup üzerinden gelen dublaj indirimi: dili sakla (varsa)
        currentDownloadAudioLang = (t.lang || t.label || "").trim();

        const finishWithBody = (raw) => {
            if (!raw) {
                alert(BugiI18n.t("content.audioListFail"));
                return;
            }
            const body = tryDecodeBase64Playlist(raw);
            // Snapshot'a yaz (popup üzerinden gelen dublaj için de tekrar indir çalışsın)
            try {
                reDlSnapshot.analyzedUrl = t.url;
                reDlSnapshot.analyzedBody = body;
                reDlSnapshot.analyzedBw = 192000;
                reDlSnapshot.analyzedIsAudio = true;
                reDlSnapshot.analyzedAudioLang = currentDownloadAudioLang || (t.lang || t.label || "").trim();
                reDlSnapshot.audioBodies = reDlSnapshot.audioBodies || {};
                reDlSnapshot.audioBodies[t.url] = body;
            } catch (_e) {}
            analyzeSegments(body, t.url);
            showRangeUI(t.url);
        };

        // 1) Aynı sekmede inject.js tarafından yakalanmış playlist varsa onu kullan
        if (interceptedPlaylists[t.url] && typeof interceptedPlaylists[t.url] === "string") {
            finishWithBody(interceptedPlaylists[t.url]);
            return true;
        }

        // 2) Yoksa background intercept hafızasına bak
        chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: t.url }, (inter) => {
            if (inter && inter.found && inter.body) {
                finishWithBody(inter.body);
                return;
            }

            // 3) Hâlâ yoksa son çare olarak sunucudan tekrar çekmeyi dene
            chrome.runtime.sendMessage({
                action: "fetchUrl",
                url: t.url,
                referer: window.location.href,
            }, (resp) => {
                if (resp && resp.success) {
                    finishWithBody(resp.data);
                } else {
                    const errMsg = resp && resp.error ? resp.error : BugiI18n.t("content.unknownError");
                    if (shouldSuppressCorsLikeError(errMsg)) return;
                    alert(
                        BugiI18n.t("content.audioListFailDetail") +
                            " " +
                            errMsg
                    );
                }
            });
        });
        return true;
    }
    if (needsLegalAcceptance) return true;

    // Eski önizleme/broadcast denemelerinden kalma: artık kullanılmıyor.
    // (Altyazılar background meta üzerinden senkronize ediliyor.)
    if (req.action === "ADD_SUBTITLE_EXTERNAL") {
        if (req.url) addSubtitleFromUrl(req.url);
        return;
    }
});

// =========================================================================
// 3. VİDEO TESPİT & DİSKE YAZMA YÖNETİCİSİ
// =========================================================================
class DiskStreamManager {
    constructor() {
        this.reset();
    }

    reset() {
        this.fileHandle = null;
        this.writable = null;
        this.nextIndex = 0;
        this.buffer = new Map();
        this.isReady = false;
        this.isWriting = false; 
        this.useFallback = false;
        this.fallbackChunks = [];
        this.suggestedName = "video.ts";
    }

    async init(suggestedName) {
        this.reset();
        this.suggestedName = suggestedName;
        try {
            if (!window.showSaveFilePicker) throw new Error("API bu sitede desteklenmiyor (HTTP engeli olabilir)");
            sendDebug("Diske yazma izni isteniyor", suggestedName);
            this.fileHandle = await window.showSaveFilePicker({ suggestedName });
            this.writable = await this.fileHandle.createWritable();
            this.isReady = true;
            sendDebug("Diske yazma izni BAŞARILI");
            return true;
        } catch (err) {
            sendDebug("Güvenli diske yazma başarısız, Fallback (RAM Modu) devreye giriyor", err.toString());
            this.useFallback = true;
            this.isReady = true;
            return true; // Kullanıcı deneyimini bölmeden RAM üzerinden indirip en son topluca kaydeder
        }
    }

    async writeSegment(index, data) {
        if (!this.isReady) return;

        this.buffer.set(index, data);

        if (this.isWriting) return;
        this.isWriting = true;

        try {
            while (this.buffer.has(this.nextIndex)) {
                const chunk = this.buffer.get(this.nextIndex);
                this.buffer.delete(this.nextIndex);
                this.nextIndex++;
                if (this.useFallback) {
                    this.fallbackChunks.push(chunk);
                } else {
                    await this.writable.write(chunk);
                }
            }
        } finally {
            this.isWriting = false;
        }
    }

    async close() {
        if (this.useFallback && this.fallbackChunks.length > 0) {
            sendDebug("Fallback indirmesi tamamlanıyor, dosya oluşturuluyor...");
            const blob = new Blob(this.fallbackChunks, { type: 'video/mp2t' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this.suggestedName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
        } else if (this.writable) {
            await this.writable.close();
        }
        this.isReady = false;
    }
}

const diskManager = new DiskStreamManager();

function stopVideoHunt() {
    if (videoHuntInterval) {
        clearInterval(videoHuntInterval);
        videoHuntInterval = null;
    }
}

/**
 * Ayarlardaki "Zorla sayfa taraması" açıksa ağır tarama; kapalıysa hafif tarama.
 */
function startVideoHunt() {
    const force = !!forceVideoHuntMode;
    if (document.getElementById("idm-btn-wrapper")) return;
    stopVideoHunt();

    const intervalMs = force ? VIDEO_HUNT_FORCE_INTERVAL_MS : VIDEO_HUNT_LIGHT_INTERVAL_MS;

    videoHuntInterval = setInterval(() => {
        let video = document.querySelector("video");
        if (!video && force) {
            const all = document.querySelectorAll("*");
            for (let el of all) {
                if (el.shadowRoot) {
                    video = el.shadowRoot.querySelector("video");
                    if (video) break;
                }
            }
        }
        if (video) {
            stopVideoHunt();
            if (video.readyState > 0) createDownloadButton(video);
            else {
                video.onloadedmetadata = () => createDownloadButton(video);
                setTimeout(() => createDownloadButton(video), 2000);
            }
        }
    }, intervalMs);
}

async function createDownloadButton(video) {
    await bugiContentI18nReady;
    if (document.getElementById("idm-btn-wrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.id = "idm-btn-wrapper";
    wrapper.className = "idm-btn-group";
    const dlBtn = document.createElement("button");
    dlBtn.className = "idm-main-btn";
    dlBtn.innerText =
        typeof BugiI18n !== "undefined" && BugiI18n.t ? BugiI18n.t("content.downloadMain") : "⬇";

    dlBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isLegalAccepted) {
            alert(BugiI18n.t("content.legalRequired"));
            chrome.runtime.sendMessage({ action: "OPEN_LEGAL_POPUP" }).catch(() => {});
            return;
        }
        dlBtn.innerText = BugiI18n.t("content.downloadFinding");

        chrome.runtime.sendMessage({ action: "getAllUrls" }, async (r) => {
            const videos = r.videos || [];
            sendDebug("OVERLAY_BTN_CLICK", {
                totalFromBackground: videos.length,
                currentUrl,
                videoType
            });

            // Bazı sitelerde master/playlist URL'leri .m3u8 değil (örn: master.txt).
            // Bu durumda background HLS olarak listeye eklemeyebilir.
            // inject.js'in yakaladığı currentUrl'yi HLS aday listesine dahil edelim.
            if (currentUrl && videoType === "HLS" && Array.isArray(videos)) {
                const idx = videos.findIndex(v => v && v.url === currentUrl);
                if (idx >= 0) {
                    if (videos[idx].type !== "HLS") videos[idx].type = "HLS";
                } else {
                    videos.push({ url: currentUrl, type: "HLS" });
                }
            }
            
            if (videos.length === 0) {
                if (currentUrl) videos.push({ url: currentUrl, type: videoType });
                else {
                    alert(BugiI18n.t("content.noVideoSource"));
                    dlBtn.innerText = BugiI18n.t("content.downloadMain");
                    return;
                }
            }

            let bestVideo = videos[videos.length - 1]; 
            let maxQualities = 0;

            const hlsVideos = videos.filter(v => v.type === "HLS");
            
            // 1) Öncelikle intercept edilmiş master/playlist'lere (hem content.js hem background) göre en çok kaliteye sahip olanı bul
            for (let i = hlsVideos.length - 1; i >= 0; i--) {
                const hls = hlsVideos[i];
                let playlistData = null;

                const bodyFromInterceptLocal = interceptedPlaylists[hls.url];
                if (bodyFromInterceptLocal && typeof bodyFromInterceptLocal === "string") {
                    playlistData = tryDecodeBase64Playlist(bodyFromInterceptLocal);
                } else {
                    try {
                        const inter = await concurrentManager.sendMessagePromise({ action: "GET_INTERCEPTED_PLAYLIST", url: hls.url });
                        if (inter && inter.found && inter.body) {
                            playlistData = tryDecodeBase64Playlist(inter.body);
                        }
                    } catch (_e) {}
                }

                if (playlistData && typeof playlistData === "string") {
                    const matches = playlistData.match(/#EXT-X-STREAM-INF/g);
                    const qCount = matches ? matches.length : (playlistData.includes("#EXTINF:") ? 1 : 0);
                    if (qCount > maxQualities) {
                        maxQualities = qCount;
                        bestVideo = hls;
                    }
                }
            }

            // 2) Eğer intercept'e rağmen hâlâ uygun HLS seçilemediyse, eski fallback (background fetch) mantığına düş
            if (!hlsVideos.length || maxQualities === 0) {
                for (let i = hlsVideos.length - 1; i >= 0; i--) {
                    try {
                        const resp = await concurrentManager.sendMessagePromise({ action: "fetchUrl", url: hlsVideos[i].url });
                        if (resp.success && resp.data) {
                            const playlistData = tryDecodeBase64Playlist(resp.data);
                            const matches = playlistData.match(/#EXT-X-STREAM-INF/g);
                            const qCount = matches ? matches.length : (playlistData.includes("#EXTINF:") ? 1 : 0);
                            if (qCount > maxQualities) {
                                maxQualities = qCount;
                                bestVideo = hlsVideos[i];
                            }
                        }
                    } catch(err) {}
                }
            }

            // 3) Hâlâ HLS yoksa, en büyük boyutlu MP4'ü bulmaya çalış
            if ((!hlsVideos.length || maxQualities === 0) && bestVideo.type !== "MP4") {
                const mp4Videos = videos.filter(v => v.type === "MP4");
                let bestMp4 = mp4Videos[mp4Videos.length - 1] || bestVideo;
                let maxSize = 0;

                for (let i = 0; i < mp4Videos.length; i++) {
                    try {
                        const headResp = await concurrentManager.sendMessagePromise({ action: "headUrl", url: mp4Videos[i].url });
                        if (headResp && headResp.success && typeof headResp.contentLength === "number") {
                            if (headResp.contentLength > maxSize) {
                                maxSize = headResp.contentLength;
                                bestMp4 = mp4Videos[i];
                            }
                        }
                    } catch(_e) {}
                }

                bestVideo = bestMp4;
            }

            dlBtn.innerText = BugiI18n.t("content.downloadMain");
            currentUrl = bestVideo.url;
            videoType = bestVideo.type;
            sendDebug("OVERLAY_BEST_VIDEO_SELECTED", {
                url: currentUrl,
                type: videoType,
                maxQualities,
                hlsCount: hlsVideos.length
            });
            chrome.runtime.sendMessage({
                action: "OPEN_MAIN_UI",
                url: currentUrl,
                type: videoType,
            }, (resp) => {
                if (resp && resp.blockedByLegal) {
                    alert(BugiI18n.t("content.legalRequired"));
                    chrome.runtime.sendMessage({ action: "OPEN_LEGAL_POPUP" }).catch(() => {});
                }
            });
        });
    };

    const closeBtn = document.createElement("button");
    closeBtn.className = "idm-close-btn";
    closeBtn.innerText = "✖";
    closeBtn.onclick = (e) => {
        e.preventDefault();
        wrapper.remove();
    };
    wrapper.appendChild(dlBtn);
    wrapper.appendChild(closeBtn);
    document.body.appendChild(wrapper);

    const updatePosition = () => {
        if (!document.body.contains(wrapper)) return;
        if (!video || !video.isConnected) {
            wrapper.remove();
            return;
        }
        const rect = video.getBoundingClientRect();
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        if (rect.width === 0) {
            wrapper.style.display = "none";
            requestAnimationFrame(updatePosition);
            return;
        }
        wrapper.style.display = "flex";
        let targetTop = (rect.top + scrollY) - 35;
        if (rect.top < 35) targetTop = (rect.top + scrollY) + 5;
        wrapper.style.top = targetTop + "px";
        wrapper.style.left = (rect.left + scrollX) + "px";
        requestAnimationFrame(updatePosition);
    };
    requestAnimationFrame(updatePosition);
}

// =========================================================================
// 4. MENÜ VE ANALİZ
// =========================================================================
function toggleMenu(url) {
    if (document.getElementById("idm-progress-panel")) return;
    if (videoType === "MP4") {
        const targetUrl = url || currentUrl;
        const pageUrl = window.location.href;
        const pageTitle = document.title || "";
        const jobId = Date.now().toString() + "_" + Math.random().toString(16).slice(2);
        const job = {
            id: jobId,
            title: pageTitle || targetUrl,
            pageTitle,
            sourceUrl: targetUrl,
            pageUrl,
            isAudio: false,
            isMp4: true,
            audioLang: "",
            createdAt: Date.now(),
            totalDuration: 0,
            segments: []
        };
        chrome.runtime.sendMessage({ action: "REGISTER_DOWNLOAD_JOB", job });
        chrome.runtime.sendMessage({ action: "OPEN_DOWNLOAD_MANAGER" });
        return;
    }

    const targetUrl = url || currentUrl;
    currentMenuSourceUrl = targetUrl || "";
    // Yeni menü açılışında snapshot sıfırla
    reDlSnapshot = {
        v: 1,
        masterUrl: "",
        masterBody: "",
        variantBodies: {},
        audioBodies: {},
        analyzedUrl: "",
        analyzedBody: "",
        analyzedBw: 0,
        analyzedIsAudio: false,
        analyzedAudioLang: ""
    };
    sendDebug("TOGGLE_MENU_START", {
        targetUrl,
        videoType
    });

    if (subtitleRefreshTimer) {
        clearInterval(subtitleRefreshTimer);
        subtitleRefreshTimer = null;
    }
    subtitleRefreshTimer = setInterval(() => {
        refreshOpenSubtitleSections();
    }, 2500);

    const win = createDraggableWindow("idm-menu-window", "Analiz Ediliyor...");
    win.body.innerHTML =
        "<div style='text-align:center; color:#aaa'>" + BugiI18n.t("content.decryptingKeys") + "</div>";
    console.log("[Content] İstek Atılıyor:", targetUrl);

    // 1) Eğer inject.js üzerinden daha önce plaintext/base64 çözülmüş master geldi ise onu kullan
    if (targetUrl && interceptedPlaylists[targetUrl]) {
        sendDebug("MENU_USE_LOCAL_INTERCEPT", targetUrl);
        processPlaylistBody(interceptedPlaylists[targetUrl], targetUrl, win);
        return;
    }

    // 2) Local yoksa, background'daki intercept kaydını dene
    if (targetUrl) {
        chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: targetUrl }, (inter) => {
            if (inter && inter.found && inter.body) {
                sendDebug("MENU_USE_BG_INTERCEPT", {
                    url: targetUrl,
                    length: inter.body.length
                });
                processPlaylistBody(inter.body, targetUrl, win);
                return;
            }

            // 3) Hâlâ bulunamazsa klasik arka plan fetch'ine düş
            sendDebug("MENU_FALLBACK_FETCH", targetUrl);
            chrome.runtime.sendMessage({
                action: "fetchUrl",
                url: targetUrl,
                referer: window.location.href
            }, (resp) => {
                if (!resp || !resp.success) {
                    win.container.remove();
                    const err = resp && resp.error ? resp.error : BugiI18n.t("content.unknownError");
                    console.error("[Content] Fetch Hatası:", err);
                    if (shouldSuppressCorsLikeError(err)) return;
                    alert(BugiI18n.t("content.errorPrefix") + " " + err);
                    return;
                }

                processPlaylistBody(resp.data, targetUrl, win);
            });
        });
    } else {
        sendDebug("MENU_NO_TARGET_URL", "");
        win.container.remove();
    }
}

function openBugiPreview({ url, mode, referer, rangeStartSec, rangeEndSec }) {
    if (!url) return;
    const winTitle = mode === "vtt" ? BugiI18n.t("content.previewWindowTitleVtt") : BugiI18n.t("content.previewWindowTitleGeneric");
    const win = createDraggableWindow("idm-preview-window", winTitle, null, null);
    win.container.style.width = "min(680px, 96vw)";
    win.container.style.maxWidth = "96vw";
    win.body.style.minHeight = "440px";
    win.body.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", BugiI18n.t("content.previewIframeTitle"));
    iframe.src = chrome.runtime.getURL("preview.html");
    iframe.style.cssText = "width:100%;height:440px;border:0;border-radius:6px;background:#000;";
    iframe.setAttribute("allow", "autoplay; fullscreen");
    win.body.appendChild(iframe);
    iframe.onload = () => {
        try {
            const previewMode =
                mode === "mp4" ? "mp4" : mode === "vtt" ? "vtt" : "hls";
            const startSec = Number.isFinite(rangeStartSec) ? Math.max(0, rangeStartSec) : null;
            const endSec = Number.isFinite(rangeEndSec) ? Math.max(0, rangeEndSec) : null;
            iframe.contentWindow.postMessage(
                {
                    type: "BUGI_PREVIEW_INIT",
                    url,
                    referer: referer || window.location.href,
                    mode: previewMode,
                    rangeStartSec: startSec,
                    rangeEndSec: endSec
                },
                "*"
            );
        } catch (_e) {}
    };
}

function processPlaylistBody(rawBody, playlistUrl, win) {
    let body = tryDecodeBase64Playlist(rawBody);

    const bodySafe = (body || "").toString();
    const upper = bodySafe.toUpperCase();
    const isM3U8 = upper.includes("#EXTM3U") || upper.includes("#EXT-X-STREAM") || upper.includes("#EXTINF:");

    if (isM3U8) {
        // case-insensitive master tespiti (bazı siteler etiketleri farklı case'te döndürebilir)
        if (upper.includes("#EXT-X-STREAM-INF")) {
            // Master'ı snapshot'a yaz
            reDlSnapshot.masterUrl = playlistUrl;
            reDlSnapshot.masterBody = bodySafe;
            win.container.querySelector(".idm-window-title").innerText = BugiI18n.t("content.qualityTitle");
            win.body.innerHTML = "";

            const qualityContainer = document.createElement("div");
            qualityContainer.id = "idm-quality-container";
            win.body.appendChild(qualityContainer);

            parseMasterAndShowMenu(body, playlistUrl, qualityContainer);

            // Kaliteler ve dublajlar render edildikten sonra altyazıları en alta ekle
            syncSubtitlesFromBackgroundAndRender(win.body);

            // İçerik boyutuna göre pencereyi dikeyde ayarla
            try {
                const el = win.container;
                const rect = el.getBoundingClientRect();
                const vw = window.innerWidth || document.documentElement.clientWidth || 0;
                const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                const left = Math.max(20, (vw - rect.width) / 2);
                const top = rect.height > vh - 40 ? 20 : Math.max(20, (vh - rect.height) / 2);
                el.style.left = left + "px";
                el.style.top = top + "px";
                el.style.transform = "none";
            } catch (_e) {}
        } else {
            win.container.querySelector(".idm-window-title").innerText = BugiI18n.t("content.confirmTitle");
            win.body.innerHTML = "";

            // Altyazıları arka plandaki meta + yerel kaynaklardan senkronize et
            syncSubtitlesFromBackgroundAndRender(win.body);

            const infoDiv = document.createElement("div");
            infoDiv.style.textAlign = "center";
            infoDiv.style.padding = "10px";
            infoDiv.innerText = BugiI18n.t("content.singleQualityInfo");
            win.body.appendChild(infoDiv);

            const startRow = document.createElement("div");
            startRow.className = "idm-btn-row idm-btn-row--gap6 idm-btn-row--mt6 idm-btn-row--mb0";

            const btnForce = document.createElement("button");
            btnForce.id = "btn-force";
            btnForce.type = "button";
            btnForce.className = "idm-action-btn";
            btnForce.style.flex = "1";
            btnForce.style.minWidth = "0";
            btnForce.textContent = BugiI18n.t("content.startDownload");

            const eyeSingle = document.createElement("button");
            eyeSingle.type = "button";
            eyeSingle.className = "idm-action-btn idm-preview-eye idm-preview-eye--action";
            eyeSingle.innerHTML = BUGI_PREVIEW_EYE_SVG;
            eyeSingle.title = BugiI18n.t("content.playlistPreviewTitle");
            eyeSingle.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBugiPreview({ url: playlistUrl, mode: "hls", referer: window.location.href });
            };
            startRow.appendChild(btnForce);
            startRow.appendChild(eyeSingle);
            win.body.appendChild(startRow);

            btnForce.onclick = () => {
                selectedQualityBandwidth = 2000000;
                // Tek kalite / playlist: snapshot'a yaz
                reDlSnapshot.analyzedUrl = playlistUrl;
                reDlSnapshot.analyzedBody = bodySafe;
                reDlSnapshot.analyzedBw = 2000000;
                reDlSnapshot.analyzedIsAudio = false;
                reDlSnapshot.analyzedAudioLang = "";
                analyzeSegments(bodySafe, playlistUrl);
                win.container.remove();
                showRangeUI(playlistUrl);
            };
        }
    } else {
        try {
            sendDebug("M3U8 TANINAMADI", {
                url: playlistUrl,
                rawLength: (rawBody && rawBody.length) || 0,
                decodedLength: bodySafe.length,
                head: bodySafe.slice(0, 300)
            });
        } catch (_e) {}

        win.container.querySelector(".idm-window-title").innerText = BugiI18n.t("content.listParseFailTitle");

        const snippet = bodySafe || (rawBody || "");
        const shortSnippet = snippet.slice(0, 800);
        const escaped = shortSnippet
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        win.body.innerHTML = `
            <div style="font-size:12px; color:#ccc; margin-bottom:8px;">
                ${BugiI18n.t("content.listUnreadableIntro")}<br>
                ${BugiI18n.t("content.listUnreadableHint")}
            </div>
            <div style="font-size:11px; color:#999; margin-bottom:4px; word-break:break-all;">
                ${BugiI18n.t("content.urlLabel")} <span style="color:#fff;">${playlistUrl}</span>
            </div>
            <pre id="idm-playlist-dump" style="background:#111; padding:8px; border-radius:4px; max-height:220px; overflow:auto; font-size:11px; white-space:pre-wrap; border:1px solid #333;">${escaped}</pre>
            <button id="idm-copy-playlist" class="idm-action-btn" style="margin-top:10px;">${BugiI18n.t("content.copyClipboard")}</button>
        `;

        const copyBtn = win.body.querySelector("#idm-copy-playlist");
        if (copyBtn && navigator.clipboard && navigator.clipboard.writeText) {
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(snippet).then(() => {
                    copyBtn.innerText = BugiI18n.t("content.copied");
                    setTimeout(() => {
                        copyBtn.innerText = BugiI18n.t("content.copyClipboard");
                    }, 1500);
                }).catch(() => {
                    alert(BugiI18n.t("content.clipDenied"));
                });
            };
        } else if (copyBtn) {
            copyBtn.onclick = () => {
                alert(BugiI18n.t("content.clipBlocked"));
            };
        }
    }
}

function syncSubtitlesFromBackgroundAndRender(container) {
    chrome.runtime.sendMessage({ action: "GET_TAB_MEDIA_META" }, (bgMeta) => {
        try {
            const bgSubs = (bgMeta && bgMeta.subtitles) ? bgMeta.subtitles : [];
            bgSubs.forEach((s) => {
                if (s && s.url) addSubtitleFromUrl(s.url, s);
            });
        } catch (_e) {}

        const subs = collectSubtitleSources();
        if (subs.length) {
            renderSubtitleSection(container, subs);
        }
    });
}

function parseMasterAndShowMenu(text, baseUrl, container) {
    const lines = text.split("\n");
    const qualities = new Map();
    const audioTracks = [];
    const subtitleTracks = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith("#EXT-X-MEDIA")) {
            const typeMatch = line.match(/TYPE=([^,]+)/);
            const type = typeMatch ? typeMatch[1].replace(/"/g, "") : "";

            const nameMatch = line.match(/NAME="([^"]+)"/);
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = line.match(/URI="([^"]+)"/);
            const groupMatch = line.match(/GROUP-ID="([^"]+)"/);
            const uri = uriMatch ? uriMatch[1] : "";

            if (uri) {
                let fullUrl = uri;
                if (!uri.startsWith("http")) {
                    try {
                        fullUrl = new URL(uri, baseUrl).href;
                    } catch (e) {}
                }

                if (type === "AUDIO") {
                    const meta = {
                        url: fullUrl,
                        name: nameMatch ? nameMatch[1] : "",
                        lang: langMatch ? langMatch[1] : "",
                        groupId: groupMatch ? groupMatch[1] : "",
                    };
                    audioTracks.push(meta);
                    addAudioSource(meta);
                } else if (type === "SUBTITLES") {
                    const label = nameMatch ? nameMatch[1] : (langMatch ? langMatch[1] : "Subtitle");
                    const lang = langMatch ? langMatch[1].toLowerCase() : "";
                    const meta = { url: fullUrl, label, lang };
                    subtitleTracks.push(meta);
                    addSubtitleFromUrl(fullUrl, meta);
                }
            }
            continue;
        }

        if (!line.startsWith("#") && (line.includes(".vtt") || line.includes(".srt"))) {
            try {
                const fullUrl = new URL(line, baseUrl).href;
                addSubtitleFromUrl(fullUrl);
            } catch (e) {}
        }

        if (line.includes("#EXT-X-STREAM-INF")) {
            const bwPeak = (line.match(/BANDWIDTH=(\d+)/) || [0, 0])[1];
            const bwAvg = (line.match(/AVERAGE-BANDWIDTH=(\d+)/) || [0, 0])[1];
            const res = (line.match(/RESOLUTION=(\d+x\d+)/) || [0, "Standart"])[1];
            const urlLine = lines[i + 1] ? lines[i + 1].trim() : "";
            if (urlLine && !urlLine.startsWith("#")) {
                let fullUrl = urlLine;
                if (!urlLine.startsWith("http")) {
                    try {
                        fullUrl = new URL(urlLine, baseUrl).href;
                    } catch (e) {}
                }
                if (!qualities.has(fullUrl)) {
                    qualities.set(fullUrl, {
                        res,
                        bw: parseInt(bwPeak, 10) || 0,
                        avgBw: parseInt(bwAvg, 10) || 0,
                        audioMode: contentInferAudioModeFromStreamInf(line),
                        url: fullUrl,
                    });
                }
            }
        }
    }

    const sorted = Array.from(qualities.values()).sort((a, b) => b.bw - a.bw);
    if (sorted.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:10px;">${BugiI18n.t("content.listParseFail")}</div><button id="btn-force-direct" class="idm-action-btn">${BugiI18n.t("content.directDownload")}</button>`;
        container.querySelector("#btn-force-direct").onclick = () => {
            // Video için: dublaj dili eklenmesin
            currentDownloadAudioLang = "";
            selectedQualityBandwidth = 2000000;
            analyzeSegments(text, baseUrl);
            document.getElementById("idm-menu-window").remove();
            showRangeUI(baseUrl);
        };
        return;
    }

    // YENİ: Kaliteler aralığı eklendi
    const qTitle = document.createElement("div");
    qTitle.style.fontSize = "11px";
    qTitle.style.color = "#aaa";
    qTitle.style.marginBottom = "6px";
    qTitle.style.marginTop = "10px";
    qTitle.innerText = BugiI18n.t("content.qualitiesTitle");
    container.appendChild(qTitle);

    sorted.forEach((q) => {
        const row = document.createElement("div");
        row.className = "idm-btn-row idm-btn-row--mb4";

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
        let approxStr = BugiI18n.t("content.sizeCalculating");
        sizeSpan.textContent = approxStr;

        rightWrap.appendChild(sizeSpan);
        btn.appendChild(leftSpan);
        btn.appendChild(rightWrap);

        const eyeBtn = document.createElement("button");
        eyeBtn.type = "button";
        eyeBtn.className = "idm-list-btn idm-preview-eye";
        eyeBtn.title = BugiI18n.t("content.previewQualityHls");
        eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
        eyeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openBugiPreview({ url: q.url, mode: "hls", referer: window.location.href });
        };

        row.appendChild(btn);
        row.appendChild(eyeBtn);

        const renderLeft = () => {
            leftSpan.innerHTML = `<b>${q.res}</b>${contentAudioIconHtml(q.audioMode)}`;
        };
        renderLeft();

        const computeApprox = (raw) => {
            if (!raw) return;
            const body = tryDecodeBase64Playlist(raw);
            // Snapshot'a kaydet (varsa)
            try { reDlSnapshot.variantBodies[q.url] = body; } catch (_e) {}
            (async () => {
                const probed = await contentProbeVariantAudioMode(q.url, body, window.location.href);
                if (probed === "muxed" || probed === "none") {
                    q.audioMode = probed;
                    renderLeft();
                }
                const headApprox = await contentEstimateSizeByHeadSampling(body, q.url);
                if (headApprox) {
                    renderLeft();
                    sizeSpan.textContent = `~${headApprox}`;
                    return;
                }
                const estimateBw = q.avgBw || q.bw || selectedQualityBandwidth || 2000000;
                const approx = estimateSizeFromPlaylist(body, estimateBw);
                if (!approx) return;
                renderLeft();
                sizeSpan.textContent = `~${approx}`;
            })().catch(() => {});
        };

        btn.onclick = () => {
            // Video için: dublaj dili eklenmesin
            currentDownloadAudioLang = "";
            selectedQualityBandwidth = q.bw;
            container.innerHTML =
                "<div style='text-align:center;'>" + BugiI18n.t("media.calculatingBlock") + "</div>";

            const finishWithBody = (raw) => {
                if (!raw) {
                    alert(BugiI18n.t("content.listFetchFail"));
                    container.innerHTML =
                        "<div style='text-align:center;'>" + BugiI18n.t("media.errorOccurred") + "</div>";
                    return;
                }
                const body = tryDecodeBase64Playlist(raw);
                // Seçilen kalite playlist'ini snapshot'a yaz
                reDlSnapshot.analyzedUrl = q.url;
                reDlSnapshot.analyzedBody = body;
                reDlSnapshot.analyzedBw = q.bw || 0;
                reDlSnapshot.analyzedIsAudio = false;
                reDlSnapshot.analyzedAudioLang = "";
                try { reDlSnapshot.variantBodies[q.url] = body; } catch (_e) {}
                analyzeSegments(body, q.url);
                document.getElementById("idm-menu-window").remove();
                showRangeUI(baseUrl);
            };

            // 1) Aynı sekmede yakalanmış kalite playlist'i var mı?
            if (interceptedPlaylists[q.url] && typeof interceptedPlaylists[q.url] === "string") {
                finishWithBody(interceptedPlaylists[q.url]);
                return;
            }

            // 2) Background intercept hafızasına sor
            chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: q.url }, (inter) => {
                if (inter && inter.found && inter.body) {
                    finishWithBody(inter.body);
                    return;
                }

                // 3) Son çare: sunucudan tekrar çek
                chrome.runtime.sendMessage({
                    action: "fetchUrl",
                    url: q.url,
                    referer: window.location.href,
                }, (resp) => {
                    if (resp && resp.success) {
                        finishWithBody(resp.data);
                    } else {
                        const errMsg = (resp && resp.error ? resp.error : BugiI18n.t("content.listFetchErrorDetail"));
                        if (shouldSuppressCorsLikeError(errMsg)) {
                            container.innerHTML =
                                "<div style='text-align:center;'>" + BugiI18n.t("media.errorOccurred") + "</div>";
                            return;
                        }
                        alert(
                            BugiI18n.t("content.errorPrefix") +
                                " " +
                                errMsg
                        );
                        container.innerHTML =
                            "<div style='text-align:center;'>" + BugiI18n.t("media.errorOccurred") + "</div>";
                    }
                });
            });
        };

        container.appendChild(row);

        // Tahmini boyutu hesaplamak için de önce intercept'e bak, yoksa fetch'e düş
        if (interceptedPlaylists[q.url] && typeof interceptedPlaylists[q.url] === "string") {
            computeApprox(interceptedPlaylists[q.url]);
        } else {
            chrome.runtime.sendMessage({
                action: "GET_INTERCEPTED_PLAYLIST",
                url: q.url,
            }, (inter) => {
                if (inter && inter.found && inter.body) {
                    computeApprox(inter.body);
                    return;
                }
                chrome.runtime.sendMessage({
                    action: "fetchUrl",
                    url: q.url,
                    referer: window.location.href,
                }, (resp) => {
                    if (!resp || !resp.success || !resp.data) return;
                    computeApprox(resp.data);
                });
            });
        }
    });

    // Eğer bu playlist içinde doğrudan ses parçası tanımı yoksa,
    // yine de sekmedeki global ses listesine (detectedAudios) bakıp gösterebiliriz.
    let audioList = audioTracks;
    if (!audioList.length) {
        audioList = collectAudioSources();
    }

    if (audioList.length) {
        const audioSection = document.createElement("div");
        audioSection.style.marginTop = "15px";

        const title = document.createElement("div");
        title.style.fontSize = "11px";
        title.style.color = "#aaa";
        title.style.marginBottom = "6px";
        title.innerText = BugiI18n.t("content.audioPartsTitle");
        audioSection.appendChild(title);

        audioList.forEach((a, idx) => {
            const row = document.createElement("div");
            row.className = "idm-btn-row idm-btn-row--mb4";

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

            let linkHint = "";
            try {
                const u = new URL(a.url);
                const last = u.pathname.split("/").filter(Boolean).pop() || "";
                if (last) linkHint = last;
            } catch (e) {}

            let label = labelParts.length ? labelParts.join(" / ") : BugiI18n.tf("content.audioTrackN", { n: idx + 1 });
            // YENİ: Sadece isDevMode aktifse göster
            if (linkHint && label.indexOf(linkHint) === -1 && isDevMode) {
                label += ` [${linkHint}]`;
            }

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
            hintSpan.textContent = BugiI18n.t("content.audioOnlyBadge");
            rightWrap.appendChild(hintSpan);
            btn.appendChild(leftSpan);
            btn.appendChild(rightWrap);

            const eyeBtn = document.createElement("button");
            eyeBtn.type = "button";
            eyeBtn.className = "idm-list-btn idm-preview-eye";
            eyeBtn.title = BugiI18n.t("media.previewTitleAudio");
            eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
            eyeBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBugiPreview({ url: a.url, mode: "hls", referer: window.location.href });
            };
            row.appendChild(btn);
            row.appendChild(eyeBtn);

            btn.onclick = () => {
                // Dublaj indirimi: dosya adına eklenecek dili burada sakla
                currentDownloadAudioLang = (a.lang || a.name || "").trim();
                selectedQualityBandwidth = 192000;
                container.innerHTML =
                    "<div style='text-align:center;'>" + BugiI18n.t("content.audioPreparing") + "</div>";
                chrome.runtime.sendMessage({
                    action: "fetchUrl",
                    url: a.url,
                    referer: window.location.href,
                }, (resp) => {
                    if (resp.success) {
                        const body = tryDecodeBase64Playlist(resp.data);
                        // Seçilen ses playlist'ini snapshot'a yaz
                        reDlSnapshot.analyzedUrl = a.url;
                        reDlSnapshot.analyzedBody = body;
                        reDlSnapshot.analyzedBw = 192000;
                        reDlSnapshot.analyzedIsAudio = true;
                        reDlSnapshot.analyzedAudioLang = currentDownloadAudioLang;
                        try { reDlSnapshot.audioBodies[a.url] = body; } catch (_e) {}
                        analyzeSegments(body, a.url);
                        document.getElementById("idm-menu-window").remove();
                        showRangeUI(a.url);
                    } else {
                        const errMsg = resp && resp.error ? resp.error : BugiI18n.t("content.unknownError");
                        if (shouldSuppressCorsLikeError(errMsg)) return;
                        alert(BugiI18n.t("content.errorPrefix") + " " + errMsg);
                    }
                });
            };

            audioSection.appendChild(row);
        });

        container.appendChild(audioSection);
    }
}

function analyzeSegments(text, baseUrl) {
    const lines = text.split(/\r?\n/); 
    parsedSegmentsData = [];
    let t = 0;
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        if (line.startsWith("#EXTINF:")) {
            const durPart = line.split(":")[1];
            const dur = parseFloat(durPart ? durPart.replace(",", "") : 0);
            let url = lines[i + 1] ? lines[i + 1].trim() : "";
            
            if (url && !url.startsWith("#")) {
                try {
                     let fullUrl = new URL(url, baseUrl).href;
                     parsedSegmentsData.push({
                         url: fullUrl,
                         startTime: t,
                         endTime: t + dur,
                         duration: dur,
                         index: count++,
                     });
                     t += dur;
                } catch(e) {
                     console.error("URL Hatası:", url);
                }
            }
        }
    }
}

function estimateSizeFromPlaylist(text, bandwidth) {
    const lines = text.split(/\r?\n/);
    let totalDur = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXTINF:")) {
            const durPart = line.split(":")[1];
            const dur = parseFloat(durPart ? durPart.replace(",", "") : 0);
            if (!isNaN(dur) && dur > 0) totalDur += dur;
        }
    }
    if (!totalDur) return null;
    const bw = bandwidth || selectedQualityBandwidth || 2000000;
    const bytes = ((bw / 8) * totalDur) * SAFETY_FACTOR;
    return formatBytes(bytes);
}

function looksLikeTextOrHtml(bytes) {
    if (!bytes || bytes.length === 0) return true;
    const len = Math.min(bytes.length, 512);
    let asciiCount = 0;
    let zeroCount = 0;
    let str = "";
    for (let i = 0; i < len; i++) {
        const b = bytes[i];
        if (b === 0) zeroCount++;
        if (b >= 9 && b <= 126) asciiCount++;
        str += String.fromCharCode(b);
    }
    const asciiRatio = asciiCount / len;
    if (zeroCount > 0 && asciiRatio < 0.6) return false;
    const lower = str.toLowerCase();
    if (lower.includes("<html") || lower.includes("<!doctype") || lower.includes("security error") || lower.includes("cloudflare")) {
        return true;
    }
    return asciiRatio > 0.85;
}

function bytesToAsciiString(bytes, maxLen) {
    if (!bytes || !bytes.length) return "";
    const len = Math.min(bytes.length, maxLen || bytes.length);
    let str = "";
    for (let i = 0; i < len; i++) {
        str += String.fromCharCode(bytes[i]);
    }
    return str;
}

function decodeBase64ToBytesIfValid(str) {
    if (!str || typeof str !== "string") return null;
    const cleaned = str.replace(/\s+/g, "");
    if (!cleaned || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
    if (cleaned.length < 32) return null;
    try {
        const bin = atob(cleaned);
        if (!bin || bin.length < 16) return null;
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
    } catch (e) {
        return null;
    }
}

function maybeDecodeBase64Segment(bytes) {
    if (!bytes || !bytes.length) return bytes;

    if (segmentsBase64Wrapped) {
        const asText = bytesToAsciiString(bytes);
        const decoded = decodeBase64ToBytesIfValid(asText);
        return decoded || bytes;
    }

    if (!segmentEncodingChecked) {
        if (looksLikeTextOrHtml(bytes)) {
            const asText = bytesToAsciiString(bytes);
            const decoded = decodeBase64ToBytesIfValid(asText);
            if (decoded && !looksLikeTextOrHtml(decoded)) {
                segmentsBase64Wrapped = true;
                segmentEncodingChecked = true;
                return decoded;
            }
        }
        segmentEncodingChecked = true;
    }

    return bytes;
}

function tryDecodeBase64Playlist(data) {
    if (typeof data !== "string") return data;
    const upperOrig = data.toUpperCase();
    if (upperOrig.includes("#EXTM3U") || upperOrig.includes("#EXT-X-STREAM-INF") || upperOrig.includes("#EXTINF:")) return data;

    // 1) Tüm gövdeyi base64 olarak dene
    let cleaned = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (cleaned && !/[^A-Za-z0-9+/=]/.test(cleaned)) {
        try {
            const decoded = atob(cleaned);
            const upperDec = decoded.toUpperCase();
            if (upperDec.includes("#EXTM3U") || upperDec.includes("#EXTINF:") || upperDec.includes("#EXT-X-STREAM-INF")) {
                return decoded;
            }
        } catch (e) {}
    }

    // 2) Olmadıysa, gövdenin içinde gömülü base64 blokları ara
    const candidates = data.match(/[A-Za-z0-9+/=]{40,}/g);
    if (candidates) {
        for (let token of candidates) {
            let tokenClean = token.replace(/-/g, "+").replace(/_/g, "/");
            if (!tokenClean || /[^A-Za-z0-9+/=]/.test(tokenClean)) continue;
            try {
                const decoded = atob(tokenClean);
                const upperDec2 = decoded.toUpperCase();
                if (upperDec2.includes("#EXTM3U") || upperDec2.includes("#EXTINF:") || upperDec2.includes("#EXT-X-STREAM-INF")) {
                    return decoded;
                }
            } catch (e) {}
        }
    }

    return data;
}

function showRangeUI(sourceUrl) {
    const win = createDraggableWindow(
        "idm-range-window",
        BugiI18n.t("content.rangeWindowTitle"),
        null,
        () => {
            win.container.remove();
            const target = sourceUrl || currentMenuSourceUrl || currentUrl;
            if (target) toggleMenu(target);
        }
    );
    const totalDur = parsedSegmentsData[parsedSegmentsData.length - 1]?.endTime || 0;
    win.body.innerHTML = "";

    const rangeContainer = document.createElement("div");
    rangeContainer.innerHTML = `<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;"><div id="grp-start"></div> <div id="grp-end"></div></div><div id="range-info" style="background:#333; padding:10px; border-radius:4px; font-size:12px; text-align:center; color:#ccc; margin-bottom:10px;"><div>${BugiI18n.t("content.videoTotalLabel")} <b style="color:#4fc3f7">${formatTime(totalDur)}</b></div><div id="selected-range" style="margin-top:5px;">${BugiI18n.t("content.rangeSelectedCalculating")}</div></div><div class="idm-btn-row idm-btn-row--gap6 idm-btn-row--mb0" style="margin-top:5px;"><button type="button" id="btn-start-dl" class="idm-action-btn" style="flex:1;">${BugiI18n.t("content.startDownload")}</button><button type="button" id="btn-range-preview-eye" class="idm-action-btn idm-preview-eye idm-preview-eye--action" title="${BugiI18n.t("content.previewRangeTitle")}">${BUGI_PREVIEW_EYE_SVG}</button></div>`;
    win.body.appendChild(rangeContainer);

    const rangeEye = rangeContainer.querySelector("#btn-range-preview-eye");
    if (rangeEye) {
        rangeEye.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const u = sourceUrl || currentMenuSourceUrl || currentUrl;
            if (!u) return;
            const isMp4 = videoType === "MP4" || /\.mp4(\?|$)/i.test(u);
            const s = hmsToSeconds(startInp.input.value);
            const en = hmsToSeconds(endInp.input.value);
            if (!Number.isFinite(s) || !Number.isFinite(en) || s >= en) {
                alert(BugiI18n.t("content.rangeInvalidPreview"));
                return;
            }
            openBugiPreview({
                url: u,
                mode: isMp4 ? "mp4" : "hls",
                referer: window.location.href,
                rangeStartSec: s,
                rangeEndSec: en
            });
        };
    }
    const startInp = createTimeInputGroup(BugiI18n.t("content.rangeStartLabel"), "00:00:00", () => validate(startInp, "start"));
    const endInp = createTimeInputGroup(BugiI18n.t("content.rangeEndLabel"), formatTime(totalDur), () => validate(endInp, "end"));
    rangeContainer.querySelector("#grp-start").appendChild(startInp.container);
    rangeContainer.querySelector("#grp-end").appendChild(endInp.container);
    
    const validate = (inpObj, type) => {
        let val = inpObj.input.value;
        let sec = hmsToSeconds(val);
        if (isNaN(sec) || sec < 0) sec = 0;
        if (sec > totalDur) {
            sec = totalDur;
            inpObj.input.value = formatTime(sec);
        }
        let snapped = sec;
        for (let seg of parsedSegmentsData) {
            if (sec >= seg.startTime && sec <= seg.endTime) {
                snapped = type === "start" ? seg.startTime : seg.endTime;
                break;
            }
        }
        if (type === "end" && sec >= totalDur) snapped = totalDur;
        inpObj.input.value = formatTime(snapped);
        updateInfo();
    };
    
    const updateInfo = () => {
        const s = hmsToSeconds(startInp.input.value);
        const e = hmsToSeconds(endInp.input.value);
        if (s >= e) {
            rangeContainer.querySelector("#selected-range").innerHTML =
                `<span style="color:#e74c3c">${BugiI18n.t("content.rangeInvalidOrder")}</span>`;
            return;
        }
        if (e > totalDur) endInp.input.value = formatTime(totalDur);
        let diff = e - s;
        let mb = (((selectedQualityBandwidth || 2000000) * diff) / 8388608) * SAFETY_FACTOR;
        rangeContainer.querySelector("#selected-range").innerHTML = BugiI18n.tf("content.rangeEstLineHtml", {
            dur: formatTime(diff),
            mb: mb.toFixed(2)
        });
    };
    
    rangeContainer.querySelector("#btn-start-dl").onclick = () => {
        const s = hmsToSeconds(startInp.input.value);
        const e = hmsToSeconds(endInp.input.value);
        if (s >= e) return alert(BugiI18n.t("content.rangeInvalid"));

        const segs = parsedSegmentsData.filter((seg) =>
            seg.startTime < e && seg.endTime > s
        );
        if (!segs.length) {
            alert(BugiI18n.t("content.noSegments"));
            return;
        }

        const jobId = Date.now().toString() + "_" + Math.random().toString(16).slice(2);
        const baseTitle = getSanitizedTitle();
        const isAudio = !!currentDownloadAudioLang;
        const lang = currentDownloadAudioLang || "";
        const totalDur = e - s;

        const job = {
            id: jobId,
            title: baseTitle,
            sourceUrl: sourceUrl || currentMenuSourceUrl || currentUrl,
            pageUrl: window.location.href,
            isAudio: isAudio,
            audioLang: lang,
            createdAt: Date.now(),
            totalDuration: totalDur,
            segments: segs.map((seg, idx) => ({
                url: seg.url,
                index: typeof seg.index === "number" ? seg.index : idx,
                duration: seg.duration
            })),
            // Tekrar indir için gizli snapshot (background içine captured.snapshot olarak taşınacak)
            snapshot: (() => {
                try {
                    // Deep clone ile dondur
                    return JSON.parse(JSON.stringify(reDlSnapshot));
                } catch (_e) {
                    return null;
                }
            })(),
            // O an ekranda görünen altyazı ve dublaj listesini de kalıcıya taşı
            media: (() => {
                try {
                    const subs = collectSubtitleSources();
                    const audios = collectAudioSources();
                    return {
                        subtitles: subs,
                        audios: audios
                    };
                } catch (_e) {
                    return undefined;
                }
            })()
        };

        chrome.runtime.sendMessage({ action: "REGISTER_DOWNLOAD_JOB", job });
        chrome.runtime.sendMessage({ action: "OPEN_DOWNLOAD_MANAGER" });

        // Ses indirmesi için kullanılan dil bayrağını bir sonraki indirme için sıfırla
        currentDownloadAudioLang = "";
        win.container.remove();
    };
    setTimeout(updateInfo, 50);

    // İçerik boyutuna göre pencereyi dikeyde daha yukarı konumlandır
    try {
        const winEl = win.container;
        const rect = winEl.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const left = Math.max(20, (vw - rect.width) / 2);
        let top;
        if (rect.height > vh * 0.7) {
            top = 20;
        } else {
            top = Math.max(20, (vh - rect.height) / 2);
        }
        winEl.style.left = left + "px";
        winEl.style.top = top + "px";
        winEl.style.transform = "none";
    } catch (_e) {}
}

function createTimeInputGroup(label, defaultValue, onBlurCallback) {
    const container = document.createElement("div");
    container.innerHTML = `<label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">${label}</label>`;
    const wrapper = document.createElement("div");
    wrapper.className = "idm-time-wrapper";
    const parts = defaultValue.split(":");
    const inpH = createPartInput(parts[0], 23);
    const inpM = createPartInput(parts[1], 59);
    const inpS = createPartInput(parts[2], 59);
    wrapper.append(inpH, createColon(), inpM, createColon(), inpS);
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
    Object.defineProperty(container, "value", {
        get: () => `${inpH.value}:${inpM.value}:${inpS.value}`,
        set: (v) => {
            const p = v.split(":");
            if (p.length === 3) {
                inpH.value = p[0];
                inpM.value = p[1];
                inpS.value = p[2];
            }
        },
    });
    return { container: container, input: container };
}

function createPartInput(v, max) {
    const i = document.createElement("input");
    i.className = "idm-time-input";
    i.value = v;
    i.maxLength = 2;
    i.setAttribute("max", max);
    return i;
}

function createColon() {
    const s = document.createElement("span");
    s.innerText = ":";
    s.className = "idm-time-colon";
    return s;
}

function createDraggableWindow(id, titleText, onClose, onBack) {
    const old = document.getElementById(id);
    if (old) old.remove();
    const win = document.createElement("div");
    win.id = id;
    win.className = "idm-window";
    win.style.position = "fixed";
    if (lastWinTop === null) {
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const w = 320;
        const left = Math.max(20, (vw - w) / 2);
        const top = Math.max(20, (vh - 260) / 2);
        win.style.left = left + "px";
        win.style.top = top + "px";
        win.style.transform = "none";
    } else {
        win.style.top = lastWinTop;
        win.style.left = lastWinLeft;
        win.style.transform = "none";
    }
    win.innerHTML = `<div class="idm-window-header"><span class="idm-window-title">${titleText}</span><div class="idm-window-controls"></div></div><div class="idm-window-body"></div>`;
    document.body.appendChild(win);
    const controls = win.querySelector(".idm-window-controls");

    if (onBack) {
        const backBtn = document.createElement("button");
        backBtn.className = "idm-win-btn idm-win-back";
        backBtn.innerText = "←";
        backBtn.onclick = (e) => {
            e.stopPropagation();
            onBack();
        };
        controls.appendChild(backBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "idm-win-btn idm-win-close";
    closeBtn.innerText = "✖";
    closeBtn.onclick = () => {
        win.remove();
        if (onClose) onClose();
        if (id === "idm-progress-panel") {
            isCancelled = true;
            concurrentManager.clear();
        }
    };
    controls.appendChild(closeBtn);
    const header = win.querySelector(".idm-window-header");
    let isDragging = false, shiftX, shiftY;
    header.onmousedown = (e) => {
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
            lastWinLeft = win.style.left;
            lastWinTop = win.style.top;
        };
        document.onmouseup = () => {
            isDragging = false;
            document.onmousemove = null;
        };
    };
    return {
        container: win,
        body: win.querySelector(".idm-window-body"),
        controls: win.querySelector(".idm-window-controls"),
    };
}

const concurrentManager = {
    active: new Map(),
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    async downloadSegment(url, index, onSuccess, onError) {
        this.active.set(url, { url, index, startTime: Date.now() });

        // Tüm segment indirmelerini arka planda yap (DNR ile sahte Referer/Origin zaten ayarlanıyor)
        sendDebug(`Segment indiriliyor [${index}]`, {
            url,
            index,
            via: "BACKGROUND_FETCH"
        });

        chrome.runtime.sendMessage(
            {
                action: "fetchUrl",
                url,
                isBinary: true,
                referer: window.location.href
            },
            (resp) => {
                try {
                    if (!resp || !resp.success) {
                        const errMsg = (resp && resp.error) ? resp.error : "Arka plan isteği başarısız";
                        sendDebug(`Segment [${index}] HATASI`, errMsg);
                        onError(url, index, errMsg);
                        return;
                    }

                    try {
                        const binaryStr = atob(resp.data);
                        const len = binaryStr.length;
                        const bytes = new Uint8Array(len);
                        for (let i = 0; i < len; i++) {
                            bytes[i] = binaryStr.charCodeAt(i);
                        }
                        const finalBytes = maybeDecodeBase64Segment(bytes);

                        sendDebug(`Segment [${index}] BAŞARILI`, `Boyut: ${finalBytes.length} byte`);
                        onSuccess(index, finalBytes);
                    } catch (decodeErr) {
                        const msg = decodeErr.toString();
                        sendDebug(`Segment [${index}] DECODE HATASI`, msg);
                        onError(url, index, msg);
                    }
                } finally {
                    concurrentManager.active.delete(url);
                }
            }
        );
    },
    sendMessagePromise(message) {
        return new Promise((resolve) =>
            chrome.runtime.sendMessage(message, resolve)
        );
    },
    setMaxConcurrent(value) {
        this.maxConcurrent = Math.max(1, Math.min(value, 32));
        MAX_CONCURRENT_DOWNLOADS = this.maxConcurrent;
    },
    getActiveCount() {
        return this.active.size;
    },
    clear() {
        this.active.clear();
    },
};

async function startDownloadRange(s, e) {
    const segs = parsedSegmentsData.filter((seg) =>
        seg.startTime < e && seg.endTime > s
    );
    if (!segs.length) return alert(BugiI18n.t("content.noSegments"));

    // Dosya adı: temel başlık + (varsa) dublaj dili
    let baseTitle = getSanitizedTitle();
    if (currentDownloadAudioLang) {
        baseTitle += " " + currentDownloadAudioLang;
    }
    let fileName = baseTitle + ".ts";
    // Bir indirme başlatıldıktan sonra dili sıfırla (sadece o indirme için geçerli)
    currentDownloadAudioLang = "";
    const userApproved = await diskManager.init(fileName);
    
    if (!userApproved) {
        alert(BugiI18n.t("content.folderNotSelected"));
        return;
    }

    downloadQueue = segs.map((item, index) => ({ url: item.url, id: index }));
    totalSegments = downloadQueue.length;
    
    activeDownloads = 0;
    isPaused = false;
    isCancelled = false;
    isDownloading = true;
    isMinimized = false;
    retryCount = 0;
    errorLogEntries = [];
    errorLogGenerated = false;
    segmentRetryCount = {};
    finishedSegments = new Set();
    segmentsBase64Wrapped = false;
    segmentEncodingChecked = false;
    
    initDownloadStats();
    concurrentManager.clear();
    createProgressWindow();
    
    processQueue();
    updateUI();

    if (uiUpdateInterval) clearInterval(uiUpdateInterval);
    uiUpdateInterval = setInterval(() => {
        if (isDownloading && !isPaused && !isCancelled) updateUI();
    }, 1000);
}

function processQueue() {
    if (isPaused || isCancelled) {
        if (isCancelled && concurrentManager.getActiveCount() === 0) {
            diskManager.close();
            document.getElementById("idm-progress-panel")?.remove();
            if (uiUpdateInterval) clearInterval(uiUpdateInterval);
            maybeDownloadErrorLog("cancelled");
        }
        return;
    }

    if (
        concurrentManager.getActiveCount() === 0 &&
        (
            finishedSegments.size >= totalSegments || 
            (downloadQueue.length === 0 && totalSegments > 0) 
        )
    ) {
        diskManager.close().then(() => {
            console.log("İndirme Tamamlandı!");
            document.getElementById("idm-progress-panel")?.remove();
            if (uiUpdateInterval) clearInterval(uiUpdateInterval);
            maybeDownloadErrorLog("completed");
        });
        isDownloading = false;
        return;
    }

    const available = MAX_CONCURRENT_DOWNLOADS - concurrentManager.getActiveCount();
    const itemsToProcess = Math.min(available, downloadQueue.length);

    for (let i = 0; i < itemsToProcess; i++) {
        const item = downloadQueue.shift();
        
        concurrentManager.downloadSegment(item.url, item.id, async (idx, data) => {
            if (data) {
                updateDownloadStats(data.length);
                await diskManager.writeSegment(idx, data);
                finishedSegments.add(idx);
            }
            updateUI(); 
            setTimeout(() => processQueue(), 0);
        }, (fUrl, idx, err) => {
            if (!isCancelled) {
                retryCount++;
                const key = fUrl + "::" + idx;
                segmentRetryCount[key] = (segmentRetryCount[key] || 0) + 1;
                errorLogEntries.push({
                    url: fUrl,
                    index: idx,
                    error: err,
                    retry: segmentRetryCount[key],
                    time: new Date().toISOString(),
                });
                if (segmentRetryCount[key] < MAX_SEGMENT_RETRY) {
                    downloadQueue.push({ url: fUrl, id: idx });
                } else {
                    finishedSegments.add(idx);
                }
                setTimeout(() => processQueue(), 100);
            }
        });
    }
}

function createProgressWindow() {
    const win = createDraggableWindow("idm-progress-panel", BugiI18n.t("content.progressPanelTitle"), () => {
        if (isDownloading) {
            if (confirm(BugiI18n.t("content.cancelConfirm"))) {
                isCancelled = true;
                concurrentManager.clear();
            }
        }
    });
    const minBtn = document.createElement("button");
    minBtn.className = "idm-win-btn";
    minBtn.innerText = "—";
    win.controls.insertBefore(minBtn, win.controls.firstChild);
    
    win.body.innerHTML = `
        <div id="prog-status" style="margin-bottom:8px;font-size:12px;color:#ccc;">${BugiI18n.t("content.progressStarting")}</div>
        <div style="background:#444;height:8px;border-radius:4px;overflow:hidden;margin-bottom:10px;">
            <div id="prog-bar" style="width:0%;height:100%;background:#28a745;transition:width 0.2s;"></div>
        </div>
        <div id="idm-stats-container" class="idm-stats-container">
            <div class="idm-stat-item"><span class="idm-stat-label">${BugiI18n.t("content.statElapsed")}</span><span class="idm-stat-value idm-stat-elapsed">00:00:00</span></div>
            <div class="idm-stat-item"><span class="idm-stat-label">${BugiI18n.t("content.statRemaining")}</span><span class="idm-stat-value idm-stat-time">...</span></div>
            <div class="idm-stat-item"><span class="idm-stat-label">${BugiI18n.t("content.statSpeed")}</span><span class="idm-stat-value idm-stat-speed">...</span></div>
            <div class="idm-stat-item"><span class="idm-stat-label">${BugiI18n.t("content.statSize")}</span><span class="idm-stat-value idm-stat-size">0 B</span></div>
        </div>
        <div style="display:flex;gap:5px;margin-top:10px;">
            <button id="btn-pause" style="flex:1;padding:6px;background:#f39c12;border:none;color:white;border-radius:4px;">${BugiI18n.t("content.pause")}</button>
            <button id="btn-cancel" style="flex:1;padding:6px;background:#c0392b;border:none;color:white;border-radius:4px;">${BugiI18n.t("content.cancel")}</button>
        </div>
        <div class="idm-speed-control">
            <span>${BugiI18n.t("content.packConcurrency")} <span id="speed-display" class="idm-speed-val">${MAX_CONCURRENT_DOWNLOADS}</span></span>
            <span>${BugiI18n.t("content.statActive")} <span id="active-display" class="idm-active-val">0</span></span>
            <span>${BugiI18n.t("content.statErrors")} <span id="error-display" class="idm-speed-val">0</span></span>
        </div>`;
        
    win.body.querySelector("#btn-pause").onclick = (e) => {
        isPaused = !isPaused;
        e.target.innerText = isPaused ? BugiI18n.t("content.resume") : BugiI18n.t("content.pause");
        if (!isPaused) processQueue();
    };
    win.body.querySelector("#btn-cancel").onclick = () => {
        if (confirm(BugiI18n.t("content.cancelConfirm"))) {
            isCancelled = true;
            concurrentManager.clear();
            if (concurrentManager.getActiveCount() === 0) {
                diskManager.close();
                document.getElementById("idm-progress-panel")?.remove();
                if (uiUpdateInterval) clearInterval(uiUpdateInterval);
            }
        }
    };
    minBtn.onclick = () => {
        isMinimized = !isMinimized;
        win.container.classList.toggle("minimized");
        if (!isMinimized) updateUI();
    };
}

function updateUI() {
    if (isCancelled) return;
    const win = document.getElementById("idm-progress-panel");
    if (!win) return;
    
    const fin = diskManager.nextIndex;
    const per = totalSegments > 0 ? (fin / totalSegments) * 100 : 0;
    
    if (downloadStats.startTime) {
        const elapsedSec = (Date.now() - downloadStats.startTime) / 1000;
        win.querySelector(".idm-stat-elapsed").innerText = formatTime(elapsedSec);
        win.querySelector(".idm-stat-speed").innerText = formatSpeed(getAverageSpeed());
        win.querySelector(".idm-stat-time").innerText = formatTime(getRemainingTime());
        win.querySelector(".idm-stat-size").innerText = formatBytes(downloadStats.totalBytes);
    }
    
    if (isMinimized) {
        win.querySelector(".idm-window-title").innerText = `${fin} / ${totalSegments}`;
    } else {
        win.querySelector("#prog-status").innerText = BugiI18n.tf("content.downloadingStatus", {
            done: String(fin),
            total: String(totalSegments)
        });
        win.querySelector("#prog-bar").style.width = per + "%";
        const speedDisp = win.querySelector("#speed-display");
        if (speedDisp) speedDisp.innerText = MAX_CONCURRENT_DOWNLOADS;
        win.querySelector("#active-display").innerText = concurrentManager.getActiveCount();
        win.querySelector("#error-display").innerText = retryCount;
    }
}

function initDownloadStats() {
    downloadStats = {
        startTime: Date.now(),
        totalBytes: 0,
        lastBytes: 0,
        lastTime: Date.now()
    };
}

function updateDownloadStats(bytesSize) {
    if (!downloadStats.startTime) downloadStats.startTime = Date.now();
    downloadStats.totalBytes += bytesSize;
}

function getAverageSpeed() {
    if (!downloadStats.startTime) return 0;
    const elapsedSec = (Date.now() - downloadStats.startTime) / 1000;
    if (elapsedSec < 1) return 0; 
    return downloadStats.totalBytes / elapsedSec; 
}

function getRemainingTime() {
    const downloadedCount = diskManager.nextIndex; 
    const remainingSegments = totalSegments - downloadedCount;
    if (remainingSegments <= 0 || !isDownloading) return 0;
    
    const avgSpeed = getAverageSpeed();
    if (avgSpeed <= 0) return 0;

    const avgSegmentSize = downloadStats.totalBytes / (downloadedCount || 1);
    const remainingBytes = remainingSegments * avgSegmentSize;
    return remainingBytes / avgSpeed;
}

function formatSpeed(bps) {
    if (bps <= 0) return isDownloading ? "Hesaplanıyor..." : "0 B/s";
    const kbps = (bps * 8) / 1024;
    const mbps = kbps / 1024;
    return mbps >= 1 ? `${mbps.toFixed(2)} Mbps` : `${kbps.toFixed(2)} Kbps`;
}

function formatBytes(bytes) {
    if (bytes <= 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + sizes[i];
}

function formatTime(s) {
    const h = Math.floor(s / 3600),
        m = Math.floor((s % 3600) / 60),
        sec = Math.floor(s % 60);
    return [h, m, sec].map((v) => v < 10 ? "0" + v : v).join(":");
}

function hmsToSeconds(str) {
    const p = str.split(":").map(Number);
    return (p[0] * 3600) + (p[1] * 60) + p[2];
}

function getSanitizedTitle() {
    let t = (document.title || "video").replace(/[\\/:*?"<>|]/g, "-").trim();
    t = t.replace(/[\x00-\x1f]/g, "");
    if (t.length > 150) t = t.substring(0, 150);
    return t;
}

function injectStyles() {
    if (document.getElementById("mini-idm-css-link")) return;
    const link = document.createElement("link");
    link.id = "mini-idm-css-link";
    link.rel = "stylesheet";
    link.type = "text/css";
    try {
        link.href = chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("idm.css") : "idm.css";
    } catch (_e) {
        link.href = "idm.css";
    }
    document.head.appendChild(link);
}

window.onbeforeunload = (e) => {
    if (isDownloading && !isCancelled) {
        e.preventDefault();
        return BugiI18n.t("content.leavePageWhileDownloading");
    }
};

function addSubtitleFromUrl(url, metaOverride) {
    if (!url) return;
    try {
        url = new URL(url, window.location.href).href;
    } catch (e) {}
    if (detectedSubtitles.some((s) => s.url === url)) return;
    const meta = metaOverride || inferSubtitleMetaFromUrl(url);
    detectedSubtitles.push(meta);
    chrome.runtime.sendMessage({ action: "REGISTER_MEDIA_META", subtitles: [meta] }).catch(()=>{});
    refreshOpenSubtitleSections();
}

function inferSubtitleMetaFromUrl(url) {
    let label = "";
    let lang = "";
    try {
        const clean = url.split(/[?#]/)[0];
        const parts = clean.split("/").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        const noExt = last.replace(/\.vtt$/i, "").replace(/\.srt$/i, "");
        const nameParts = noExt.split("_");
        const maybeLang = nameParts[nameParts.length - 1] || "";
        if (maybeLang) {
            label = maybeLang;
            lang = maybeLang.toLowerCase().slice(0, 2);
        }
    } catch (e) {}
    if (!label) label = BugiI18n.t("content.subtitleDefault");
    return { url, label, lang };
}

function findSubtitleTracksInDom() {
    const list = [];
    let video = document.querySelector("video");
    if (!video) {
        const all = document.querySelectorAll("*");
        for (let el of all) {
            if (el.shadowRoot) {
                const v = el.shadowRoot.querySelector("video");
                if (v) {
                    video = v;
                    break;
                }
            }
        }
    }
    if (video) {
        const tracks = video.querySelectorAll("track");
        tracks.forEach((t) => {
            const kind = (t.getAttribute("kind") || "").toLowerCase();
            if (kind && kind !== "subtitles" && kind !== "captions") return;
            let src = t.getAttribute("src") || t.src || "";
            if (!src) return;
            try {
                src = new URL(src, window.location.href).href;
            } catch (e) {}
            const label = t.getAttribute("label") || t.getAttribute("srclang") || "";
            const lang = (t.getAttribute("srclang") || "").toLowerCase();
            list.push({
                url: src,
                label: label || "Subtitle",
                lang,
            });
        });
    }
    return list;
}

function collectSubtitleSources() {
    const map = new Map();

    const add = (s) => {
        if (!s || !s.url) return;
        const label = (s.label || s.lang || "Subtitle").toString().trim();
        const lang = (s.lang || "").toString().toLowerCase();
        const key = `${lang}::${label.toLowerCase()}`;
        if (!map.has(key)) {
            map.set(key, Object.assign({}, s, { label, lang }));
        }
    };

    detectedSubtitles.forEach(add);
    const domSubs = findSubtitleTracksInDom();
    domSubs.forEach(add);

    return Array.from(map.values());
}

function renderSubtitleSection(container, subtitles) {
    const old = container.querySelector("#idm-subtitles-section");
    if (old) old.remove();

    if (!subtitles || !subtitles.length) return;

    const section = document.createElement("div");
    section.id = "idm-subtitles-section";
    section.style.marginBottom = "12px";

    const title = document.createElement("div");
    title.style.fontSize = "11px";
    title.style.color = "#aaa";
    title.style.marginBottom = "6px";
    title.innerText = BugiI18n.t("content.subtitlesSectionTitle");
    section.appendChild(title);

    subtitles.forEach((s, idx) => {
        const row = document.createElement("div");
        row.className = "idm-btn-row idm-btn-row--mb4";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "idm-list-btn";
        btn.style.flex = "1";
        btn.style.minWidth = "0";
        btn.style.textAlign = "left";

        let baseLabel = s.label || s.lang || BugiI18n.tf("content.subtitleN", { n: idx + 1 });
        let linkHint = "";
        try {
            const u = new URL(s.url, window.location.href);
            const last = u.pathname.split("/").filter(Boolean).pop() || "";
            if (last) linkHint = last;
        } catch (e) {}

        // YENİ: Sadece isDevMode aktifse göster
        if (linkHint && baseLabel.indexOf(linkHint) === -1 && isDevMode) {
            baseLabel += ` [${linkHint}]`;
        }

        btn.innerHTML = ` ${baseLabel} <span style="color:#aaa; float:right">.vtt</span>`;
        btn.onclick = () => downloadSubtitleTrack(s);

        const eyeBtn = document.createElement("button");
        eyeBtn.type = "button";
        eyeBtn.className = "idm-list-btn idm-preview-eye";
        eyeBtn.title = BugiI18n.t("media.previewTitleSub");
        eyeBtn.innerHTML = BUGI_PREVIEW_EYE_SVG;
        eyeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openBugiPreview({ url: s.url, mode: "vtt", referer: window.location.href });
        };

        row.appendChild(btn);
        row.appendChild(eyeBtn);
        section.appendChild(row);
    });

    container.appendChild(section);
}

function refreshOpenSubtitleSections() {
    const menuWin = document.getElementById("idm-menu-window");

    if (!menuWin) {
        if (subtitleRefreshTimer) {
            clearInterval(subtitleRefreshTimer);
            subtitleRefreshTimer = null;
        }
        return;
    }

    // iframe içinde yakalanan altyazılar için background meta'sı ile senkronize et
    chrome.runtime.sendMessage({ action: "GET_TAB_MEDIA_META" }, (bgMeta) => {
        try {
            const bgSubs = (bgMeta && bgMeta.subtitles) ? bgMeta.subtitles : [];
            bgSubs.forEach((s) => {
                if (s && s.url) addSubtitleFromUrl(s.url, s);
            });
        } catch (_e) {}

        const subs = collectSubtitleSources();
        const body = menuWin.querySelector(".idm-window-body");
        if (body) renderSubtitleSection(body, subs);
    });
}

function downloadSubtitleTrack(sub) {
    if (!sub || !sub.url) return;
    const url = sub.url;
    if (activeSubtitleDownloads.has(url)) return;
    activeSubtitleDownloads.add(url);

    chrome.runtime.sendMessage({
        action: "fetchUrl",
        url: url,
        referer: window.location.href
    }, async (resp) => {
        if (!resp || !resp.success) {
            const errMsg = resp && resp.error ? resp.error : BugiI18n.t("content.unknownError");
            if (shouldSuppressCorsLikeError(errMsg)) {
                activeSubtitleDownloads.delete(url);
                return;
            }
            alert(
                BugiI18n.t("content.subDownloadFail") +
                    " " +
                    errMsg
            );
            activeSubtitleDownloads.delete(url);
            return;
        }

        try {
            const baseTitle = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: "GET_TAB_TITLE" }, (r) => resolve((r && r.title) ? r.title : document.title));
            });

            let safe = (baseTitle || "subtitle").replace(/[\\/:*?"<>|]/g, "-").trim();
            safe = safe.replace(/[\x00-\x1f]/g, "");
            if (safe.length > 120) safe = safe.substring(0, 120);

            // Dil/etiket varsa kullan; hash gibi görünüyorsa kısalt
            let suffix = "";
            const lang = (sub.lang || "").toString().trim();
            const label = (sub.label || "").toString().trim();
            if (lang && /^[a-z]{2,5}$/i.test(lang)) suffix = "_" + lang.toLowerCase();
            else if (label && label.length <= 20 && /[a-zA-Z]/.test(label) && !/\.(jpg|png|webp)$/i.test(label)) suffix = "_" + label.replace(/\s+/g, "-");
            else suffix = "";

            const suggestedName = `${safe}${suffix}.vtt`;

            if (window.showSaveFilePicker) {
                const handle = await window.showSaveFilePicker({
                    suggestedName,
                    types: [{ description: "WebVTT Subtitle", accept: { "text/vtt": [".vtt"] } }]
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
            // kullanıcı iptal ederse sessiz geç
            if (!e || e.name !== "AbortError") {
                alert(BugiI18n.t("content.subSaveFail") + " " + e.toString());
            }
        } finally {
            activeSubtitleDownloads.delete(url);
        }
    });
}

function addAudioSource(meta) {
    if (!meta || !meta.url) return;
    let url = meta.url;
    try {
        url = new URL(url, window.location.href).href;
    } catch (e) {}
    if (detectedAudios.some((a) => a.url === url)) return;
    const item = {
        url,
        name: meta.name || "",
        lang: meta.lang || "",
        groupId: meta.groupId || "",
    };
    detectedAudios.push(item);
    chrome.runtime.sendMessage({ action: "REGISTER_MEDIA_META", audios: [item] }).catch(()=>{});
}

function collectAudioSources() {
    const map = new Map();
    detectedAudios.forEach((a) => {
        if (!a || !a.url) return;
        try {
            const u = new URL(a.url, window.location.href);
            const key = u.origin + u.pathname;
            if (!map.has(key)) map.set(key, a);
        } catch (e) {
            if (!map.has(a.url)) map.set(a.url, a);
        }
    });
    return Array.from(map.values());
}

function maybeDownloadErrorLog(status) {
    if (errorLogGenerated) return;
    if (!errorLogEntries.length && status === "completed") return;

    chrome.storage.local.get(["devMode"], (res) => {
        if (!res || !res.devMode) return;

        errorLogGenerated = true;
        const title = getSanitizedTitle();
        let txt = "";
        txt += `Sayfa Başlığı: ${title}\n`;
        txt += `Durum: ${status}\n`;
        txt += `Tarih (UTC): ${new Date().toISOString()}\n`;
        txt += `Toplam Segment: ${totalSegments}\n`;
        txt += `Toplam Hata: ${errorLogEntries.length}\n`;
        txt += `Seçilen URL: ${currentUrl || currentMenuSourceUrl || ""}\n`;
        txt += `Video Tipi: ${videoType}\n`;
        txt += `Paket (Concurrency): ${MAX_CONCURRENT_DOWNLOADS}\n`;
        txt += `\n--- Hata Detayları ---\n`;

        if (!errorLogEntries.length) {
            txt += "Hiç hata kaydı yok.\n";
        } else {
            errorLogEntries.forEach((e, i) => {
                txt += `\n#${i + 1}\n`;
                txt += `Zaman: ${e.time}\n`;
                txt += `Segment Index: ${e.index}\n`;
                txt += `URL: ${e.url}\n`;
                txt += `Hata: ${e.error}\n`;
                if (typeof e.retry === "number") {
                    txt += `Retry: ${e.retry}/${MAX_SEGMENT_RETRY}\n`;
                }
            });
        }

        try {
            const blob = new Blob([txt], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            const safeTitle = title || "video";
            a.download = `${safeTitle}_error.txt`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                URL.revokeObjectURL(a.href);
                a.remove();
            }, 1000);
        } catch (e) {
            console.error("Error log indirilemedi:", e);
        }
    });
}

// content.js - Native Bypass Yakalayıcı ve Loglayıcı
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;

    // HLS master / playlist intercept
    if (data && data.action === "BUGIVID_INTERCEPT") {
        const interceptUrl = data.url;
        const interceptText = data.text || "";

        sendDebug("INJECT.JS'DEN INTERCEPT YAKALANDI!", interceptUrl);
        
        // Yakalanan URL'i sisteme dahil et
        currentUrl = interceptUrl;
        videoType = "HLS";
        
        // Eğer inject.js bize gömülü/base64 veya düz metin playlist verdiyse, hem içeride hem background'da hafızaya al
        if (interceptText) {
            interceptedPlaylists[interceptUrl] = interceptText;
            try {
                chrome.runtime.sendMessage({
                    action: "REGISTER_INTERCEPTED_PLAYLIST",
                    url: interceptUrl,
                    type: "HLS",
                    body: interceptText
                });
            } catch (_e) {}
        }

        startVideoHunt();
    }

    // WEBVTT altyazı intercept (.jpg gibi sahte uzantılar dahil)
    if (data && data.action === "BUGIVID_SUB_INTERCEPT") {
        const subUrl = data.url;
        sendDebug("INJECT.JS'DEN WEBVTT YAKALANDI!", subUrl);
        const meta = data.meta && typeof data.meta === "object"
            ? Object.assign({ url: subUrl }, data.meta)
            : null;
        addSubtitleFromUrl(subUrl, meta);
        // Aynı sekmedeki diğer framelere de yay
        try {
            chrome.runtime.sendMessage({ action: "BROADCAST_SUBTITLE_URL", url: subUrl });
        } catch (_e) {}
    }

    // JSON altyazı listesi (ör: wyzie / opensubtitles proxy)
    if (data && data.action === "BUGIVID_SUB_LIST") {
        const items = Array.isArray(data.items) ? data.items : [];
        items.forEach((it) => {
            if (!it || !it.url) return;
            const meta = {
                url: it.url,
                label: it.label || it.display || it.language || "Subtitle",
                lang: (it.lang || it.language || "").toString().toLowerCase()
            };
            addSubtitleFromUrl(it.url, meta);
        });
    }

    if (data && data.action === "BUGIVID_NETWORK_ERROR") {
        const payload = {
            kind: String(data.kind || "fetch"),
            url: String(data.url || ""),
            message: String(data.message || ""),
            pageUrl: String(data.pageUrl || window.location.href),
            ts: Number(data.ts || Date.now())
        };
        sendDebug("INJECT_NETWORK_ERROR", payload);
        try {
            chrome.runtime.sendMessage({
                action: "REPORT_NETWORK_ERROR",
                payload
            }).catch(() => {});
        } catch (_e) {}
    }

});