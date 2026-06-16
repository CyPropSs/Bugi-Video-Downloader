/**
 * Basit i18n: locales/<kod>.json düz anahtarlar, en yedek dil.
 * Popup ve content script tarafından kullanılır.
 */
(function (global) {
    const FALLBACK = "en";

    const LOCALES = [
        { code: "en", label: "English" },
        { code: "tr", label: "Türkçe" },
        { code: "es", label: "Español" },
        { code: "fr", label: "Français" },
        { code: "de", label: "Deutsch" },
        { code: "pt", label: "Português" },
        { code: "ru", label: "Русский" },
        { code: "ja", label: "日本語" },
        { code: "zh", label: "简体中文" },
        { code: "ar", label: "العربية" }
    ];

    let dict = {};
    let current = FALLBACK;

    function normalizeLocale(code) {
        const c = String(code || "").trim().toLowerCase();
        if (!c) return FALLBACK;
        if (LOCALES.some((x) => x.code === c)) return c;
        return FALLBACK;
    }

    async function fetchLocaleFile(code) {
        const url = chrome.runtime.getURL("locales/" + code + ".json");
        try {
            const r = await fetch(url, { cache: "no-store" });
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
        } catch (_fetchErr) {
            return new Promise((resolve, reject) => {
                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open("GET", url, true);
                    xhr.onreadystatechange = function () {
                        if (xhr.readyState !== 4) return;
                        if (xhr.status >= 200 && xhr.status < 300) {
                            try {
                                resolve(JSON.parse(xhr.responseText));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(String(xhr.status)));
                        }
                    };
                    xhr.onerror = function () {
                        reject(new Error("xhr"));
                    };
                    xhr.send();
                } catch (e2) {
                    reject(e2);
                }
            });
        }
    }

    function mergeFlat(base, over) {
        const out = Object.assign({}, base || {});
        if (over && typeof over === "object") {
            Object.keys(over).forEach((k) => {
                if (over[k] != null && String(over[k]).length) out[k] = over[k];
            });
        }
        return out;
    }

    /** İlk kurulum: Chrome UI dili veya navigator dilleri → desteklenen kod; eşleşmezse en. */
    function detectBrowserUiLocale() {
        const supported = new Set(LOCALES.map((x) => x.code));
        function tryTag(raw) {
            const tag = String(raw || "")
                .trim()
                .toLowerCase()
                .replace(/_/g, "-");
            if (!tag) return null;
            const primary = tag.split("-").filter(Boolean)[0];
            if (primary && supported.has(primary)) return primary;
            return null;
        }
        try {
            if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILocale === "function") {
                const m = tryTag(chrome.i18n.getUILocale());
                if (m) return m;
            }
        } catch (_e) {}
        const candidates = [];
        if (typeof navigator !== "undefined") {
            if (Array.isArray(navigator.languages) && navigator.languages.length) {
                navigator.languages.forEach((l) => candidates.push(l));
            }
            if (navigator.language) candidates.push(navigator.language);
        }
        for (let i = 0; i < candidates.length; i++) {
            const m = tryTag(candidates[i]);
            if (m) return m;
        }
        return FALLBACK;
    }

    async function init(localeCode) {
        current = normalizeLocale(localeCode);
        let base = {};
        try {
            base = await fetchLocaleFile(FALLBACK);
        } catch (_e) {
            base = {};
        }
        let over = {};
        if (current !== FALLBACK) {
            try {
                over = await fetchLocaleFile(current);
            } catch (_e2) {
                over = {};
            }
        }
        dict = mergeFlat(base, over);
        if (typeof document !== "undefined" && document.documentElement) {
            document.documentElement.lang = current;
            document.documentElement.dir = current === "ar" ? "rtl" : "ltr";
        }
    }

    async function initFromStorage() {
        const r = await new Promise((resolve) => {
            chrome.storage.local.get(["uiLocale"], resolve);
        });
        let code;
        if (r && r.uiLocale != null && String(r.uiLocale).trim() !== "") {
            code = normalizeLocale(r.uiLocale);
        } else {
            code = detectBrowserUiLocale();
            await new Promise((resolve) => {
                chrome.storage.local.set({ uiLocale: code }, resolve);
            });
        }
        await init(code);
    }

    function t(key) {
        const k = String(key || "");
        if (dict[k] != null && dict[k] !== "") return String(dict[k]);
        return k;
    }

    function tf(key, vars) {
        let s = t(key);
        if (vars && typeof vars === "object") {
            Object.keys(vars).forEach((k) => {
                s = s.replace(new RegExp("\\{" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\}", "g"), String(vars[k]));
            });
        }
        return s;
    }

    function applyDom(root) {
        const el = root || (typeof document !== "undefined" ? document.body : null);
        if (!el || !el.querySelectorAll) return;
        el.querySelectorAll("[data-i18n]").forEach((node) => {
            const k = node.getAttribute("data-i18n");
            if (!k) return;
            const val = t(k);
            if (node.getAttribute("data-i18n-html") === "1") node.innerHTML = val;
            else node.textContent = val;
        });
        el.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
            const k = node.getAttribute("data-i18n-placeholder");
            if (k) node.setAttribute("placeholder", t(k));
        });
        el.querySelectorAll("[data-i18n-title]").forEach((node) => {
            const k = node.getAttribute("data-i18n-title");
            if (k) node.setAttribute("title", t(k));
        });
        el.querySelectorAll("[data-i18n-aria]").forEach((node) => {
            const k = node.getAttribute("data-i18n-aria");
            if (k) node.setAttribute("aria-label", t(k));
        });
    }

    global.BugiI18n = {
        LOCALES,
        FALLBACK,
        init,
        initFromStorage,
        t,
        tf,
        applyDom,
        getLocale: () => current,
        normalizeLocale,
        detectBrowserUiLocale
    };
})(typeof globalThis !== "undefined" ? globalThis : self);
