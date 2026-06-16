/**
 * Full Terms & Privacy pages: content from locales/legal/<uiLocale>.json (fallback en).
 * Requires i18n.js (BugiI18n.initFromStorage + normalizeLocale/getLocale).
 */
(function () {
    function esc(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    async function fetchLegalPack(code) {
        let c = code;
        if (typeof BugiI18n !== "undefined" && BugiI18n.normalizeLocale) {
            c = BugiI18n.normalizeLocale(c);
        }
        const tryOne = async (lang) => {
            const url = chrome.runtime.getURL("locales/legal/" + lang + ".json");
            const r = await fetch(url, { cache: "no-store" });
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
        };
        try {
            return await tryOne(c);
        } catch (_e) {
            return await tryOne("en");
        }
    }

    async function main() {
        try {
            if (typeof BugiI18n !== "undefined" && BugiI18n.initFromStorage) {
                await BugiI18n.initFromStorage();
            }
        } catch (_e2) {}

        const isPrivacy = /privacy-policy\.html/i.test(window.location.pathname);
        const pack = await fetchLegalPack(
            typeof BugiI18n !== "undefined" && BugiI18n.getLocale ? BugiI18n.getLocale() : "en"
        );
        const doc = isPrivacy ? pack.privacy : pack.terms;
        if (!doc || !Array.isArray(doc.sections)) return;

        const locale =
            typeof BugiI18n !== "undefined" && BugiI18n.getLocale ? BugiI18n.getLocale() : "en";
        document.documentElement.lang = locale;
        document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";

        document.title = doc.documentTitle || doc.h1 || "";

        const root = document.getElementById("legal-root");
        if (!root) return;

        let html = "<h1>" + esc(doc.h1) + "</h1><p class=\"muted\">" + esc(doc.effective) + "</p>";
        doc.sections.forEach((sec) => {
            if (!sec || !sec.title) return;
            html += "<div class=\"box\"><h2>" + esc(sec.title) + "</h2>" + String(sec.html || "") + "</div>";
        });
        root.innerHTML = html;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => void main().catch(console.error));
    } else {
        void main().catch(console.error);
    }
})();
