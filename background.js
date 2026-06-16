console.log("[Background] Bugi Video Downloader v2.0 - MV3 Uyumu Sağlandı");

let requestSignatures = {}; 
let tabVideoList = {};
let tabMediaMeta = {}; // tabId -> { subs: {url:meta}, audios: {url:meta} }
let tabNetworkErrors = {}; // tabId -> [{ts, kind, url, message, pageUrl, count}]
let interceptedPlaylistsGlobal = {}; // url -> raw/decoded playlist metni
let isExtensionEnabled = true;
let isDebugActive = false;
let debugLogs = [];
let dnrDomainRules = {}; // domain -> ruleId
let nextDnrRuleId = 1000;
const DOWNLOAD_STORAGE_KEY = "bugi_download_jobs_v1";
const PENDING_CORS_URLS_KEY = "bugi_pending_cors_urls_v1";
const FORCED_BLOCKED_SITES_REMOTE_KEY = "forcedBlockedSitesRemote";
const LEGAL_ACCEPT_KEY_BASE = "bugiLegalAcceptedV1";
const LEGAL_ACCEPT_VERSION_KEY_BASE = "bugiLegalAcceptedVersionV1";
const LEGAL_ACCEPTED_AT_KEY_BASE = "bugiLegalAcceptedAtV1";
const LEGAL_CURRENT_VERSION = "2026-04-13";
const EXTENSION_VERSION = chrome.runtime.getManifest().version || "0.0.0";
const UPDATE_CHECK_ALARM = "bugi_update_check_alarm";
const UPDATE_CHECK_INTERVAL_MIN = 30;
const UPDATE_MESSAGE_URL = "https://raw.githubusercontent.com/CyPropSs/Bugi-Download-Manager/refs/heads/main/update.json";
const UPDATE_MESSAGE_FALLBACK_URL = chrome.runtime.getURL("update.json");
const CORS_EXCLUDE_LIST_URL = "https://raw.githubusercontent.com/CyPropSs/Bugi-Download-Manager/main/cors.json";
const FORCED_BLOCKED_LIST_URL = "https://raw.githubusercontent.com/CyPropSs/Bugi-Download-Manager/main/blocked.json";
const CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${chrome.runtime.id}`;
const DEFAULT_UPDATE_TEXT = "Guncelleme var! Guncellemeyi indirin.";
const BACKGROUND_FORCED_BLOCKED_HOST_FRAGMENTS = [
    "www.youtube.com",
    "netflix.com",
    "disneyplus.com",
    "primevideo.com",
    "hulu.com",
    "max.com",
    "hbomax.com",
    "tv.apple.com"
];

/**
 * Genel DNR CORS yanıt başlıkları (ACAO: *) bazı sitelerde oynatıcıyı bozar:
 * özellikle kimlik bilgili / sıkı CORS (YouTube → googlevideo vb.).
 * Bu alan adlarına giden isteklerde başlık enjekte edilmez.
 */
const DNR_CORS_SHIELD_EXCLUDED_REQUEST_DOMAINS_FALLBACK = [
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "googlevideo.com",
    "ytimg.com",
    "ggpht.com",
    "youtubei.googleapis.com",
    "netflix.com",
    "nflxvideo.net",
    "disneyplus.com",
    "hulu.com",
    "max.com",
    "hbomax.com",
    "primevideo.com",
    "amazonvideo.com",
    "aiv-cdn.net",
    "tv.apple.com",
    "kick.com",
    "web.kick.com",
    "api.kick.com"
];
let dnrCorsShieldExcludedRequestDomains = DNR_CORS_SHIELD_EXCLUDED_REQUEST_DOMAINS_FALLBACK.slice();
let blockedHostFragments = BACKGROUND_FORCED_BLOCKED_HOST_FRAGMENTS.slice();
let updateStatus = {
    checkedAt: 0,
    hasUpdate: false,
    message: "",
    latestVersion: "",
    downloadUrl: "",
    sourceUrl: "",
    error: ""
};

// MV3 service worker boşta kalınca kapanıp açılabilir.
// Yakalanan URL ve medya metalarını tarayıcı/kapat-aç sonrasında da saklamak için local storage kullan.
const sessionStore = chrome.storage.local;
const TAB_VIDEOS_KEY = (tabId) => `tabVideos_${tabId}`;
const TAB_META_KEY = (tabId) => `tabMediaMeta_${tabId}`;
// MP4 indirmeleri için URL -> istenen dosya adı eşlemesi
let mp4FilenameOverrides = {};

function getLegalKeys(useIncognitoScope) {
    const suffix = useIncognitoScope ? "_incognito" : "";
    return {
        acceptedKey: LEGAL_ACCEPT_KEY_BASE + suffix,
        versionKey: LEGAL_ACCEPT_VERSION_KEY_BASE + suffix,
        acceptedAtKey: LEGAL_ACCEPTED_AT_KEY_BASE + suffix
    };
}

function getLegalAcceptance(cb, useIncognitoScope = false) {
    const keys = getLegalKeys(useIncognitoScope);
    chrome.storage.local.get([keys.acceptedKey, keys.versionKey, keys.acceptedAtKey], (res) => {
        const accepted = !!(res && res[keys.acceptedKey]);
        const acceptedVersion = String((res && res[keys.versionKey]) || "");
        const acceptedAt = Number((res && res[keys.acceptedAtKey]) || 0);
        const isAccepted = accepted && acceptedVersion === LEGAL_CURRENT_VERSION;
        cb({
            accepted: isAccepted,
            acceptedVersion,
            acceptedAt,
            currentVersion: LEGAL_CURRENT_VERSION,
            scope: useIncognitoScope ? "incognito" : "regular"
        });
    });
}

function compareVersions(a, b) {
    const aParts = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
    const bParts = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const av = aParts[i] || 0;
        const bv = bParts[i] || 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
}

function parseUpdatePayload(payload) {
    const latestVersion = String(payload && payload.latestVersion ? payload.latestVersion : "").trim();
    const hasUpdate = latestVersion ? compareVersions(latestVersion, EXTENSION_VERSION) > 0 : false;
    const message = String((payload && payload.message) || "").trim() || DEFAULT_UPDATE_TEXT;
    const downloadUrl = String((payload && payload.downloadUrl) || "").trim() || CHROME_WEB_STORE_URL;
    return { hasUpdate, message, latestVersion, downloadUrl };
}

function normalizeCorsExcludedDomains(payload) {
    let rawList = [];
    if (Array.isArray(payload)) {
        rawList = payload;
    } else if (payload && Array.isArray(payload.domains)) {
        rawList = payload.domains;
    } else if (payload && Array.isArray(payload.excludedDomains)) {
        rawList = payload.excludedDomains;
    }

    const cleaned = rawList
        .map((d) => String(d || "").trim().toLowerCase())
        .filter((d) => !!d)
        .map((d) => d.replace(/^https?:\/\//, "").replace(/\/+$/, ""));

    const unique = Array.from(new Set(cleaned));
    return unique.length ? unique : null;
}

function normalizeForcedBlockedDomains(payload) {
    let rawList = [];
    if (Array.isArray(payload)) {
        rawList = payload;
    } else if (payload && Array.isArray(payload.domains)) {
        rawList = payload.domains;
    } else if (payload && Array.isArray(payload.blockedDomains)) {
        rawList = payload.blockedDomains;
    }

    const cleaned = rawList
        .map((d) => String(d || "").trim().toLowerCase())
        .filter((d) => !!d)
        .map((d) => d.replace(/^https?:\/\//, "").replace(/\/+$/, ""));

    const unique = Array.from(new Set(cleaned));
    return unique.length ? unique : null;
}

function mergeBlockedHostFragments(list) {
    const raw = Array.isArray(list) ? list : [];
    const combined = raw.concat(BACKGROUND_FORCED_BLOCKED_HOST_FRAGMENTS);
    const cleaned = combined
        .map((x) => String(x || "").trim().toLowerCase())
        .filter((x) => !!x)
        .map((x) => x.replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    return Array.from(new Set(cleaned));
}

function isHostBlocked(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (!host) return false;
    return blockedHostFragments.some((frag) => !!frag && host.includes(frag));
}

function isUrlBlockedForExtension(rawUrl) {
    try {
        const u = new URL(String(rawUrl || ""));
        return isHostBlocked(u.hostname || "");
    } catch (_e) {
        return false;
    }
}

function refreshBlockedHostFragmentsFromStorage() {
    chrome.storage.local.get(["blockedSites", FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
        const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY])
            ? res[FORCED_BLOCKED_SITES_REMOTE_KEY]
            : [];
        const mergedUser = mergeBlockedHostFragments(res && res.blockedSites);
        blockedHostFragments = Array.from(new Set(mergedUser.concat(remoteForced)));
        syncNetworkInterceptionState();
    });
}

async function refreshForcedBlockedSitesFromRemote() {
    try {
        const resp = await fetch(FORCED_BLOCKED_LIST_URL, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const txt = await resp.text();
        if (!txt || !txt.trim()) throw new Error("blocked.json empty");
        const parsed = JSON.parse(txt);
        const normalized = normalizeForcedBlockedDomains(parsed);
        if (!normalized) throw new Error("blocked.json has no valid domains");
        await new Promise((resolve) => {
            chrome.storage.local.set({ [FORCED_BLOCKED_SITES_REMOTE_KEY]: normalized }, () => {
                refreshBlockedHostFragmentsFromStorage();
                resolve(true);
            });
        });
    } catch (_e) {
        // Uzak liste yoksa fallback zorunlu liste ile devam et.
        refreshBlockedHostFragmentsFromStorage();
    }
}

async function refreshCorsExcludedDomainsFromRemote() {
    try {
        const resp = await fetch(CORS_EXCLUDE_LIST_URL, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const txt = await resp.text();
        if (!txt || !txt.trim()) throw new Error("cors.json empty");
        const parsed = JSON.parse(txt);
        const normalized = normalizeCorsExcludedDomains(parsed);
        if (!normalized) throw new Error("cors.json has no valid domains");
        dnrCorsShieldExcludedRequestDomains = normalized;
        if (isDebugActive) {
            addLog("BACKGROUND:CORS_CFG", "Uzaktan CORS exclude listesi yüklendi", {
                source: CORS_EXCLUDE_LIST_URL,
                count: normalized.length
            });
        }
        syncNetworkInterceptionState();
    } catch (e) {
        dnrCorsShieldExcludedRequestDomains = DNR_CORS_SHIELD_EXCLUDED_REQUEST_DOMAINS_FALLBACK.slice();
        if (isDebugActive) {
            addLog("BACKGROUND:CORS_CFG_FAIL", "Uzaktan CORS listesi alınamadı, fallback kullanılacak", String(e));
        }
        syncNetworkInterceptionState();
    }
}

function applyUpdateActionUI() {
    if (updateStatus.hasUpdate) {
        chrome.action.setTitle({ title: updateStatus.message || DEFAULT_UPDATE_TEXT });
    } else {
        chrome.action.setTitle({ title: "Bugi Video Downloader" });
    }
}

function broadcastUpdateStatus() {
    try {
        chrome.runtime.sendMessage({ action: "UPDATE_STATUS_CHANGED", status: updateStatus }).catch(() => {});
    } catch (_e) {}
}

async function fetchUpdateMessageOnce(url) {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    return parseUpdatePayload(json);
}

async function checkUpdateStatus() {
    const checkedAt = Date.now();
    let sourceUrl = UPDATE_MESSAGE_URL;
    try {
        const result = await fetchUpdateMessageOnce(UPDATE_MESSAGE_URL);
        updateStatus = {
            checkedAt,
            hasUpdate: result.hasUpdate,
            message: result.message,
            latestVersion: result.latestVersion,
            downloadUrl: result.downloadUrl,
            sourceUrl,
            error: ""
        };
    } catch (remoteErr) {
        try {
            sourceUrl = UPDATE_MESSAGE_FALLBACK_URL;
            const fallback = await fetchUpdateMessageOnce(UPDATE_MESSAGE_FALLBACK_URL);
            updateStatus = {
                checkedAt,
                hasUpdate: fallback.hasUpdate,
                message: fallback.message,
                latestVersion: fallback.latestVersion,
                downloadUrl: fallback.downloadUrl,
                sourceUrl,
                error: remoteErr ? String(remoteErr) : ""
            };
        } catch (fallbackErr) {
            updateStatus = {
                checkedAt,
                hasUpdate: false,
                message: "",
                latestVersion: "",
                downloadUrl: "",
                sourceUrl,
                error: fallbackErr ? String(fallbackErr) : "update check failed"
            };
        }
    }
    applyUpdateActionUI();
    broadcastUpdateStatus();
}

function ensureTabMeta(tabId) {
    if (!tabMediaMeta[tabId]) tabMediaMeta[tabId] = { subs: {}, audios: {} };
    return tabMediaMeta[tabId];
}

function loadTabVideos(tabId, cb) {
    if (tabVideoList[tabId]) return cb(tabVideoList[tabId]);
    sessionStore.get([TAB_VIDEOS_KEY(tabId)], (res) => {
        const list = res ? res[TAB_VIDEOS_KEY(tabId)] : null;
        if (Array.isArray(list)) tabVideoList[tabId] = list;
        cb(tabVideoList[tabId] || []);
    });
}

function saveTabVideos(tabId) {
    const list = tabVideoList[tabId] || [];
    sessionStore.set({ [TAB_VIDEOS_KEY(tabId)]: list });
}

function loadTabMeta(tabId, cb) {
    if (tabMediaMeta[tabId]) return cb(tabMediaMeta[tabId]);
    sessionStore.get([TAB_META_KEY(tabId)], (res) => {
        const meta = res ? res[TAB_META_KEY(tabId)] : null;
        if (meta && typeof meta === "object") tabMediaMeta[tabId] = meta;
        cb(tabMediaMeta[tabId] || { subs: {}, audios: {} });
    });
}

function saveTabMeta(tabId) {
    const meta = tabMediaMeta[tabId] || { subs: {}, audios: {} };
    sessionStore.set({ [TAB_META_KEY(tabId)]: meta });
}

function getDetectedMediaBadgeInfo(tabId) {
    const list = Array.isArray(tabVideoList[tabId]) ? tabVideoList[tabId] : [];
    const mediaOnly = list.filter((v) => v && (v.type === "HLS" || v.type === "MP4"));
    const count = mediaOnly.length;
    const hasMasterHint = mediaOnly.some((v) => {
        const u = String((v && v.url) || "").toLowerCase();
        return v.type === "HLS" && (u.includes("master.m3u8") || u.includes("/master"));
    });
    return { count, hasMasterHint };
}

function updateTabActionBadge(tabId) {
    if (typeof tabId !== "number" || tabId < 0) return;
    try {
        const info = getDetectedMediaBadgeInfo(tabId);
        const text = info.count > 0 ? String(Math.min(999, info.count)) : "";
        chrome.action.setBadgeText({ tabId, text });
        if (info.count > 0) {
            const color = info.hasMasterHint ? "#e67e22" : "#43a047";
            chrome.action.setBadgeBackgroundColor({ tabId, color });
        }
    } catch (_e) {}
}

function clearTabActionBadge(tabId) {
    if (typeof tabId !== "number" || tabId < 0) return;
    try { chrome.action.setBadgeText({ tabId, text: "" }); } catch (_e) {}
}

function clearAllTabActionBadges() {
    try {
        chrome.tabs.query({}, (tabs) => {
            (tabs || []).forEach((t) => {
                if (t && typeof t.id === "number") clearTabActionBadge(t.id);
            });
        });
    } catch (_e) {}
}

function sanitizeIssueUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl || ""));
        const keys = Array.from(u.searchParams.keys()).slice(0, 10);
        const query = keys.length ? `?${keys.join("&")}` : "";
        return `${u.origin}${u.pathname}${query}`;
    } catch (_e) {
        return String(rawUrl || "").slice(0, 500);
    }
}

function sanitizeCorsReportUrl(rawUrl) {
    return sanitizeIssueUrl(rawUrl);
}

function appendPendingCorsUrl(rawUrl, cb) {
    const url = sanitizeCorsReportUrl(rawUrl);
    if (!url) {
        cb && cb(false);
        return;
    }
    chrome.storage.local.get([PENDING_CORS_URLS_KEY], (res) => {
        const current = Array.isArray(res && res[PENDING_CORS_URLS_KEY]) ? res[PENDING_CORS_URLS_KEY] : [];
        if (current.includes(url)) {
            cb && cb(false);
            return;
        }
        current.push(url);
        if (current.length > 500) current.splice(0, current.length - 500);
        chrome.storage.local.set({ [PENDING_CORS_URLS_KEY]: current }, () => cb && cb(true));
    });
}

function getPendingCorsUrls(cb) {
    chrome.storage.local.get([PENDING_CORS_URLS_KEY], (res) => {
        const current = Array.isArray(res && res[PENDING_CORS_URLS_KEY]) ? res[PENDING_CORS_URLS_KEY] : [];
        cb(current);
    });
}

function clearPendingCorsUrls(cb) {
    chrome.storage.local.set({ [PENDING_CORS_URLS_KEY]: [] }, () => cb && cb(true));
}

function addTabNetworkIssue(tabId, issue) {
    if (typeof tabId !== "number" || tabId < 0 || !issue) return;
    if (!tabNetworkErrors[tabId]) tabNetworkErrors[tabId] = [];
    const list = tabNetworkErrors[tabId];
    const kind = String(issue.kind || "fetch");
    const url = sanitizeIssueUrl(issue.url || "");
    const message = String(issue.message || "").slice(0, 500);
    const pageUrl = sanitizeIssueUrl(issue.pageUrl || "");
    const ts = Number(issue.ts || Date.now());
    const key = `${kind}|${url}|${message.slice(0, 120)}`;
    const found = list.find((it) => it && it.key === key);
    if (found) {
        found.count = (found.count || 1) + 1;
        found.ts = ts;
        return;
    }
    list.push({ key, ts, kind, url, message, pageUrl, count: 1 });
    if (list.length > 80) {
        list.splice(0, list.length - 80);
    }
}

chrome.storage.local.get(['extensionEnabled', 'isDebugActive'], (res) => {
    if (res.extensionEnabled === false) isExtensionEnabled = false;
    if (res.isDebugActive) isDebugActive = true;
    syncNetworkInterceptionState();
    refreshBlockedHostFragmentsFromStorage();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.extensionEnabled !== undefined) {
            isExtensionEnabled = changes.extensionEnabled.newValue;
            if (!isExtensionEnabled) {
                tabVideoList = {};
                tabNetworkErrors = {};
                clearAllTabActionBadges();
            }
            syncNetworkInterceptionState();
        }
        if (changes.blockedSites !== undefined) {
            refreshBlockedHostFragmentsFromStorage();
        }
        if (changes[FORCED_BLOCKED_SITES_REMOTE_KEY] !== undefined) {
            refreshBlockedHostFragmentsFromStorage();
        }
        if (changes.isDebugActive !== undefined) {
            isDebugActive = changes.isDebugActive.newValue;
            if (isDebugActive) {
                debugLogs = []; 
                addLog("BACKGROUND", "Loglama başlatıldı.");
            }
        }
    }
});

function addLog(source, msg, data = "") {
    if (!isDebugActive) return;
    const time = new Date().toISOString();
    let dataStr = "";
    if (data) {
        if (data instanceof Error) {
            dataStr = `${data.name}: ${data.message}\nStack: ${data.stack}`;
        } else if (typeof data === 'object') {
            try { dataStr = JSON.stringify(data, null, 2); } catch(e) { dataStr = String(data); }
        } else {
            dataStr = String(data);
        }
        if (dataStr.length > 1500) dataStr = dataStr.substring(0, 1500) + "... [KESİLDİ]";
        dataStr = "\n  >> Detay: " + dataStr;
    }
    const logEntry = `[${time}] [${source}] ${msg}${dataStr}`;
    debugLogs.push(logEntry);
    console.log(logEntry);
}

// Belirli bir domain için Referer/Origin kuralını dinamik olarak DNR'a yaz
function updateDNRRuleForDomain(domain) {
    try {
        const sig = requestSignatures[domain];
        if (!sig || (!sig.referer && !sig.origin)) return;

        const ruleId = dnrDomainRules[domain] || nextDnrRuleId++;
        dnrDomainRules[domain] = ruleId;

        const requestHeaders = [];
        if (sig.referer) {
            requestHeaders.push({
                header: "Referer",
                operation: "set",
                value: sig.referer
            });
        }
        if (sig.origin) {
            requestHeaders.push({
                header: "Origin",
                operation: "set",
                value: sig.origin
            });
        }
        if (!requestHeaders.length) return;

        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
            addRules: [
                {
                    id: ruleId,
                    priority: 1,
                    action: {
                        type: "modifyHeaders",
                        requestHeaders
                    },
                    condition: {
                        // Bu domain'e giden tüm XHR / media istekleri için uygula
                        urlFilter: domain,
                        resourceTypes: ["xmlhttprequest", "media"]
                    }
                }
            ]
        }, () => {});
    } catch (_e) {
        // DNR hata verirse sessiz geç
    }
}

function applyDnrCorsShieldRule() {
    const effectiveExcludedDomains = Array.from(
        new Set([].concat(dnrCorsShieldExcludedRequestDomains, blockedHostFragments))
    );
    chrome.declarativeNetRequest.updateDynamicRules(
        {
            removeRuleIds: [1],
            addRules: [
                {
                    id: 1,
                    priority: 1,
                    action: {
                        type: "modifyHeaders",
                        responseHeaders: [
                            { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
                            {
                                header: "Access-Control-Allow-Methods",
                                operation: "set",
                                value: "GET, POST, OPTIONS, PUT, DELETE"
                            },
                            { header: "Access-Control-Allow-Headers", operation: "set", value: "*" }
                        ]
                    },
                    condition: {
                        urlFilter: "*",
                        resourceTypes: ["xmlhttprequest", "media"],
                        excludedRequestDomains: effectiveExcludedDomains
                    }
                }
            ]
        },
        () => {
            const err = chrome.runtime.lastError;
            if (err) console.warn("[Background] DNR cors shield:", err.message);
        }
    );
}

function clearAllDynamicDnrRules() {
    try {
        chrome.declarativeNetRequest.getDynamicRules((rules) => {
            const ids = Array.isArray(rules) ? rules.map((r) => r.id).filter((id) => typeof id === "number") : [];
            if (!ids.length) return;
            chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids }, () => {});
        });
    } catch (_e) {}
}

function syncNetworkInterceptionState() {
    if (isExtensionEnabled) {
        applyDnrCorsShieldRule();
        return;
    }
    requestSignatures = {};
    dnrDomainRules = {};
    clearAllDynamicDnrRules();
}

// 1. MV3 DNR (DECLARATIVE NET REQUEST) - CORS KALKANI (genel; YouTube vb. hariç)
chrome.runtime.onInstalled.addListener((details) => {
    syncNetworkInterceptionState();
    refreshCorsExcludedDomainsFromRemote();
    refreshForcedBlockedSitesFromRemote();
    if (details && details.reason === "install") {
        const keys = getLegalKeys(false);
        chrome.storage.local.set({
            [keys.acceptedKey]: false,
            [keys.versionKey]: "",
            [keys.acceptedAtKey]: 0
        }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
        });
    } else {
        const keys = getLegalKeys(false);
        chrome.storage.local.set({
            [keys.acceptedKey]: false,
            [keys.versionKey]: "",
            [keys.acceptedAtKey]: 0
        });
    }
    chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
    checkUpdateStatus();
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
    checkUpdateStatus();
    refreshCorsExcludedDomainsFromRemote();
    refreshForcedBlockedSitesFromRemote();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === UPDATE_CHECK_ALARM) {
        checkUpdateStatus();
        refreshCorsExcludedDomainsFromRemote();
        refreshForcedBlockedSitesFromRemote();
    }
});

// 2. HEADER TRAFİK POLİSİ (SADECE OKUMA - MV3)
chrome.webRequest.onBeforeSendHeaders.addListener(
  function(details) {
    if (!isExtensionEnabled) return;
    if (isUrlBlockedForExtension(details.url)) return;
    const urlObj = new URL(details.url);
    const domain = urlObj.hostname;
    const headers = details.requestHeaders;
    const isExtension = details.initiator && details.initiator.startsWith('chrome-extension');

    if (!isExtension) {
        const url = details.url;
        const lowerUrl = url.toLowerCase();
        const isHlsTxt = (lowerUrl.includes("/hls/") || lowerUrl.includes("hls/")) && lowerUrl.endsWith(".txt");
        const isMediaChunk = url.includes(".m3u8") || url.includes("/list/") || url.includes(".ts") || url.includes("/ms/") || isHlsTxt;
        
        if (isMediaChunk) {
            requestSignatures[domain] = {
                referer: (headers.find(h => h.name.toLowerCase() === 'referer') || {}).value || "",
                origin: (headers.find(h => h.name.toLowerCase() === 'origin') || {}).value || "",
                cookie: (headers.find(h => h.name.toLowerCase() === 'cookie') || {}).value || "",
                ua: (headers.find(h => h.name.toLowerCase() === 'user-agent') || {}).value || ""
            };
            addLog("BACKGROUND:CAPTURE", "Orijinal Header Yakalandı", {domain});

            // Bu domain için Referer/Origin'i DNR'a yaz ki indirme başlamadan önce hazır olsun
            updateDNRRuleForDomain(domain);
        }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"] 
);

// 3. URL YAKALAYICI
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
      if (!isExtensionEnabled) return; 
      if (isUrlBlockedForExtension(details.url)) return;
      const url = details.url;
      if(url.includes("chrome-extension://")) return;
      
      let type = null;
      const lower = url.toLowerCase();
      if (lower.includes(".m3u8") || lower.includes("master.m3u8") || lower.includes("(m3u(")) {
           type = "HLS";
      } else if ((lower.includes("/hls/") || lower.includes("hls/")) && lower.includes("master")) {
           // Bazı siteler master playlist'i .m3u8/.txt yerine farklı uzantı (örn master.jpg) ile verir.
           // Burada sadece HLS adayı olsun diye işaretliyoruz; gerçek master içeriği inject.js imzasıyla doğrulanır.
           type = "HLS";
      } else if (lower.includes(".mp4") && !lower.includes("preroll")) {
           type = "MP4";
      } else if (lower.includes(".vtt") || lower.includes(".srt") || lower.includes("/srt/")) {
           type = "SUBTITLE";
      }
      
      if (type) {
          if (details.tabId >= 0) {
              notifyTab(details.tabId, url, type);
          } else {
              chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                  if(tabs && tabs.length > 0) notifyTab(tabs[0].id, url, type);
              });
          }
      }
  },
  {urls: ["<all_urls>"]}
);

function notifyTab(tabId, url, type) {
    if (tabId < 0) return;
    if (!tabVideoList[tabId]) tabVideoList[tabId] = [];
    if (!tabVideoList[tabId].some(v => v.url === url)) {
        tabVideoList[tabId].push({ url: url, type: type });
        saveTabVideos(tabId);
        updateTabActionBadge(tabId);
        chrome.tabs.sendMessage(tabId, { action: "urlCaught", url: url, type: type }).catch(()=>{});
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    delete tabVideoList[tabId];
    delete tabMediaMeta[tabId];
    delete tabNetworkErrors[tabId];
    sessionStore.remove([TAB_VIDEOS_KEY(tabId), TAB_META_KEY(tabId)]);
    clearTabActionBadge(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
      delete tabVideoList[tabId];
      delete tabMediaMeta[tabId];
      delete tabNetworkErrors[tabId];
      sessionStore.remove([TAB_VIDEOS_KEY(tabId), TAB_META_KEY(tabId)]);
      clearTabActionBadge(tabId);
  }
});

// 4. MESAJLAŞMA MERKEZİ
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ADD_DEBUG_LOG") { addLog(request.source, request.msg, request.data); return; }
  if (request.action === "GET_DEBUG_LOGS") { sendResponse({ logs: debugLogs.join("\n\n") }); return; }
  if (request.action === "OPEN_LEGAL_POPUP") {
      const fallbackOpen = () => {
          const url = chrome.runtime.getURL("popup.html");
          chrome.windows.create({
              url,
              type: "popup",
              width: 420,
              height: 760,
              focused: true
          });
          sendResponse({ success: true, mode: "window-fallback" });
      };

      try {
          if (chrome.action && typeof chrome.action.openPopup === "function") {
              Promise.resolve(chrome.action.openPopup())
                  .then(() => sendResponse({ success: true, mode: "action-popup" }))
                  .catch(() => fallbackOpen());
              return true;
          }
          fallbackOpen();
      } catch (_e) {
          fallbackOpen();
      }
      return;
  }
  if (request.action === "GET_LEGAL_STATUS") {
      const useIncognitoScope = !!request.incognito;
      getLegalAcceptance((st) => {
          sendResponse(st);
      }, useIncognitoScope);
      return true;
  }
  if (request.action === "SET_LEGAL_ACCEPTED") {
      const useIncognitoScope = !!request.incognito;
      const keys = getLegalKeys(useIncognitoScope);
      const accepted = !!request.accepted;
      const payload = accepted
          ? {
              [keys.acceptedKey]: true,
              [keys.versionKey]: LEGAL_CURRENT_VERSION,
              [keys.acceptedAtKey]: Date.now()
            }
          : {
              [keys.acceptedKey]: false,
              [keys.versionKey]: "",
              [keys.acceptedAtKey]: 0
            };
      chrome.storage.local.set(payload, () => {
          sendResponse({ ok: true, accepted, currentVersion: LEGAL_CURRENT_VERSION });
      });
      return true;
  }
  if (request.action === "GET_UPDATE_STATUS") {
      sendResponse({ status: updateStatus, extensionVersion: EXTENSION_VERSION });
      return;
  }
  if (request.action === "CHECK_UPDATE_NOW") {
      checkUpdateStatus()
        .then(() => sendResponse({ ok: true, status: updateStatus, extensionVersion: EXTENSION_VERSION }))
        .catch((e) => sendResponse({ ok: false, error: e ? String(e) : "update check failed", status: updateStatus, extensionVersion: EXTENSION_VERSION }));
      return true;
  }

  if (request.action === "REFRESH_REMOTE_CONFIG_NOW") {
      (async () => {
          try {
              await Promise.all([
                  refreshCorsExcludedDomainsFromRemote(),
                  refreshForcedBlockedSitesFromRemote()
              ]);
              sendResponse({ ok: true });
          } catch (e) {
              sendResponse({ ok: false, error: e ? String(e) : "refresh_failed" });
          }
      })();
      return true;
  }

  if (request.action === "GET_COOKIE_STRINGS_FOR_URL") {
      const rawUrl = request.url;
      if (!rawUrl || typeof rawUrl !== "string") {
          sendResponse({ ok: false, cookies: [], error: "missing_url" });
          return false;
      }
      try {
          const u = new URL(rawUrl);
          if (!/^https?:/i.test(u.protocol)) {
              sendResponse({ ok: false, cookies: [], error: "not_http_scheme" });
              return false;
          }
      } catch (_e) {
          sendResponse({ ok: false, cookies: [], error: "bad_url" });
          return false;
      }
      try {
          chrome.cookies.getAll({ url: rawUrl }, (cks) => {
              if (chrome.runtime.lastError) {
                  sendResponse({ ok: false, cookies: [], error: chrome.runtime.lastError.message || "cookies_error" });
                  return;
              }
              const list = Array.isArray(cks) ? cks : [];
              const maxCookies = 200;
              const droppedCount = Math.max(0, list.length - maxCookies);
              const slice = list.slice(0, maxCookies);
              const pairs = [];
              slice.forEach((ck) => {
                  if (!ck || typeof ck.name !== "string") return;
                  const v = ck.value == null ? "" : String(ck.value);
                  const valLen = v.length;
                  if (valLen > 2048) {
                      pairs.push(`${ck.name}=${v.slice(0, 2048)}...[TRUNCATED ${valLen} chars]`);
                  } else {
                      pairs.push(`${ck.name}=${v}`);
                  }
              });
              sendResponse({
                  ok: true,
                  cookies: pairs,
                  droppedCount: droppedCount > 0 ? droppedCount : undefined
              });
          });
      } catch (e) {
          sendResponse({ ok: false, cookies: [], error: e ? String(e.message || e) : "cookies_throw" });
      }
      return true;
  }

  if (request.action === "getDetectedVideos") {
      loadTabVideos(request.tabId, (list) => sendResponse(list || []));
      return true;
  }

  if (request.action === "GET_TAB_MEDIA_META") {
      const tabId = (typeof request.tabId === "number") ? request.tabId : (sender && sender.tab ? sender.tab.id : -1);
      if (typeof tabId !== "number" || tabId < 0) { sendResponse({ subtitles: [], audios: [] }); return; }

      loadTabMeta(tabId, (loaded) => {
          if (!tabMediaMeta[tabId]) tabMediaMeta[tabId] = loaded;
          const meta = ensureTabMeta(tabId);
          sendResponse({
              subtitles: Object.values(meta.subs || {}),
              audios: Object.values(meta.audios || {})
          });
      });
      return true;
  }

  if (request.action === "REPORT_NETWORK_ERROR") {
      if (!isExtensionEnabled) { sendResponse({ ok: false, error: "EXTENSION_DISABLED" }); return; }
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      addTabNetworkIssue(tabId, request.payload || {});
      appendPendingCorsUrl(request && request.payload ? request.payload.url : "", () => {
          sendResponse({ ok: true });
      });
      return;
  }

  if (request.action === "GET_TAB_NETWORK_ERRORS") {
      const tabId = (typeof request.tabId === "number") ? request.tabId : (sender && sender.tab ? sender.tab.id : -1);
      const list = (typeof tabId === "number" && tabId >= 0 && Array.isArray(tabNetworkErrors[tabId])) ? tabNetworkErrors[tabId] : [];
      sendResponse({ errors: list.slice(-40) });
      return;
  }

  if (request.action === "GET_PENDING_CORS_URLS") {
      getPendingCorsUrls((urls) => sendResponse({ urls: urls || [] }));
      return true;
  }

  if (request.action === "CLEAR_PENDING_CORS_URLS") {
      clearPendingCorsUrls(() => sendResponse({ ok: true }));
      return true;
  }

  if (!isExtensionEnabled) {
      sendResponse && sendResponse({ success: false, error: "EXTENSION_DISABLED" });
      return;
  }
  if (sender && sender.tab && sender.tab.url && isUrlBlockedForExtension(sender.tab.url)) {
      sendResponse && sendResponse({ success: false, error: "SITE_BLOCKED" });
      return;
  }

  if (request.action === "OPEN_DOWNLOAD_MANAGER") {
      const url = chrome.runtime.getURL("download.html");
      chrome.tabs.query({ url }, (tabs) => {
          if (tabs && tabs.length > 0) {
              // Zaten açıksa sekmeye geçme; çoklu indirmede sürekli sekme değişmesin
          } else {
              chrome.tabs.create({ url });
          }
      });
      return;
  }

  if (request.action === "REGISTER_DOWNLOAD_JOB") {
      const useIncognitoScope = !!(sender && ((sender.tab && sender.tab.incognito) || sender.incognito));
      getLegalAcceptance((legal) => {
          if (!legal.accepted) {
              sendResponse && sendResponse({ success: false, blockedByLegal: true, error: "Kullanim kosullari kabul edilmedi." });
              return;
          }

      const job = request.job;
      if (!job || !job.id) return;
      const tabId = sender && sender.tab ? sender.tab.id : -1;

      // İşi kalıcı depoya yaz
      chrome.storage.local.get([DOWNLOAD_STORAGE_KEY], (res) => {
          let list = Array.isArray(res[DOWNLOAD_STORAGE_KEY]) ? res[DOWNLOAD_STORAGE_KEY] : [];
          if (!list.some(j => j.id === job.id)) {
              // Varsayılan alanları tamamla
              const base = {
                  status: "queued",
                  finishedSegments: 0,
                  totalBytes: 0,
                  createdAt: Date.now()
              };

              // Orijinal başlık / URL bilgilerini sakla
              const originalTitle = job.title || (sender && sender.tab && sender.tab.title) || "";
              const originalPageUrl = job.pageUrl || (sender && sender.tab && sender.tab.url) || "";
              let originalHost = "";
              try {
                  if (originalPageUrl) originalHost = new URL(originalPageUrl).hostname || "";
              } catch (_e) {}

              const captured = { originalTitle, originalPageUrl, originalHost };

              // Tab'a ait media meta bilgisini yakala (altyazı/dublaj listeleri)
              if (typeof tabId === "number" && tabId >= 0) {
                  const meta = tabMediaMeta[tabId] || { subs: {}, audios: {} };
                  captured.media = {
                      subtitles: Object.values(meta.subs || {}),
                      audios: Object.values(meta.audios || {})
                  };
              }

              // Segmentlerin host'larına göre header imzalarını yakala
              const headersByHost = {};
              if (Array.isArray(job.segments)) {
                  job.segments.forEach((seg) => {
                      if (!seg || !seg.url) return;
                      try {
                          const h = new URL(seg.url).hostname;
                          if (!h || headersByHost[h]) return;
                          const sig = requestSignatures[h];
                          if (sig) {
                              headersByHost[h] = {
                                  referer: sig.referer || "",
                                  origin: sig.origin || ""
                              };
                          }
                      } catch (_e) {}
                  });
              }
              if (Object.keys(headersByHost).length) {
                  captured.headersByHost = headersByHost;
              }

              // Kaynak playlist içerikleri (varsa) - sadece asıl URL için
              if (job.sourceUrl && interceptedPlaylistsGlobal[job.sourceUrl]) {
                  captured.playlists = captured.playlists || {};
                  captured.playlists[job.sourceUrl] = interceptedPlaylistsGlobal[job.sourceUrl];
              }

              // Download manager'dan gelen nesiller arası medya bilgisini koru
              if (job.media) {
                  captured.media = job.media;
              }

              // Job içinden snapshot'ı captured altına taşı ve üstten kaldır (gizli kalsın)
              const jobClean = Object.assign({}, job);
              const snap = jobClean.snapshot;
              try { delete jobClean.snapshot; } catch (_e) {}
              if (snap) captured.snapshot = snap;

              const normalized = Object.assign(base, jobClean, { captured });
              list.push(normalized);
              chrome.storage.local.set({ [DOWNLOAD_STORAGE_KEY]: list }, () => {
                  // Açık download manager sekmeleri varsa canlı olarak güncelle
                  chrome.tabs.query({ url: chrome.runtime.getURL("download.html") }, (tabs) => {
                      tabs.forEach((t) => {
                          try {
                              chrome.tabs.sendMessage(t.id, { action: "REGISTER_DOWNLOAD_JOB", job: normalized });
                          } catch (_e) {}
                      });
                  });
              });
          }
      });
      }, useIncognitoScope);
      return true;
  }

  // OPEN_MAIN_UI_FOR_JOB kaldırıldı; tekrar indirme işlemi artık tamamen
  // download manager içindeki yakalanmış veriler üzerinden yapılıyor.

  if (request.action === "GET_TAB_TITLE") {
      const title = (sender && sender.tab && sender.tab.title) ? sender.tab.title : "";
      sendResponse({ title });
      return;
  }

  if (request.action === "REGISTER_INTERCEPTED_PLAYLIST") {
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      const url = request.url;
      if (typeof tabId !== "number" || tabId < 0 || !url) return;

      addLog("BACKGROUND:PLAYLIST_REG", "Intercept playlist kaydediliyor", {
          tabId,
          url,
          hasBody: !!request.body,
      });

      // Listeye URL'yi HLS olarak ekle (popup'ta görünsün)
      if (!tabVideoList[tabId]) tabVideoList[tabId] = [];
      if (!tabVideoList[tabId].some(v => v.url === url)) {
          tabVideoList[tabId].push({ url, type: request.type || "HLS" });
          saveTabVideos(tabId);
      }

      if (request.body && typeof request.body === "string") {
          interceptedPlaylistsGlobal[url] = request.body;
      }
      return;
  }

  if (request.action === "GET_INTERCEPTED_PLAYLIST") {
      const url = request.url;
      const body = url ? interceptedPlaylistsGlobal[url] : "";
      const found = !!body;
      addLog("BACKGROUND:PLAYLIST_GET", "Intercept playlist sorgusu", {
          url,
          found,
          length: body ? body.length : 0,
      });
      sendResponse({ found, body: body || "" });
      return;
  }

  if (request.action === "REGISTER_MEDIA_META") {
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      if (typeof tabId !== "number" || tabId < 0) return;
      const meta = ensureTabMeta(tabId);

      const subs = Array.isArray(request.subtitles) ? request.subtitles : [];
      subs.forEach((s) => {
          if (!s || !s.url) return;
          meta.subs[s.url] = s;
      });

      const audios = Array.isArray(request.audios) ? request.audios : [];
      audios.forEach((a) => {
          if (!a || !a.url) return;
          meta.audios[a.url] = a;
      });

      saveTabMeta(tabId);

      // Aynı sekmeden oluşturulmuş indirme işleri varsa, onların içinde de
      // captured.media.altayzı/dublaj listesini güncelle ki daha sonra
      // "Tekrar indir" ekranında altyazılar kaybolmasın.
      const pageUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : "";
      if (pageUrl) {
          chrome.storage.local.get([DOWNLOAD_STORAGE_KEY], (res) => {
              let list = Array.isArray(res[DOWNLOAD_STORAGE_KEY]) ? res[DOWNLOAD_STORAGE_KEY] : [];
              const subsArr = Object.values(meta.subs || {});
              const audiosArr = Object.values(meta.audios || {});
              let changed = false;

              if (subsArr.length || audiosArr.length) {
                  list = list.map((job) => {
                      try {
                          const jobPage =
                              (job && job.pageUrl) ||
                              (job && job.captured && job.captured.originalPageUrl) ||
                              "";
                          if (!jobPage || jobPage !== pageUrl) return job;

                          job.captured = job.captured || {};
                          job.captured.media = job.captured.media || {};
                          if (subsArr.length) job.captured.media.subtitles = subsArr;
                          if (audiosArr.length) job.captured.media.audios = audiosArr;
                          changed = true;
                          return job;
                      } catch (_e) {
                          return job;
                      }
                  });
              }

              if (changed) {
                  chrome.storage.local.set({ [DOWNLOAD_STORAGE_KEY]: list });
              }
          });
      }

      return;
  }

  if (request.action === "GET_MEDIA_FOR_PAGE") {
      const pageUrl = (request && typeof request.pageUrl === "string") ? request.pageUrl : "";
      if (!pageUrl) { sendResponse({ subtitles: [], audios: [] }); return; }

      chrome.tabs.query({ url: pageUrl }, (tabs) => {
          if (!tabs || !tabs.length) {
              sendResponse({ subtitles: [], audios: [] });
              return;
          }
          const tabId = tabs[0].id;
          loadTabMeta(tabId, (loaded) => {
              if (!tabMediaMeta[tabId]) tabMediaMeta[tabId] = loaded;
              const meta = ensureTabMeta(tabId);
              sendResponse({
                  subtitles: Object.values(meta.subs || {}),
                  audios: Object.values(meta.audios || {})
              });
          });
      });
      return true;
  }

  if (request.action === "GET_BEST_PLAYLIST_FOR_PAGE") {
      const pageUrl = (request && typeof request.pageUrl === "string") ? request.pageUrl : "";
      if (!pageUrl) { sendResponse({ found: false, url: "", body: "" }); return; }

      chrome.tabs.query({ url: pageUrl }, (tabs) => {
          if (!tabs || !tabs.length) {
              sendResponse({ found: false, url: "", body: "" });
              return;
          }
          const tabId = tabs[0].id;
          const list = tabVideoList[tabId] || [];
          const hlsVideos = list.filter((v) => v && v.type === "HLS");

          let best = null;
          let bestQ = 0;

          hlsVideos.forEach((v) => {
              try {
                  const body = interceptedPlaylistsGlobal[v.url];
                  if (!body) return;
                  const text = String(body);
                  const matches = text.match(/#EXT-X-STREAM-INF/g);
                  let qCount = 0;
                  if (matches && matches.length) {
                      qCount = matches.length;
                  } else if (text.includes("#EXTINF:")) {
                      qCount = 1;
                  }
                  if (qCount > bestQ) {
                      bestQ = qCount;
                      best = { url: v.url, body: text };
                  }
              } catch (_e) {}
          });

          if (!best) {
              sendResponse({ found: false, url: "", body: "" });
              return;
          }

          sendResponse({ found: true, url: best.url, body: best.body || "" });
      });
      return true;
  }

  if (request.action === "CLEAR_TAB_MEDIA") {
      const tabId = (typeof request.tabId === "number") ? request.tabId : (sender && sender.tab ? sender.tab.id : -1);
      if (typeof tabId !== "number" || tabId < 0) { sendResponse({ success: false }); return; }

      delete tabVideoList[tabId];
      delete tabMediaMeta[tabId];
      sessionStore.remove([TAB_VIDEOS_KEY(tabId), TAB_META_KEY(tabId)], () => {
          sendResponse({ success: true });
      });
      return true;
  }

  if (request.action === "fetchUrl") {
    addLog("BACKGROUND:FETCH", "Fetch isteği başlatıldı", request.url);
    
    let urlObj = new URL(request.url);
    let savedHeaders = requestSignatures[urlObj.hostname] || {};
    
    const fetchInit = {
        credentials: 'include', // oturum çerezleri mümkünse kullanılsın
        cache: 'no-store'
    };

    try {
        const fetchHeaders = new Headers();
        // Not: bazı header isimleri (User-Agent, Origin, Cookie) kısıtlı olabilir.
        // Bu yüzden sadece güvenli olanları ekleyip, hata olursa headers'sız devam ediyoruz.
        if (request.referer || savedHeaders.referer) {
            fetchHeaders.append('Referer', request.referer || savedHeaders.referer);
        }
        // HLS önizleme / parça aralığı (Range) — hls.js init segment vb.
        if (request.range && typeof request.range === "string") {
            fetchHeaders.append("Range", request.range);
        }
        // Eğer burada bir hata fırlarsa (ör. tarayıcı politikası), aşağıdaki catch devreye girer.
        fetchInit.headers = fetchHeaders;
    } catch(e) {
        addLog("BACKGROUND:FETCH_HDR_FAIL", "Custom header eklenemedi, headers'sız denenecek.", e.toString());
    }
    
    const buildFallbackPlans = () => {
        const plans = [];
        plans.push({ label: "primary", init: fetchInit });
        // Bazı kaynaklar credentials: include ile CORS seviyesinde TypeError düşürüyor.
        // Bu durumda headers'ı koruyarak credentials'ı düşürüp tekrar dene.
        plans.push({
            label: "fallback-omit-credentials",
            init: Object.assign({}, fetchInit, { credentials: "omit" })
        });
        // Bazı ortamlarda custom header kombinasyonu da isteği düşürebiliyor.
        plans.push({
            label: "fallback-omit-no-headers",
            init: { credentials: "omit", cache: "no-store" }
        });
        return plans;
    };

    const plans = buildFallbackPlans();
    let attemptIndex = 0;

    const finalizeSuccess = (d) => {
        if (request.isBinary) {
            // Not: chrome.runtime mesajlaşması bazı ortamlarda ArrayBuffer'u taşıyamayabiliyor.
            // Bu yüzden binary'i Base64 string olarak dönüyoruz; encode tarafını olabildiğince hızlı tut.
            try {
                const bytes = new Uint8Array(d);
                let binary = "";
                const len = bytes.byteLength;
                const chunkSize = 32768;
                for (let i = 0; i < len; i += chunkSize) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
                }
                const b64 = btoa(binary);
                addLog("BACKGROUND:FETCH_OK", "Binary fetch base64'e çevrildi", { bytes: bytes.byteLength, encoding: "base64" });
                sendResponse({ success: true, data: b64, encoding: "base64" });
            } catch (e2) {
                addLog("BACKGROUND:FETCH_FAIL", "Binary encode failed", e2 ? e2.toString() : "unknown");
                sendResponse({ success: false, error: (e2 && e2.toString) ? e2.toString() : "Binary encode failed" });
            }
        } else {
            sendResponse({ success: true, data: d, encoding: "text" });
        }
    };

    const runAttempt = () => {
        const plan = plans[attemptIndex];
        if (!plan) {
            sendResponse({ success: false, error: "TypeError: Failed to fetch (all retries failed)" });
            return;
        }

        addLog("BACKGROUND:FETCH_ATTEMPT", "Fetch denemesi", {
            attempt: attemptIndex + 1,
            strategy: plan.label,
            credentials: plan.init && plan.init.credentials ? plan.init.credentials : "default",
            hasHeaders: !!(plan.init && plan.init.headers)
        });

        fetch(request.url, plan.init)
            .then((r) => {
                if (!r.ok) {
                    addLog("BACKGROUND:FETCH_ERR", "Sunucu hatası", `HTTP ${r.status} - ${request.url}`);
                    return Promise.reject(new Error("HTTP " + r.status));
                }
                return request.isBinary ? r.arrayBuffer() : r.text();
            })
            .then((d) => {
                finalizeSuccess(d);
            })
            .catch((e) => {
                const msg = e ? e.toString() : "Fetch failed";
                addLog("BACKGROUND:FETCH_FAIL", "Fetch ağ hatası", `${plan.label}: ${msg}`);
                const isNetworkTypeError = msg.includes("Failed to fetch") || msg.includes("TypeError");
                if (isNetworkTypeError && attemptIndex < plans.length - 1) {
                    attemptIndex += 1;
                    runAttempt();
                    return;
                }
                sendResponse({ success: false, error: msg });
            });
    };

    runAttempt();
    return true; 
  }

  if (request.action === "getUrl") {
      const tabId = sender.tab ? sender.tab.id : -1;
      loadTabVideos(tabId, (list) => {
          const last = list && list.length > 0 ? list[list.length - 1] : null;
          sendResponse({ url: last ? last.url : "", type: last ? last.type : "HLS" });
      });
      return true;
  }

  if (request.action === "getAllUrls") {
      const tabId = sender.tab ? sender.tab.id : -1;
      loadTabVideos(tabId, (list) => sendResponse({ videos: list || [] }));
      return true;
  }

  if (request.action === "OPEN_MAIN_UI") {
      const useIncognitoScope = !!(sender && ((sender.tab && sender.tab.incognito) || sender.incognito));
      getLegalAcceptance((legal) => {
          if (!legal.accepted) {
              sendResponse && sendResponse({ success: false, blockedByLegal: true, error: "Kullanim kosullari kabul edilmedi." });
              return;
          }
          const tabId = sender.tab.id;
          addLog("BACKGROUND:UI", "OPEN_MAIN_UI alındı", {
              tabId,
              url: request.url,
              type: request.type
          });
          chrome.tabs.sendMessage(tabId, { action: "SPAWN_UI_ON_TOP", url: request.url, type: request.type }, { frameId: 0 }).catch(()=>{});
          sendResponse && sendResponse({ success: true });
      }, useIncognitoScope);
      return true;
  }

  if (request.action === "DOWNLOAD_MP4") {
      const useIncognitoScope = !!(sender && ((sender.tab && sender.tab.incognito) || sender.incognito));
      getLegalAcceptance((legal) => {
          if (!legal.accepted) {
              sendResponse && sendResponse({ success: false, blockedByLegal: true, error: "Kullanim kosullari kabul edilmedi." });
              return;
          }
          const url = request.url;
          if (!url) { sendResponse && sendResponse({ success: false, error: "URL eksik" }); return; }
          const filename = request.filename || undefined;
          if (filename) {
              mp4FilenameOverrides[url] = filename;
          }
          // filename'i burada vermiyoruz; onDeterminingFilename ile override edeceğiz
          const options = request.saveAs ? { url, saveAs: true } : { url };
          chrome.downloads.download(options, (downloadId) => {
                  if (chrome.runtime.lastError) sendResponse && sendResponse({ success: false, error: chrome.runtime.lastError.message });
                  else sendResponse && sendResponse({ success: true, id: downloadId });
          });
      }, useIncognitoScope);
      return true;
  }

  if (request.action === "headUrl") {
      fetch(request.url, { method: 'HEAD', credentials: 'omit', cache: 'no-store' })
        .then((r) => {
            const len = r.headers.get('content-length');
            sendResponse({ success: true, status: r.status, contentLength: len ? parseInt(len, 10) : null, contentType: r.headers.get('content-type') || "" });
        }).catch((e) => { sendResponse({ success: false, error: e.toString() }); });
      return true;
  }

  // Segment/playlist boyut tahmini için: oturum çerezleri + DNR header'ları ile HEAD
  // (BANDWIDTH tahmini bazı sitelerde çok şişik olabiliyor)
  if (request.action === "headUrlAuth") {
      const url = request.url;
      if (!url) { sendResponse({ success: false, error: "URL eksik" }); return; }
      fetch(url, { method: 'HEAD', credentials: 'include', cache: 'no-store' })
        .then((r) => {
            const len = r.headers.get('content-length');
            sendResponse({
                success: true,
                status: r.status,
                ok: r.ok,
                contentLength: len ? parseInt(len, 10) : null,
                contentType: r.headers.get('content-type') || ""
            });
        })
        .catch((e) => {
            sendResponse({ success: false, error: e ? e.toString() : "HEAD failed" });
        });
      return true;
  }

  // HEAD kapalıysa: Range GET ile total size probe (1 byte)
  // Content-Range: bytes 0-0/12345
  if (request.action === "probeSizeAuth") {
      const url = request.url;
      if (!url) { sendResponse({ success: false, error: "URL eksik" }); return; }
      const headers = {};
      try { headers["Range"] = "bytes=0-0"; } catch (_e) {}
      fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers })
        .then(async (r) => {
            let total = null;
            try {
                const cr = r.headers.get("content-range") || "";
                const m = cr.match(/\/(\d+)\s*$/);
                if (m && m[1]) total = parseInt(m[1], 10);
                if (!total) {
                    const len = r.headers.get("content-length");
                    // Bazı sunucular Range'e rağmen 200 döner; o durumda content-length tüm dosya olabilir.
                    if (len) total = parseInt(len, 10);
                }
            } catch (_e) {}
            // Body'yi tüket (bazı ortamlarda bağlantıyı kapatmak için)
            try { await r.arrayBuffer(); } catch (_e) {}
            sendResponse({
                success: true,
                status: r.status,
                ok: r.ok,
                totalSize: (typeof total === "number" && isFinite(total) && total > 0) ? total : null,
                contentType: r.headers.get("content-type") || ""
            });
        })
        .catch((e) => sendResponse({ success: false, error: e ? e.toString() : "probe failed" }));
      return true;
  }
});

checkUpdateStatus();
syncNetworkInterceptionState();
refreshCorsExcludedDomainsFromRemote();
refreshForcedBlockedSitesFromRemote();

// İndirilen dosyanın adını, eğer biz MP4 için özel bir isim belirlediysek, override et
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
        const desired = mp4FilenameOverrides[item.url];
        if (desired && item && item.byExtensionId === chrome.runtime.id) {
            delete mp4FilenameOverrides[item.url];
            suggest({ filename: desired, conflictAction: "uniquify" });
            return;
        }
    } catch (_e) {}
    suggest(); // Değişiklik yok
});