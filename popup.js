document.addEventListener('DOMContentLoaded', () => {
    void (async () => {
        try {
            await BugiI18n.initFromStorage();
            BugiI18n.applyDom(document.body);
        } catch (_e) {}
        runPopupMain();
    })();
});

function runPopupMain() {
    chrome.runtime.sendMessage({ action: "REFRESH_REMOTE_CONFIG_NOW" }, () => {});

    const powerCheckbox = document.getElementById('main-power-checkbox');
    const powerText = document.getElementById('main-power-text');
    const mainContentSection = document.getElementById('main-content-section');

    const btnDebug = document.getElementById('btn-debug-log'); // YENİ: Log butonu
    let isDebug = false;

    const inpConcurrency = document.getElementById('concurrency-input');
    const btnSaveConcurrency = document.getElementById('btn-save-concurrency');
    const msgConcurrency = document.getElementById('concurrency-msg');

    const btnAddSite = document.getElementById('btn-add-site');
    const btnShowList = document.getElementById('btn-show-list');
    const listContainer = document.getElementById('blacklist-container');
    const msgBlacklist = document.getElementById('blacklist-msg');
    
    const videoContainer = document.getElementById('video-list-container');
    const mediaExtraContainer = document.getElementById('media-extra-container');
    const devCheckbox = document.getElementById('dev-mode-checkbox');
    const videoPlaceholder = document.getElementById('video-list-placeholder');
    const btnClearMedia = document.getElementById('btn-clear-media');
    const forceVideoHuntCheckbox = document.getElementById('force-video-hunt-checkbox');

    const customMasterInput = document.getElementById('custom-master-url');
    const btnDownloadCustomUrl = document.getElementById('btn-download-custom-url');

    const addedAudioUrls = new Set();
    const addedSubUrls = new Set();
    const detectedMasterUrls = new Set();
    const detectedNormalUrls = new Set();
    let popupBadgeTabId = -1;

    const btnOpenDM = document.getElementById('btn-open-download-manager');
    const notifSelect = document.getElementById('notif-sound-select');
    const notifVolume = document.getElementById('notif-volume');
    const notifTestBtn = document.getElementById('notif-test-btn');
    const notifAddBtn = document.getElementById('notif-add-btn');
    const notifRemoveBtn = document.getElementById('notif-remove-btn');
    const updateBanner = document.getElementById('update-banner');
    const updateBannerMessage = document.getElementById('update-banner-message');
    const updateDownloadBtn = document.getElementById('update-download-btn');
    const updateRefreshBtn = document.getElementById('update-refresh-btn');
    const legalBackdrop = document.getElementById('legal-modal-backdrop');
    const legalTextEl = document.getElementById('legal-text');
    const legalAcceptTermsCheckbox = document.getElementById('legal-accept-terms-checkbox');
    const legalAcceptPrivacyCheckbox = document.getElementById('legal-accept-privacy-checkbox');
    const legalAcceptBtn = document.getElementById('legal-accept-btn');
    const legalDeclineBtn = document.getElementById('legal-decline-btn');
    const legalOpenTermsBtn = document.getElementById('legal-open-terms');
    const legalOpenPrivacyBtn = document.getElementById('legal-open-privacy');
    const popupSettingsDeveloper = document.getElementById('popup-settings-developer');

    const reportCookiesChk = document.getElementById("report-include-cookies-checkbox");
    const blockedSiteBanner = document.getElementById("blocked-site-banner");

    const FORCED_BLOCKED_SITES_REMOTE_KEY = "forcedBlockedSitesRemote";
    const STOR_KEYS_BUG = [
        "extensionEnabled",
        "devMode",
        "maxConcurrent",
        "notifSoundKey",
        "notifVolume",
        "blockedSites",
        "reportIncludeCookies",
        "forceVideoHunt",
        "uiLocale"
    ];

    function applyDeveloperPanelsVisibility(enabled) {
        if (!popupSettingsDeveloper) return;
        popupSettingsDeveloper.classList.toggle('popup-dev-hidden', !enabled);
    }

    const POPUP_ACTIVE_TAB_SESSION_KEY = "bugiPopupActiveTab";

    function setupPopupTabs() {
        const tabs = document.querySelectorAll('[data-popup-tab]');
        const panels = document.querySelectorAll('.popup-tab-panel');
        if (!tabs.length || !panels.length) return;
        const activateTab = (name) => {
            tabs.forEach((t) => {
                const sel = t.getAttribute('data-popup-tab') === name;
                t.classList.toggle('active', sel);
                t.setAttribute('aria-selected', sel ? 'true' : 'false');
            });
            panels.forEach((p) => {
                const sel = p.id === 'panel-' + name;
                p.classList.toggle('active', sel);
                if (sel) p.removeAttribute('hidden');
                else p.setAttribute('hidden', '');
            });
            try { sessionStorage.setItem(POPUP_ACTIVE_TAB_SESSION_KEY, name); } catch (_e) {}
        };
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const name = tab.getAttribute('data-popup-tab');
                activateTab(name || "media");
            });
        });
        let remembered = "media";
        try {
            remembered = sessionStorage.getItem(POPUP_ACTIVE_TAB_SESSION_KEY) || "media";
        } catch (_e) {}
        const hasRemembered = Array.from(tabs).some((t) => t.getAttribute('data-popup-tab') === remembered);
        activateTab(hasRemembered ? remembered : "media");
    }

    const BUILT_IN_NOTIFICATION_SOUNDS = [
        // Buradaki dosya adlarını kendi koyduğun ses dosyalarına göre güncelleyebilirsin
        { key: "Tuturu", label: "Tutturu", file: "sounds/Tuturu.mp3", kind: "builtin" },
        { key: "kururin", label: "Kurukru", file: "sounds/kururin.mp3", kind: "builtin" }
    ];
    let customNotificationSounds = []; // { key, label, dataUrl, kind: "custom" } dizisi
    let availableNotificationSounds = BUILT_IN_NOTIFICATION_SOUNDS.slice();

    let currentNotifSoundKey = 'Tuturu';
    let currentNotifVolume = 0.8; // 0-1 arası
    let legalAccepted = false;
    const FORCED_BLOCKED_SITES_FALLBACK = [
        "www.youtube.com",
        "netflix.com",
        "disneyplus.com",
        "primevideo.com",
        "hulu.com",
        "max.com",
        "hbomax.com",
        "tv.apple.com"
    ];
    let forcedBlockedSites = FORCED_BLOCKED_SITES_FALLBACK.slice();
    const LEGAL_INCOGNITO = !!(chrome.extension && chrome.extension.inIncognitoContext);

    setupPopupTabs();

    function initUiLocaleSelect() {
        const sel = document.getElementById("ui-locale-select");
        if (!sel || typeof BugiI18n === "undefined") return;
        sel.innerHTML = "";
        BugiI18n.LOCALES.forEach((L) => {
            const o = document.createElement("option");
            o.value = L.code;
            o.textContent = L.label;
            sel.appendChild(o);
        });
        sel.value = BugiI18n.getLocale();
        sel.addEventListener("change", () => {
            const v = BugiI18n.normalizeLocale(sel.value);
            try {
                const activeTabBtn = document.querySelector('.popup-tab.active[data-popup-tab]');
                const activeName = activeTabBtn ? activeTabBtn.getAttribute('data-popup-tab') : "media";
                sessionStorage.setItem(POPUP_ACTIVE_TAB_SESSION_KEY, activeName || "media");
            } catch (_e) {}
            chrome.storage.local.set({ uiLocale: v }, () => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const tab = tabs && tabs[0];
                    if (tab && typeof tab.id === "number" && tab.url && /^https?:/i.test(tab.url)) {
                        chrome.tabs.reload(tab.id);
                    }
                    setTimeout(() => location.reload(), 150);
                });
            });
        });
    }
    initUiLocaleSelect();

    function withForcedBlockedSite(list) {
        const next = Array.isArray(list) ? list.slice() : [];
        forcedBlockedSites.forEach((site) => {
            if (!next.includes(site)) next.push(site);
        });
        return next;
    }

    function isHostBlocked(hostname, blockedList) {
        const host = String(hostname || "").toLowerCase();
        if (!host) return false;
        const list = Array.isArray(blockedList) ? blockedList : [];
        return list.some((frag) => {
            const f = String(frag || "").trim().toLowerCase();
            return !!f && host.includes(f);
        });
    }

    function refreshLegalSummaryInModal() {
        if (legalTextEl) legalTextEl.textContent = BugiI18n.t("legal.summary");
    }

    function showLegalModal() {
        if (!legalBackdrop) return;
        refreshLegalSummaryInModal();
        legalBackdrop.classList.add('show');
    }

    function hideLegalModal() {
        if (!legalBackdrop) return;
        legalBackdrop.classList.remove('show');
    }

    function requireLegalAcceptance() {
        if (legalAccepted) return true;
        showLegalModal();
        alert(BugiI18n.t("alert.legalRequiredDownload"));
        return false;
    }

    function refreshLegalStatus() {
        chrome.runtime.sendMessage({ action: "GET_LEGAL_STATUS", incognito: LEGAL_INCOGNITO }, (resp) => {
            legalAccepted = !!(resp && resp.accepted);
            if (!legalAccepted) showLegalModal();
            else hideLegalModal();
        });
    }

    function renderUpdateBanner(status) {
        if (!updateBanner) return;
        const hasUpdate = !!(status && status.hasUpdate);
        if (!hasUpdate) {
            updateBanner.classList.remove('show');
            return;
        }

        const msg = (status && status.message) ? status.message : BugiI18n.t("update.defaultMsg");
        if (updateBannerMessage) updateBannerMessage.textContent = msg;
        if (updateDownloadBtn) {
            updateDownloadBtn.disabled = !(status && status.downloadUrl);
            updateDownloadBtn.title = status && status.downloadUrl ? "" : BugiI18n.t("update.downloadTitleMissing");
        }
        updateBanner.classList.add('show');
    }

    function updateDetectedCounterUI() {
        const masterCount = detectedMasterUrls.size;
        const normalCount = detectedNormalUrls.size;
        const badgeCount = masterCount > 0 ? masterCount : normalCount;
        const hasBadge = badgeCount > 0;
        const badgeText = hasBadge ? String(Math.min(999, badgeCount)) : "";
        const badgeColor = masterCount > 0 ? "#e67e22" : "#43a047";
        const badgeTitle =
            masterCount > 0
                ? BugiI18n.tf("badge.master", { n: masterCount })
                : BugiI18n.tf("badge.playlist", { n: normalCount });
        try {
            if (typeof popupBadgeTabId === "number" && popupBadgeTabId >= 0) {
                chrome.action.setBadgeText({ tabId: popupBadgeTabId, text: badgeText });
                if (hasBadge) chrome.action.setBadgeBackgroundColor({ tabId: popupBadgeTabId, color: badgeColor });
                chrome.action.setTitle({
                    tabId: popupBadgeTabId,
                    title: hasBadge ? `${BugiI18n.t("badge.extensionTitle")} — ${badgeTitle}` : BugiI18n.t("badge.extensionTitle")
                });
            }
        } catch (_e) {}
    }

    function markDetectedMaster(url) {
        if (!url) return;
        detectedMasterUrls.add(url);
        updateDetectedCounterUI();
    }

    function markDetectedNormal(url) {
        if (!url) return;
        if (!detectedMasterUrls.has(url)) detectedNormalUrls.add(url);
        updateDetectedCounterUI();
    }



    function requestUpdateStatus() {
        chrome.runtime.sendMessage({ action: "GET_UPDATE_STATUS" }, (resp) => {
            const status = resp && resp.status ? resp.status : null;
            renderUpdateBanner(status);
        });
    }

    // Hata Ayıklama (Debug) Yardımcısı
    function sendDebug(msg, data) {
        if(isDebug) chrome.runtime.sendMessage({action: "ADD_DEBUG_LOG", source: "POPUP", msg: msg, data: data});
    }

    // Ayarları Oku
    chrome.storage.local.get(['blockedSites', 'maxConcurrent', 'devMode', 'extensionEnabled', 'forceVideoHunt', 'isDebugActive', 'notifSoundKey', 'notifVolume', 'notifCustomSounds', 'reportIncludeCookies', FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
        const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? res[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
        forcedBlockedSites = Array.from(new Set(FORCED_BLOCKED_SITES_FALLBACK.concat(remoteForced)));
        const normalizedBlocked = withForcedBlockedSite(res.blockedSites);
        if (JSON.stringify(normalizedBlocked) !== JSON.stringify(res.blockedSites || [])) {
            chrome.storage.local.set({ blockedSites: normalizedBlocked });
        }
        if (inpConcurrency) inpConcurrency.value = res.maxConcurrent || 8;
        if (devCheckbox) {
            const enabled = !!res.devMode;
            devCheckbox.checked = enabled;
            document.body.classList.toggle('dev-mode-on', enabled);
            applyDeveloperPanelsVisibility(enabled);
        }
        
        const isExtEnabled = res.extensionEnabled !== false; 
        if (powerCheckbox) {
            powerCheckbox.checked = isExtEnabled;
            updatePowerUI(isExtEnabled);
        }
        if (forceVideoHuntCheckbox) {
            forceVideoHuntCheckbox.checked = !!res.forceVideoHunt;
        }

        // Bildirim sesi ayarlarını yükle
        if (Array.isArray(res.notifCustomSounds)) {
            customNotificationSounds = res.notifCustomSounds.map((s) => ({
                key: s.key,
                label: s.label,
                dataUrl: s.dataUrl,
                kind: "custom"
            }));
        }
        rebuildNotificationOptions();
        if (typeof res.notifSoundKey === 'string') {
            currentNotifSoundKey = res.notifSoundKey;
        } else {
            // İlk kurulum: varsayılan olarak Tutturu
            currentNotifSoundKey = "Tuturu";
            chrome.storage.local.set({ notifSoundKey: currentNotifSoundKey });
        }
        if (typeof res.notifVolume === 'number') {
            currentNotifVolume = Math.min(1, Math.max(0, res.notifVolume));
        }
        if (notifSelect) notifSelect.value = currentNotifSoundKey;
        if (notifVolume) notifVolume.value = Math.round(currentNotifVolume * 100);

        // YENİ: Log durumunu kontrol et
        isDebug = !!res.isDebugActive;
        updateDebugUI(isDebug);

        if (reportCookiesChk) reportCookiesChk.checked = res.reportIncludeCookies !== false;
    });
    refreshLegalStatus();

    if (legalAcceptBtn) {
        legalAcceptBtn.addEventListener("click", () => {
            const termsOk = !!(legalAcceptTermsCheckbox && legalAcceptTermsCheckbox.checked);
            const privacyOk = !!(legalAcceptPrivacyCheckbox && legalAcceptPrivacyCheckbox.checked);
            if (!termsOk || !privacyOk) {
                alert(BugiI18n.t("alert.legalCheckboxes"));
                return;
            }
            chrome.runtime.sendMessage({ action: "SET_LEGAL_ACCEPTED", accepted: true, incognito: LEGAL_INCOGNITO }, () => {
                legalAccepted = true;
                hideLegalModal();
            });
        });
    }
    if (legalDeclineBtn) {
        legalDeclineBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "SET_LEGAL_ACCEPTED", accepted: false, incognito: LEGAL_INCOGNITO }, () => {
                legalAccepted = false;
                if (legalAcceptTermsCheckbox) legalAcceptTermsCheckbox.checked = false;
                if (legalAcceptPrivacyCheckbox) legalAcceptPrivacyCheckbox.checked = false;
                showLegalModal();
            });
        });
    }
    if (legalOpenTermsBtn) {
        legalOpenTermsBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("legal-terms.html") });
        });
    }
    if (legalOpenPrivacyBtn) {
        legalOpenPrivacyBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("privacy-policy.html") });
        });
    }

    // YENİ: Log Butonu Tıklanma Olayı
    if (btnDebug) {
        btnDebug.onclick = () => {
            if (!isDebug) {
                // Kaydı Başlat
                chrome.storage.local.set({isDebugActive: true}, () => {
                    isDebug = true;
                    updateDebugUI(true);
                    sendDebug("Kullanıcı log kaydını başlattı.");
                });
            } else {
                // Kaydı Bitir ve İndir
                chrome.runtime.sendMessage({action: "GET_DEBUG_LOGS"}, (resp) => {
                    const logs = (resp && resp.logs) ? resp.logs : "Log verisi bulunamadı.";
                    
                    const blob = new Blob([logs], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `bugi_debug_log_${new Date().getTime()}.txt`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);

                    chrome.storage.local.set({isDebugActive: false}, () => {
                        isDebug = false;
                        updateDebugUI(false);
                    });
                });
            }
        };
    }

    function updateDebugUI(isActive) {
        if (!btnDebug) return;
        if (isActive) {
            btnDebug.innerText = BugiI18n.t("settings.debugStop");
            btnDebug.classList.add('popup-debug-btn--recording');
        } else {
            btnDebug.innerText = BugiI18n.t("settings.debugStart");
            btnDebug.classList.remove('popup-debug-btn--recording');
        }
    }

    if (updateDownloadBtn) {
        updateDownloadBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "GET_UPDATE_STATUS" }, (resp) => {
                const status = resp && resp.status ? resp.status : null;
                if (status && status.downloadUrl) {
                    chrome.tabs.create({ url: status.downloadUrl });
                } else {
                    alert(BugiI18n.t("alert.updateNoUrl"));
                }
            });
        });
    }

    if (updateRefreshBtn) {
        updateRefreshBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "CHECK_UPDATE_NOW" }, (resp) => {
                const status = resp && resp.status ? resp.status : null;
                renderUpdateBanner(status);
            });
        });
    }

    chrome.runtime.onMessage.addListener((request) => {
        if (request && request.action === "UPDATE_STATUS_CHANGED") {
            renderUpdateBanner(request.status || null);
        }
    });
    requestUpdateStatus();
    updateDetectedCounterUI();

    if (powerCheckbox) {
        powerCheckbox.onchange = () => {
            const isEnabled = powerCheckbox.checked;
            updatePowerUI(isEnabled);
            chrome.storage.local.set({ extensionEnabled: isEnabled });
        };
    }

    function updatePowerUI(isEnabled) {
        if (isEnabled) {
            powerText.innerText = BugiI18n.t("settings.extensionOn");
            powerText.className = "power-status on";
            mainContentSection.style.opacity = "1";
            mainContentSection.style.pointerEvents = "auto";
        } else {
            powerText.innerText = BugiI18n.t("settings.extensionOff");
            powerText.className = "power-status off";
            mainContentSection.style.opacity = "0.4";
            mainContentSection.style.pointerEvents = "none";
        }
    }

    if (devCheckbox) {
        devCheckbox.onchange = () => {
            const enabled = devCheckbox.checked;
            document.body.classList.toggle('dev-mode-on', enabled);
            applyDeveloperPanelsVisibility(enabled);
            chrome.storage.local.set({ devMode: enabled });
        };
    }

    if (btnOpenDM) {
        btnOpenDM.onclick = () => {
            chrome.runtime.sendMessage({ action: "OPEN_DOWNLOAD_MANAGER" });
            window.close();
        };
    }

    if (btnClearMedia) {
        btnClearMedia.onclick = () => {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                const tab = tabs && tabs[0];
                if (!tab) return;
                chrome.runtime.sendMessage({ action: "CLEAR_TAB_MEDIA", tabId: tab.id }, () => {
                    // Popup içindeki mevcut listeyi temizle
                    if (videoContainer) videoContainer.innerHTML = "";
                    if (mediaExtraContainer) mediaExtraContainer.innerHTML = "";
                    addedAudioUrls.clear();
                    addedSubUrls.clear();
                    if (videoPlaceholder) {
                        videoPlaceholder.style.display = "block";
                        videoPlaceholder.textContent = BugiI18n.t("media.placeholderCleared");
                    }
                });
            });
        };
    }

    if (forceVideoHuntCheckbox) {
        forceVideoHuntCheckbox.addEventListener("change", () => {
            const on = !!forceVideoHuntCheckbox.checked;
            chrome.storage.local.set({ forceVideoHunt: on }, () => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const tab = tabs && tabs[0];
                    if (!tab || typeof tab.id !== "number") return;
                    const u = tab.url || "";
                    if (!/^https?:/i.test(u)) return;
                    chrome.tabs.reload(tab.id);
                });
            });
        });
    }

    function rebuildNotificationOptions() {
        availableNotificationSounds = BUILT_IN_NOTIFICATION_SOUNDS.concat(customNotificationSounds);
        if (!notifSelect) return;
        notifSelect.innerHTML = '';
        availableNotificationSounds.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.key;
            opt.textContent = s.label;
            notifSelect.appendChild(opt);
        });
    }

    function getSelectedSound() {
        const key = currentNotifSoundKey;
        return availableNotificationSounds.find(s => s.key === key) || availableNotificationSounds[0];
    }

    async function playTestNotification() {
        const sound = getSelectedSound();
        if (!sound) return;
        try {
            const audio = sound.kind === "custom"
                ? new Audio(sound.dataUrl)
                : new Audio(chrome.runtime.getURL(sound.file));
            audio.volume = currentNotifVolume;
            await audio.play();
        } catch (_e) {
            // Bazı durumlarda otomatik oynatma engellenebilir; sessizce yut
        }
    }

    if (notifSelect) {
        notifSelect.addEventListener('change', () => {
            currentNotifSoundKey = notifSelect.value;
            chrome.storage.local.set({ notifSoundKey: currentNotifSoundKey });
        });
    }

    if (notifVolume) {
        notifVolume.addEventListener('input', () => {
            const v = parseInt(notifVolume.value, 10);
            const norm = isNaN(v) ? 0.8 : Math.min(100, Math.max(0, v)) / 100;
            currentNotifVolume = norm;
            chrome.storage.local.set({ notifVolume: currentNotifVolume });
        });
    }

    if (notifTestBtn) {
        notifTestBtn.addEventListener('click', () => {
            playTestNotification();
        });
    }

    if (notifRemoveBtn) {
        notifRemoveBtn.addEventListener('click', () => {
            const sound = getSelectedSound();
            if (!sound) return;
            if (sound.kind !== "custom") {
                alert(BugiI18n.t("alert.notifBuiltinDelete"));
                return;
            }
            if (!confirm(BugiI18n.tf("alert.notifRemoveConfirm", { label: sound.label }))) return;

            customNotificationSounds = customNotificationSounds.filter((s) => s.key !== sound.key);
            chrome.storage.local.set({
                notifCustomSounds: customNotificationSounds.map((s) => ({
                    key: s.key,
                    label: s.label,
                    dataUrl: s.dataUrl
                }))
            }, () => {
                rebuildNotificationOptions();
                // Eğer seçili ses silindiyse, ilk mevcut sese dön
                if (!availableNotificationSounds.some((s) => s.key === currentNotifSoundKey)) {
                    const fallback = availableNotificationSounds[0];
                    currentNotifSoundKey = fallback ? fallback.key : "";
                    chrome.storage.local.set({ notifSoundKey: currentNotifSoundKey });
                }
                if (notifSelect) notifSelect.value = currentNotifSoundKey;
            });
        });
    }

    if (notifAddBtn) {
        notifAddBtn.addEventListener('click', async () => {
            if (!window.showOpenFilePicker) {
                alert(BugiI18n.t("alert.filePickerUnsupported"));
                return;
            }
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [
                        {
                            description: "Ses Dosyaları",
                            accept: {
                                "audio/*": [".mp3", ".wav", ".ogg"]
                            }
                        }
                    ],
                    multiple: false
                });
                if (!handle) return;
                const file = await handle.getFile();
                // 512KB sınır, çok büyük ses dosyalarını engelle
                const maxSize = 512 * 1024;
                if (file.size > maxSize) {
                    alert(BugiI18n.t("alert.soundTooLarge"));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result;
                    const key = "user_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2);
                    const entry = { key, label: file.name || "Kullanıcı Sesi", dataUrl, kind: "custom" };
                    customNotificationSounds.push(entry);
                    chrome.storage.local.set({
                        notifCustomSounds: customNotificationSounds.map(s => ({ key: s.key, label: s.label, dataUrl: s.dataUrl })),
                        notifSoundKey: key
                    }, () => {
                        currentNotifSoundKey = key;
                        rebuildNotificationOptions();
                        if (notifSelect) notifSelect.value = key;
                    });
                };
                reader.readAsDataURL(file);
            } catch (e) {
                // Kullanıcı iptal ettiyse sessiz geç
            }
        });
    }

    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        const currentTabId = tabs[0].id;
        const currentTabUrl = tabs[0].url || "";
        let currentHost = "";
        try { currentHost = new URL(currentTabUrl).hostname || ""; } catch (_e) {}
        popupBadgeTabId = typeof currentTabId === "number" ? currentTabId : -1;

        sendDebug("Popup açıldı. Tab ID: " + currentTabId);

        chrome.storage.local.get(["blockedSites", FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
            const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? res[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
            forcedBlockedSites = Array.from(new Set(FORCED_BLOCKED_SITES_FALLBACK.concat(remoteForced)));
            const mergedBlocked = withForcedBlockedSite(res && res.blockedSites);
            const isBlockedSite = isHostBlocked(currentHost, mergedBlocked);
            if (blockedSiteBanner) blockedSiteBanner.classList.toggle("show", isBlockedSite);
            if (isBlockedSite) {
                // Engelli sitede popup tarafı da extension-off gibi pasif kalsın.
                if (mainContentSection) {
                    mainContentSection.style.opacity = "0.4";
                    mainContentSection.style.pointerEvents = "none";
                }
                if (videoPlaceholder) {
                    videoPlaceholder.style.display = "block";
                    videoPlaceholder.textContent = BugiI18n.t("media.placeholderNone");
                }
                if (videoContainer) videoContainer.innerHTML = "";
                if (mediaExtraContainer) mediaExtraContainer.innerHTML = "";
            }
        });

        if (btnDownloadCustomUrl && customMasterInput) {
            btnDownloadCustomUrl.onclick = () => {
                if (!requireLegalAcceptance()) return;
                const raw = (customMasterInput.value || '').trim();
                if (!raw) {
                    alert(BugiI18n.t("alert.needPlaylistUrl"));
                    return;
                }
                let url = raw;
                try {
                    const u = new URL(raw);
                    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                        alert(BugiI18n.t("alert.httpOnly"));
                        return;
                    }
                    url = u.href;
                } catch (e) {
                    alert(BugiI18n.t("alert.invalidUrl"));
                    return;
                }
                sendDebug('Harici URL ile indirme başlatılıyor', url);
                chrome.tabs.sendMessage(currentTabId, {
                    action: 'SPAWN_UI_ON_TOP',
                    url: url,
                    type: 'HLS'
                }, { frameId: 0 }, (err) => {
                    if (chrome.runtime.lastError) {
                        alert(BugiI18n.t("alert.contentScriptUnreachable"));
                        return;
                    }
                    window.close();
                });
            };
        }

        chrome.runtime.sendMessage({ action: "getDetectedVideos", tabId: currentTabId }, (response) => {
            const videos = response || [];
            sendDebug("Tespit edilen toplam URL sayısı", videos.length);

            detectedMasterUrls.clear();
            detectedNormalUrls.clear();
            addedAudioUrls.clear();
            addedSubUrls.clear();
            if (mediaExtraContainer) mediaExtraContainer.innerHTML = "";
            updateDetectedCounterUI();

            if (videos.length > 0) {
                if(videoPlaceholder) videoPlaceholder.style.display = 'none';
                if(videoContainer) {
                    videoContainer.innerHTML = "";
                    
                    const uniqueVideos = [];
                    const urls = new Set();
                    
                    videos.forEach(v => {
                        if(!urls.has(v.url)) {
                            urls.add(v.url);
                            uniqueVideos.push(v);
                        }
                    });

                    sendDebug("Ekrana basılacak benzersiz video sayısı", uniqueVideos.length);

                    uniqueVideos.forEach((v, idx) => {
                        // Sadece HLS ve MP4 için buton oluştur; diğer tipler (SUBTITLE vs.) boş buton üretmesin
                        if (v.type !== "HLS" && v.type !== "MP4") return;

                        const btn = document.createElement('button');
                        btn.className = 'btn-success';
                        btn.style.width = "100%";
                        
                        let displayName = v.title || "";
                        if (!displayName) {
                            try {
                                const u = new URL(v.url);
                                const last = u.pathname.split("/").filter(Boolean).pop() || "";
                                displayName = last || `Video ${idx + 1}`;
                            } catch (_e) {
                                displayName = `Video ${idx + 1}`;
                            }
                        }
                        
                        if (v.type === "HLS") {
                            btn.innerHTML = `⬇ ${BugiI18n.t("media.downloadPrefix")} ${displayName} <span style='font-size:10px;'> ${BugiI18n.t("media.downloadCalculating")}</span>`;
                            
                            sendDebug("HLS kaliteleri için istek atılıyor", v.url);

                            // Önce inject.js/content.js tarafından yakalanmış bir playlist var mı diye sor
                            chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: v.url }, async (inter) => {
                                const hasIntercept = inter && inter.found && inter.body;
                                if (hasIntercept) {
                                    sendDebug("Intercept edilmiş playlist popup tarafından kullanılıyor", v.url);

                                    let playlistData = tryDecodeBase64Playlist(inter.body);
                                    let masterText = playlistData; 

                                    // Master içindeki dublaj parçalarını background meta'sına kaydet
                                    registerAudioTracksFromPlaylist(masterText, v.url);
                                    
                                    // Eğer base64 başarısız olmuşsa bunu logla
                                    if(!playlistData.includes("#EXTM3U")) {
                                        sendDebug("KRİTİK HATA: M3U8 çözümlenemedi veya formata uymuyor!", playlistData.substring(0,200));
                                    }

                                    let qualityCount = 0;
                                    let totalDuration = 0;
                                    let segCount = 0;

                                    const matches = playlistData.match(/#EXT-X-STREAM-INF/g);
                                    qualityCount = matches ? matches.length : (playlistData.includes("#EXTINF:") ? 1 : 0);
                                    sendDebug("Bulunan Kalite Sayısı", qualityCount);
                                    if (playlistData.includes("#EXT-X-STREAM-INF")) markDetectedMaster(v.url);
                                    else if (playlistData.includes("#EXTINF:")) markDetectedNormal(v.url);
                                    else markDetectedNormal(v.url);
                                    
                                    if (playlistData.includes("#EXT-X-STREAM-INF")) {
                                        const lines = playlistData.split(/\r?\n/);
                                        let innerUrl = lines.find((l, index) => index > 0 && lines[index-1].includes("#EXT-X-STREAM-INF") && !l.startsWith("#"));
                                        if (innerUrl) {
                                            if (!innerUrl.startsWith("http")) innerUrl = new URL(innerUrl.trim(), v.url).href;
                                            sendDebug("İç kalite dosyası için istek atılıyor", innerUrl);

                                            // Önce intercept edilmiş iç playlist var mı diye bak
                                            const innerFromIntercept = await new Promise(r => chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: innerUrl }, r));
                                            if (innerFromIntercept && innerFromIntercept.found && innerFromIntercept.body) {
                                                playlistData = tryDecodeBase64Playlist(innerFromIntercept.body);
                                                sendDebug("İç kalite dosyası intercept üzerinden alındı.");
                                            } else {
                                                // Yoksa son çare fetchUrl
                                                const innerResp = await new Promise(r => chrome.runtime.sendMessage({ action: "fetchUrl", url: innerUrl }, r));
                                                if (innerResp && innerResp.success) {
                                                    playlistData = tryDecodeBase64Playlist(innerResp.data);
                                                    sendDebug("İç kalite dosyası background fetch ile alındı.");
                                                } else {
                                                    sendDebug("İç kalite dosyası alınamadı!", innerResp && innerResp.error);
                                                }
                                            }
                                        }
                                    }

                                    const segmentMatches = playlistData.match(/#EXTINF:([\d\.]+)/g);
                                    if (segmentMatches) {
                                        segCount = segmentMatches.length;
                                        segmentMatches.forEach(match => totalDuration += parseFloat(match.split(":")[1]));
                                    }

                                    applyPopupQualityButtonInnerHtml(btn, displayName, qualityCount, totalDuration, segCount, v);
                                } else {
                                    // Intercept yoksa, eski davranış: background'dan çekmeyi dene
                                    chrome.runtime.sendMessage({ action: "fetchUrl", url: v.url }, async (resp) => {
                                        if (resp && resp.success && resp.data) {
                                            sendDebug("HLS dosyası çekildi. Çözümleme deneniyor.", "Veri uzunluğu: " + resp.data.length);

                                            let playlistData = tryDecodeBase64Playlist(resp.data);
                                            let masterText = playlistData; 

                                            // Master içindeki dublaj parçalarını background meta'sına kaydet
                                            registerAudioTracksFromPlaylist(masterText, v.url);

                                            // Eğer base64 başarısız olmuşsa bunu logla
                                            if(!playlistData.includes("#EXTM3U")) {
                                                sendDebug("KRİTİK HATA: M3U8 çözümlenemedi veya formata uymuyor!", playlistData.substring(0,200));
                                            }

                                            let qualityCount = 0;
                                            let totalDuration = 0;
                                            let segCount = 0;

                                            const matches = playlistData.match(/#EXT-X-STREAM-INF/g);
                                            qualityCount = matches ? matches.length : (playlistData.includes("#EXTINF:") ? 1 : 0);
                                            sendDebug("Bulunan Kalite Sayısı", qualityCount);
                                            if (playlistData.includes("#EXT-X-STREAM-INF")) markDetectedMaster(v.url);
                                            else if (playlistData.includes("#EXTINF:")) markDetectedNormal(v.url);
                                            else markDetectedNormal(v.url);
                                            
                                            if (playlistData.includes("#EXT-X-STREAM-INF")) {
                                                const lines = playlistData.split(/\r?\n/);
                                                let innerUrl = lines.find((l, index) => index > 0 && lines[index-1].includes("#EXT-X-STREAM-INF") && !l.startsWith("#"));
                                                if (innerUrl) {
                                                    if (!innerUrl.startsWith("http")) innerUrl = new URL(innerUrl.trim(), v.url).href;
                                                    sendDebug("İç kalite dosyası için istek atılıyor", innerUrl);

                                                    // Önce intercept edilmiş iç playlist var mı diye bak
                                                    const innerFromIntercept = await new Promise(r => chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_PLAYLIST", url: innerUrl }, r));
                                                    if (innerFromIntercept && innerFromIntercept.found && innerFromIntercept.body) {
                                                        playlistData = tryDecodeBase64Playlist(innerFromIntercept.body);
                                                        sendDebug("İç kalite dosyası intercept üzerinden alındı.");
                                                    } else {
                                                        // Yoksa son çare fetchUrl
                                                        const innerResp = await new Promise(r => chrome.runtime.sendMessage({ action: "fetchUrl", url: innerUrl }, r));
                                                        if (innerResp && innerResp.success) {
                                                            playlistData = tryDecodeBase64Playlist(innerResp.data);
                                                            sendDebug("İç kalite dosyası background fetch ile alındı.");
                                                        } else {
                                                            sendDebug("İç kalite dosyası alınamadı!", innerResp && innerResp.error);
                                                        }
                                                    }
                                                }
                                            }

                                            const segmentMatches = playlistData.match(/#EXTINF:([\d\.]+)/g);
                                            if (segmentMatches) {
                                                segCount = segmentMatches.length;
                                                segmentMatches.forEach(match => totalDuration += parseFloat(match.split(":")[1]));
                                            }

                                            applyPopupQualityButtonInnerHtml(btn, displayName, qualityCount, totalDuration, segCount, v);
                                        } else {
                                            sendDebug("HATA: HLS dosyası çekilemedi.", resp && resp.error);
                                            markDetectedNormal(v.url);
                                        }
                                    });
                                }
                            });
                        } else if (v.type === "MP4") {
                             markDetectedNormal(v.url);
                             const pMp4 = BugiI18n.t("media.downloadPrefix");
                             const mp4Block = BugiI18n.t("media.downloadMp4Block");
                             btn.innerHTML = `⬇ ${pMp4} ${displayName} <span style='font-size:10px;'> ${BugiI18n.t("media.downloadSizeCalc")}</span><br><span style='font-size:11px; color:#a5d6a7;'>🎬 ${mp4Block}</span>` + buildDevInfoHtml(v);

                             chrome.runtime.sendMessage({ action: "headUrl", url: v.url }, (resp) => {
                                 if (resp && resp.success && resp.contentLength) {
                                     const sizeStr = formatBytes(resp.contentLength);
                                     btn.innerHTML = `⬇ ${pMp4} ${displayName} <span style='font-size:10px;'> (~${sizeStr})</span><br><span style='font-size:11px; color:#a5d6a7;'>🎬 ${mp4Block}</span>` + buildDevInfoHtml(v);
                                 }
                             });
                        }

                        btn.onclick = () => {
                            if (!requireLegalAcceptance()) return;
                            if (v.type === "MP4") {
                                // MP4 için önce indirme yöneticisine iş kaydet
                                chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                                    const activeTab = tabs && tabs[0];
                                    const pageUrl = activeTab && activeTab.url ? activeTab.url : "";
                                    const pageTitle = activeTab && activeTab.title ? activeTab.title : "";
                                    const jobId = Date.now().toString() + "_" + Math.random().toString(16).slice(2);
                                    const job = {
                                        id: jobId,
                                        title: pageTitle || displayName,
                                        pageTitle,
                                        sourceUrl: v.url,
                                        pageUrl,
                                        isAudio: false,
                                        isMp4: true,
                                        audioLang: "",
                                        createdAt: Date.now(),
                                        totalDuration: 0,
                                        segments: []
                                    };
                                    chrome.runtime.sendMessage({ action: "REGISTER_DOWNLOAD_JOB", job }, () => {
                                        chrome.runtime.sendMessage({ action: "OPEN_DOWNLOAD_MANAGER" });
                                        window.close();
                                    });
                                });
                            } else {
                                sendDebug("Kullanıcı İndir Butonuna Tıkladı UI için Content.js'ye mesaj yollanıyor", v.url);
                                chrome.tabs.sendMessage(currentTabId, { 
                                    action: "SPAWN_UI_ON_TOP", 
                                    url: v.url, 
                                    type: v.type 
                                }, { frameId: 0 });
                                window.close(); 
                            }
                        };
                        videoContainer.appendChild(btn);
                    });

                }
            } else {
                sendDebug("Hiç video URL'si bulunamadı.");
            }

            // Video olmasa da meta yakalanmış olabilir (özellikle subtitle/audio)
            if (mediaExtraContainer) {
                chrome.runtime.sendMessage({ action: "GET_TAB_MEDIA_META", tabId: currentTabId }, (meta) => {
                    if (!meta) return;
                    renderMediaMeta(mediaExtraContainer, currentTabId, meta);
                });
            }
        });
    });

    if (btnSaveConcurrency) {
        btnSaveConcurrency.onclick = () => {
            let val = parseInt(inpConcurrency.value);
            if (val < 1) val = 1;
            if (val > 32) val = 32;
            chrome.storage.local.set({ maxConcurrent: val }, () => {
                if(msgConcurrency) {
                    msgConcurrency.style.display = 'block';
                    setTimeout(() => msgConcurrency.style.display = 'none', 2000);
                }
                chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                    if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: "UPDATE_CONCURRENCY", value: val });
                });
            });
        };
    }

    if (btnAddSite) {
        btnAddSite.onclick = () => {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                if (!tabs || !tabs.length || !tabs[0].url) {
                    alert(BugiI18n.t("alert.noActiveTab"));
                    return;
                }

                try {
                    const urlObj = new URL(tabs[0].url);
                    const domain = urlObj.hostname;

                    if (!domain || urlObj.protocol.startsWith("chrome") || urlObj.protocol.startsWith("edge") || urlObj.protocol.startsWith("opera")) {
                        alert(BugiI18n.t("alert.pageNotBlockable"));
                        return;
                    }

                    chrome.storage.local.get(['blockedSites', FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
                        const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? res[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
                        forcedBlockedSites = Array.from(new Set(FORCED_BLOCKED_SITES_FALLBACK.concat(remoteForced)));
                        let list = withForcedBlockedSite(res.blockedSites);
                        if (!Array.isArray(list)) list = [];

                        if (!list.includes(domain)) {
                            list.push(domain);
                            list = withForcedBlockedSite(list);
                            chrome.storage.local.set({ blockedSites: list }, () => {
                                if (chrome.runtime.lastError) {
                                    alert(BugiI18n.t("alert.blockError") + " " + chrome.runtime.lastError.message);
                                    return;
                                }
                                if(msgBlacklist) {
                                    msgBlacklist.innerText = BugiI18n.tf("media.blockedMsg", { domain });
                                    msgBlacklist.style.display = 'block';
                                }
                                if(listContainer && listContainer.style.display === 'block') {
                                    renderList();
                                }
                                setTimeout(() => { chrome.tabs.reload(tabs[0].id); }, 1000);
                            });
                        } else {
                            alert(BugiI18n.t("alert.siteAlreadyListed"));
                        }
                    });

                } catch (e) {
                    console.error(e);
                    alert(BugiI18n.t("alert.urlError") + " " + e.message);
                }
            });
        };
    }

    if (btnShowList) {
        btnShowList.onclick = () => {
            if (!listContainer) return;
            if (listContainer.style.display === 'none' || listContainer.style.display === '') {
                chrome.runtime.sendMessage({ action: "REFRESH_REMOTE_CONFIG_NOW" }, () => {
                    renderList();
                    listContainer.style.display = 'block';
                    btnShowList.innerText = BugiI18n.t("settings.blockListHide");
                });
            } else {
                listContainer.style.display = 'none';
                btnShowList.innerText = BugiI18n.t("settings.blockListShow");
            }
        };
    }

    function renderList() {
        if (!listContainer) return;
        chrome.storage.local.get(['blockedSites', FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
            const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? res[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
            forcedBlockedSites = Array.from(new Set(FORCED_BLOCKED_SITES_FALLBACK.concat(remoteForced)));
            const list = withForcedBlockedSite(res.blockedSites || []);
            listContainer.innerHTML = "";
            if (list.length === 0) {
                listContainer.innerHTML =
                    "<div style='color:#777;text-align:center;'>" + BugiI18n.t("media.blacklistEmpty") + "</div>";
            }

            list.forEach(site => {
                const div = document.createElement('div');
                div.className = 'list-item';
                const isForced = forcedBlockedSites.includes(site);
                const forcedMark = isForced ? " " + BugiI18n.t("media.blacklistForced") : "";
                div.innerHTML = `<span>${site}${forcedMark}</span><button class="remove-btn"${isForced ? " disabled" : ""}>✖</button>`;

                const removeBtn = div.querySelector('.remove-btn');
                if (removeBtn && isForced) removeBtn.title = BugiI18n.t("media.forcedRemoveTitle");
                if (removeBtn) {
                    removeBtn.onclick = () => {
                        if (forcedBlockedSites.includes(site)) return;
                        removeSite(site);
                    };
                }
                listContainer.appendChild(div);
            });
        });
    }

    function renderMediaMeta(container, tabId, meta) {
        const subs = meta.subtitles || [];
        const audios = meta.audios || [];

                        if (subs.length) {
            let subTitle = container.querySelector('.section-title[data-section="bugi-subs"]');
            if (!subTitle) {
                subTitle = document.createElement('div');
                subTitle.className = 'section-title';
                subTitle.setAttribute('data-section', 'bugi-subs');
                subTitle.style.marginTop = '8px';
                subTitle.textContent = BugiI18n.t("media.sectionSubtitles");
                container.appendChild(subTitle);
            }

            subs.forEach((s, idx) => {
                // Aynı isimli altyazı dosyasını (farklı host / query string olsa bile) tek kez göster
                let fileName = "";
                try {
                    const u = new URL(s.url);
                    fileName = u.pathname.split("/").filter(Boolean).pop() || "";
                } catch (_e) {
                    const clean = (s.url || "").split("?")[0];
                    fileName = clean.split("/").filter(Boolean).pop() || clean;
                }
                const labelKey = (s.label || s.lang || "").toString().trim().toLowerCase();
                const normKey = (labelKey || fileName || s.url || "").toLowerCase();
                if (addedSubUrls.has(normKey)) return;
                addedSubUrls.add(normKey);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-success';
                btn.style.flex = '1';
                btn.style.minWidth = '0';

                let baseLabel = s.label || s.lang || BugiI18n.tf("media.subtitleFallback", { n: idx + 1 });
                let linkHint = "";
                try {
                    const u = new URL(s.url);
                    const last = u.pathname.split("/").filter(Boolean).pop() || "";
                    if (last) linkHint = last;
                } catch (e) {}

                let hintHtml = "";
                if (linkHint && baseLabel.indexOf(linkHint) === -1) {
                    hintHtml = `<span class="dev-hint"> [${linkHint}]</span>`;
                }

                btn.innerHTML = `⬇ ${baseLabel}${hintHtml} <span style='font-size:10px;'>.vtt</span>`;
                btn.onclick = () => {
                    if (!requireLegalAcceptance()) return;
                    chrome.tabs.sendMessage(tabId, { action: "DOWNLOAD_SUBTITLE", track: s }, { frameId: 0 });
                };

                const row = document.createElement("div");
                row.className = "popup-media-row";
                row.appendChild(btn);

                const pvBtn = document.createElement("button");
                pvBtn.type = "button";
                pvBtn.className = "btn-success popup-preview-eye";
                pvBtn.title = BugiI18n.t("media.previewTitleSub");
                pvBtn.innerHTML = "👁";
                pvBtn.onclick = () => {
                    chrome.tabs.sendMessage(tabId, { action: "OPEN_STREAM_PREVIEW", url: s.url, mode: "vtt" }, { frameId: 0 }, () => {
                        if (chrome.runtime.lastError) {
                            alert(BugiI18n.t("alert.previewFail"));
                        }
                    });
                };
                row.appendChild(pvBtn);

                container.appendChild(row);
            });
        }

        if (audios.length) {
            let auTitle = container.querySelector('.section-title[data-section="bugi-audio"]');
            if (!auTitle) {
                auTitle = document.createElement('div');
                auTitle.className = 'section-title';
                auTitle.setAttribute('data-section', 'bugi-audio');
                auTitle.style.marginTop = '8px';
                auTitle.textContent = BugiI18n.t("media.sectionAudio");
                container.appendChild(auTitle);
            }

            audios.forEach((a, idx) => {
                // Aynı ses parçasını (farklı query string'lerle bile olsa) tek kez göster
                let normKey = a.url;
                try {
                    const u = new URL(a.url);
                    normKey = u.origin + u.pathname;
                } catch (_e) {
                    normKey = (a.url || "").split('?')[0];
                }
                if (addedAudioUrls.has(normKey)) return;
                addedAudioUrls.add(normKey);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-success';
                btn.style.flex = '1';
                btn.style.minWidth = '0';

                const parts = [];
                if (a.name) parts.push(a.name);
                if (a.lang) parts.push(a.lang);
                let label = parts.length ? parts.join(' / ') : BugiI18n.tf("media.audioTrackFallback", { n: idx + 1 });

                let linkHint = "";
                try {
                    const u = new URL(a.url);
                    const last = u.pathname.split("/").filter(Boolean).pop() || "";
                    if (last) linkHint = last;
                } catch (e) {}

                let hintHtml = "";
                if (linkHint && label.indexOf(linkHint) === -1) {
                    hintHtml = `<span class="dev-hint"> [${linkHint}]</span>`;
                }

                btn.innerHTML = `⬇ ${label}${hintHtml} <span style='font-size:10px;'>${BugiI18n.t("media.audioBadgeShort")}</span>`;
                btn.onclick = () => {
                    if (!requireLegalAcceptance()) return;
                    chrome.tabs.sendMessage(tabId, { action: "DOWNLOAD_AUDIO", track: a }, { frameId: 0 });
                    window.close();
                };

                const row = document.createElement("div");
                row.className = "popup-media-row";
                row.appendChild(btn);

                const pvBtn = document.createElement("button");
                pvBtn.type = "button";
                pvBtn.className = "btn-success popup-preview-eye";
                pvBtn.title = BugiI18n.t("media.previewTitleAudio");
                pvBtn.innerHTML = "👁";
                pvBtn.onclick = () => {
                    chrome.tabs.sendMessage(tabId, { action: "OPEN_STREAM_PREVIEW", url: a.url, mode: "hls" }, { frameId: 0 }, () => {
                        if (chrome.runtime.lastError) {
                            alert(BugiI18n.t("alert.previewFail"));
                        }
                    });
                };
                row.appendChild(pvBtn);

                container.appendChild(row);
            });
        }
    }

    function buildDevInfoHtml(v) {
        if (!v || !v.url) return "";
        const safeUrl = v.url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const type = v.type || "HLS";
        return `<div class="dev-info"><div><b>${BugiI18n.t("media.devSourceLabel")}</b><br>${safeUrl}</div><div><b>${BugiI18n.t("media.devTypeLabel")}</b> ${type}</div></div>`;
    }

    function popupMediaDurationHtml(totalDuration, segCount) {
        if (!totalDuration || totalDuration <= 0) return "";
        const h = Math.floor(totalDuration / 3600);
        const m = Math.floor((totalDuration % 3600) / 60);
        const s = Math.floor(totalDuration % 60);
        const timeStr = [h, m, s].map((val) => (val < 10 ? "0" + val : val)).join(":");
        return BugiI18n.tf("media.durationLine", { time: timeStr, segCount: String(segCount) });
    }

    function applyPopupQualityButtonInnerHtml(btn, displayName, qualityCount, totalDuration, segCount, v) {
        const d = popupMediaDurationHtml(totalDuration, segCount);
        const p = BugiI18n.t("media.downloadPrefix");
        if (qualityCount > 1) {
            btn.style.background = "#e67e22";
            btn.style.borderColor = "#d35400";
            btn.innerHTML =
                `⬇ ${p} ${displayName} <br><span style='font-size:11px; color:#fff;'>${BugiI18n.tf("media.downloadMultiStar", { n: qualityCount })}</span>${d}` +
                buildDevInfoHtml(v);
            return;
        }
        if (qualityCount === 1) {
            btn.innerHTML =
                `⬇ ${p} ${displayName} <span style='font-size:10px;'> ${BugiI18n.t("media.downloadSingle")}</span>${d}` + buildDevInfoHtml(v);
            return;
        }
        btn.innerHTML =
            `⬇ ${p} ${displayName} <span style='font-size:10px;'> ${BugiI18n.t("media.downloadNoFormat")}</span>${d}` + buildDevInfoHtml(v);
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return "0 MB";
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        const val = bytes / Math.pow(1024, i);
        const fixed = i <= 1 ? val.toFixed(0) : val.toFixed(2);
        return `${fixed} ${sizes[i]}`;
    }

    // Master playlist içinden dublaj (AUDIO) parçalarını çıkarıp background meta'sına kaydeder
    function registerAudioTracksFromPlaylist(text, baseUrl) {
        if (typeof text !== "string" || !text.includes("#EXTM3U")) return;
        const lines = text.split(/\r?\n/);
        const audios = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith("#EXT-X-MEDIA")) continue;

            const typeMatch = line.match(/TYPE=([^,]+)/);
            const type = typeMatch ? typeMatch[1].replace(/"/g, "") : "";
            if (type !== "AUDIO") continue;

            const nameMatch = line.match(/NAME="([^"]+)"/);
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = line.match(/URI="([^"]+)"/);
            const groupMatch = line.match(/GROUP-ID="([^"]+)"/);
            const uri = uriMatch ? uriMatch[1] : "";
            if (!uri) continue;

            let fullUrl = uri;
            if (!uri.startsWith("http")) {
                try {
                    fullUrl = new URL(uri, baseUrl).href;
                } catch (_e) {}
            }

            audios.push({
                url: fullUrl,
                name: nameMatch ? nameMatch[1] : "",
                lang: langMatch ? langMatch[1] : "",
                groupId: groupMatch ? groupMatch[1] : ""
            });
        }

        if (audios.length) {
            chrome.runtime.sendMessage({ action: "REGISTER_MEDIA_META", audios }).catch(() => {});
        }
    }

    function tryDecodeBase64Playlist(data) {
        if (typeof data !== "string") return data;
        const upperOrig = data.toUpperCase();
        if (upperOrig.includes("#EXTM3U") || upperOrig.includes("#EXT-X-STREAM-INF") || upperOrig.includes("#EXTINF:")) return data;
        
        let cleaned = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
        if (!cleaned || /[^A-Za-z0-9+/=]/.test(cleaned)) return data;
        
        try {
            const decoded = atob(cleaned);
            const upperDec = decoded.toUpperCase();
            if (upperDec.includes("#EXTM3U") || upperDec.includes("#EXTINF:") || upperDec.includes("#EXT-X-STREAM-INF")) {
                sendDebug("Base64 kırıldı ve Playlist bulundu!");
                return decoded;
            }
        } catch (e) {
            sendDebug("Base64 çözme hatası", e.toString());
        }
        return data;
    }

    function removeSite(siteToRemove) {
        if (forcedBlockedSites.includes(siteToRemove)) {
            alert(siteToRemove + BugiI18n.t("alert.forcedBlockRemove"));
            return;
        }
        chrome.storage.local.get(['blockedSites', FORCED_BLOCKED_SITES_REMOTE_KEY], (res) => {
            const remoteForced = Array.isArray(res && res[FORCED_BLOCKED_SITES_REMOTE_KEY]) ? res[FORCED_BLOCKED_SITES_REMOTE_KEY] : [];
            forcedBlockedSites = Array.from(new Set(FORCED_BLOCKED_SITES_FALLBACK.concat(remoteForced)));
            let list = withForcedBlockedSite(res.blockedSites || []);
            list = list.filter(site => site !== siteToRemove);
            list = withForcedBlockedSite(list);
            chrome.storage.local.set({ blockedSites: list }, () => renderList());
        });
    }

    function renderPopupSchemaList() {
        const ul = document.getElementById("popup-schema-list");
        if (!ul || typeof BugiJsonImportProfiles === "undefined") return;
        BugiJsonImportProfiles.getAllProfiles().then((profiles) => {
            ul.innerHTML = "";
            if (!profiles.length) {
                const li = document.createElement("li");
                li.textContent = BugiI18n.t("media.schemaDash");
                li.style.color = "#666";
                li.style.fontSize = "11px";
                ul.appendChild(li);
                return;
            }
            profiles.forEach((p) => {
                const li = document.createElement("li");
                const span = document.createElement("span");
                span.textContent = p.label || p.id;
                span.style.minWidth = "0";
                span.style.overflow = "hidden";
                span.style.textOverflow = "ellipsis";
                span.style.whiteSpace = "nowrap";
                span.style.flex = "1";
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = BugiI18n.t("media.remove");
                btn.className = "popup-schema-remove";
                btn.dataset.profileId = p.id;
                li.appendChild(span);
                li.appendChild(btn);
                ul.appendChild(li);
            });
        });
    }

    const popupSchemaPick = document.getElementById("popup-schema-pick");
    const popupSchemaFile = document.getElementById("popup-schema-file");
    const popupSchemaList = document.getElementById("popup-schema-list");
    if (popupSchemaPick && popupSchemaFile && typeof BugiJsonImportProfiles !== "undefined") {
        popupSchemaPick.onclick = () => popupSchemaFile.click();
        popupSchemaFile.onchange = async () => {
            const files = popupSchemaFile.files;
            if (!files || !files.length) return;
            const errs = [];
            for (let i = 0; i < files.length; i++) {
                try {
                    const raw = await files[i].text();
                    const obj = JSON.parse(raw);
                    const r = BugiJsonImportProfiles.parseProfileFromImportedJson(obj);
                    if (r.error) throw new Error(r.error);
                    await BugiJsonImportProfiles.persistProfile(r.profile);
                } catch (e) {
                    errs.push(
                        BugiI18n.tf("media.schemaImportError", {
                            name: files[i].name || "file",
                            msg: e && e.message ? e.message : String(e)
                        })
                    );
                }
            }
            popupSchemaFile.value = "";
            renderPopupSchemaList();
            if (errs.length) alert(errs.join("\n"));
        };
    }
    if (popupSchemaList && typeof BugiJsonImportProfiles !== "undefined") {
        popupSchemaList.addEventListener("click", (e) => {
            const btn = e.target.closest("button.popup-schema-remove");
            if (!btn || !popupSchemaList.contains(btn)) return;
            const id = btn.dataset.profileId;
            if (id) BugiJsonImportProfiles.removeProfile(id).then(() => renderPopupSchemaList());
        });
    }
    renderPopupSchemaList();
    if (typeof BugiJsonImportProfiles !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[BugiJsonImportProfiles.STORAGE_KEY]) renderPopupSchemaList();
        });
    }
}