// inject.js
(function() {
    let bugiInterceptEnabled = true;

    window.addEventListener("message", (event) => {
        try {
            if (event.source !== window) return;
            const d = event.data;
            if (!d || d.action !== "BUGIVID_SET_INTERCEPT_ENABLED") return;
            bugiInterceptEnabled = d.enabled !== false;
        } catch (_e) {}
    });

    // 1. PERFORMANS FİLTRESİ
    function shouldCheckUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const cleanUrl = url.split('?')[0].toLowerCase();
        
        // Açıkça video parçası (.ts, .m4s) veya ağır font dosyalarıysa GEÇ
        // (Bunların içinde playlist veya VTT beklemiyoruz ve boyutları büyük olabilir)
        if (/\.(ts|mp4|m4s|woff2?|woff)$/i.test(cleanUrl)) {
            return false;
        }
        // Diğer tüm istekler (jpg dahil) kontrol edilebilir;
        // bazı siteler VTT dosyalarını jpg uzantısıyla saklıyor.
        return true; 
    }

    // 2. BASE64 VE ŞİFRE KIRICI (HLS master / playlist için)
    function checkAndDecode(text) {
        if (!text || typeof text !== 'string') return null;
        const upper = text.toUpperCase();
        
        // Önce doğrudan bakalım, şifresiz düz metin mi?
        if (upper.includes('#EXTM3U') || upper.includes('#EXT-X-STREAM-INF') || upper.includes('#EXTINF:')) {
            return text; 
        }
        
        // Düz metin değilse, tam gövdenin Base64 şifreli olma ihtimalini test edelim
        let cleaned = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
        
        // Metin tamamen base64 formatına uygun mu? (Alakasız HTML veya bozuk verilerde atob() çökmesin diye)
        if (cleaned.length > 20 && !/[^A-Za-z0-9+/=]/.test(cleaned)) {
            try {
                let decoded = atob(cleaned); // Şifreyi kır
                const upperDec = decoded.toUpperCase();
                // Kırılmış halinin içinde playlist kodu var mı?
                if (upperDec.includes('#EXTM3U') || upperDec.includes('#EXT-X-STREAM-INF') || upperDec.includes('#EXTINF:')) {
                    return decoded; // Kırılmış temiz dosyayı döndür
                }
            } catch(e) {}
        }

        // Bazı siteler playlist'i JSON içinde alan olarak (gömülü base64 string) gönderiyor.
        // Bu durumda tüm gövde base64 olmayacağı için, içindeki uzun base64 adaylarını tek tek deniyoruz.
        const candidates = text.match(/[A-Za-z0-9+/=]{40,}/g);
        if (candidates) {
            for (let token of candidates) {
                let tokenClean = token.replace(/-/g, "+").replace(/_/g, "/");
                if (!tokenClean || /[^A-Za-z0-9+/=]/.test(tokenClean)) continue;
                try {
                    const decoded = atob(tokenClean);
                    const upperDec2 = decoded.toUpperCase();
                    if (upperDec2.includes('#EXTM3U') || upperDec2.includes('#EXTINF:') || upperDec2.includes('#EXT-X-STREAM-INF')) {
                        return decoded;
                    }
                } catch (e) {}
            }
        }
        
        return null; // Video listesi değilse boş dön
    }

    // 2.b WEBVTT dedektörü (altyazı için)
    function isLikelyWebVtt(text) {
        if (!text || typeof text !== 'string') return false;
        const snippet = text.slice(0, 512).trimStart();
        return snippet.startsWith("WEBVTT");
    }

    // 2.c JSON altyazı listesi (ör: wyzie / opensubtitles proxy)
    function extractSubtitleEntries(text, baseUrl) {
        if (!text || typeof text !== "string") return [];
        // Hız için önce kaba bir kontrol yap
        if (text.indexOf('"format"') === -1 || text.indexOf('"url"') === -1) return [];
        try {
            const parsed = JSON.parse(text);
            const list = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.results) ? parsed.results : []);
            if (!Array.isArray(list) || !list.length) return [];

            const out = [];
            list.forEach((item) => {
                if (!item || typeof item.url !== "string") return;
                const fmt = (item.format || "").toString().toLowerCase();
                if (fmt !== "srt" && fmt !== "vtt") return;

                let fullUrl = item.url;
                if (!/^https?:/i.test(fullUrl)) {
                    try { fullUrl = new URL(fullUrl, baseUrl).href; } catch (_e) {}
                }

                const label =
                    item.display ||
                    item.language ||
                    item.fileName ||
                    "Subtitle";
                const lang = (item.language || "").toString().toLowerCase();

                out.push({
                    url: fullUrl,
                    label,
                    lang
                });
            });
            return out;
        } catch (_e) {
            return [];
        }
    }

    const recentNetworkIssueAt = new Map(); // key -> timestamp (ms)
    const NETWORK_ISSUE_DEDUPE_MS = 5000;

    function sanitizeUrlForIssue(rawUrl) {
        try {
            const u = new URL(String(rawUrl || ""), window.location.href);
            const keys = Array.from(u.searchParams.keys()).slice(0, 10);
            const queryPart = keys.length ? `?${keys.join("&")}` : "";
            return `${u.origin}${u.pathname}${queryPart}`;
        } catch (_e) {
            return String(rawUrl || "").slice(0, 400);
        }
    }

    function reportNetworkIssue(kind, reqUrl, err) {
        const errStr = String((err && (err.message || err.toString && err.toString())) || err || "unknown");
        const low = errStr.toLowerCase();
        const isCorsLike = low.includes("failed to fetch")
            || low.includes("typeerror")
            || low.includes("cors")
            || low.includes("cross-origin")
            || low.includes("networkerror");
        if (!isCorsLike) return;

        const safeUrl = sanitizeUrlForIssue(reqUrl);
        const dedupeKey = `${kind}|${safeUrl}|${low.slice(0, 120)}`;
        const now = Date.now();
        const last = recentNetworkIssueAt.get(dedupeKey) || 0;
        if (now - last < NETWORK_ISSUE_DEDUPE_MS) return;
        recentNetworkIssueAt.set(dedupeKey, now);

        window.postMessage({
            action: "BUGIVID_NETWORK_ERROR",
            kind,
            url: safeUrl,
            message: errStr.slice(0, 500),
            pageUrl: sanitizeUrlForIssue(window.location.href),
            ts: now
        }, "*");
    }

    // 3. FETCH İSTEKLERİNİ DİNLE VE KOPYALA
    const origFetch = window.fetch;
    window.fetch = function(...args) {
        if (!bugiInterceptEnabled) {
            return origFetch.apply(this, args);
        }

        const reqPromise = origFetch.apply(this, args);
        reqPromise.then((response) => {
            try {
            let reqUrl = response.url || (args[0] && args[0].url ? args[0].url : args[0]);
            
            if (shouldCheckUrl(reqUrl)) {
                const clone = response.clone();
                clone.text().then(text => {
                    // 3.a HLS playlist yakalama
                    let playlistData = checkAndDecode(text);
                    if (playlistData) { // Eğer başarıyla kırıldıysa/bulunduysa
                        const msg = {
                            action: "BUGIVID_INTERCEPT",
                            url: reqUrl,
                            text: playlistData // Şifresi çözülmüş listeyi eklentiye gönder!
                        };
                        // Mevcut frame'e gönder
                        window.postMessage(msg, "*");
                        // Eğer iframe içindeysek, top frame'e de kopyala ki ana içerik scripti görsün
                        try {
                            if (window !== window.top) {
                                window.top.postMessage(msg, "*");
                            }
                        } catch (e) {}
                    }

                    // 3.b WEBVTT altyazı yakalama (bazı siteler .jpg gibi uzantılar kullanıyor)
                    if (isLikelyWebVtt(text)) {
                        window.postMessage({
                            action: "BUGIVID_SUB_INTERCEPT",
                            url: reqUrl,
                            text: text
                        }, "*");
                    } else {
                        // 3.c JSON altyazı listesi (ör: wyzie search API)
                        const subs = extractSubtitleEntries(text, reqUrl);
                        if (subs.length) {
                            const msg = {
                                action: "BUGIVID_SUB_LIST",
                                items: subs
                            };
                            window.postMessage(msg, "*");
                            try {
                                if (window !== window.top) {
                                    window.top.postMessage(msg, "*");
                                }
                            } catch (_e) {}
                        }
                    }
                }).catch(() => {});
            }
            } catch (_e) {}
        }).catch((e) => {
            try {
                const reqUrl = (args[0] && args[0].url) ? args[0].url : args[0];
                reportNetworkIssue("fetch", reqUrl, e);
            } catch (_e) {}
        });

        return reqPromise;
    };

    // 4. XHR İSTEKLERİNİ DİNLE (Eski tip oynatıcılar için)
    const origXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this.addEventListener('load', function() {
            try {
                if (!bugiInterceptEnabled) return;
                if (shouldCheckUrl(url)) {
                    const handleText = (text) => {
                        if (!text || typeof text !== 'string') return;

                        // 4.a HLS playlist kontrolü
                        let playlistData = checkAndDecode(text);
                        if (playlistData) {
                            let absoluteUrl = url;
                            if (!absoluteUrl.startsWith('http')) {
                                absoluteUrl = new URL(url, window.location.origin).href;
                            }
                            const msg = {
                                action: "BUGIVID_INTERCEPT",
                                url: absoluteUrl,
                                text: playlistData
                            };
                            window.postMessage(msg, "*");
                            try {
                                if (window !== window.top) {
                                    window.top.postMessage(msg, "*");
                                }
                            } catch (e) {}
                        }

                        // 4.b WEBVTT altyazı kontrolü
                        if (isLikelyWebVtt(text)) {
                            let absoluteUrl = url;
                            if (!absoluteUrl.startsWith('http')) {
                                absoluteUrl = new URL(url, window.location.origin).href;
                            }
                            window.postMessage({
                                action: "BUGIVID_SUB_INTERCEPT",
                                url: absoluteUrl,
                                text: text
                            }, "*");
                        } else {
                            // 4.c JSON altyazı listesi (XHR ile gelen)
                            const base = url.startsWith("http") ? url : window.location.origin;
                            const subs = extractSubtitleEntries(text, base);
                            if (subs.length) {
                                const msg = {
                                    action: "BUGIVID_SUB_LIST",
                                    items: subs
                                };
                                window.postMessage(msg, "*");
                                try {
                                    if (window !== window.top) {
                                        window.top.postMessage(msg, "*");
                                    }
                                } catch (_e) {}
                            }
                        }
                    };

                    // XHR responseType çoğu sitede 'text' değildir (ör: 'blob', 'arraybuffer')
                    const rt = this.responseType;
                    if (rt === '' || rt === 'text') {
                        handleText(this.responseText);
                    } else if (rt === 'blob' && this.response) {
                        try {
                            const reader = new FileReader();
                            reader.onload = () => {
                                try { handleText(String(reader.result || "")); } catch (_e) {}
                            };
                            reader.onerror = () => {};
                            reader.readAsText(this.response);
                        } catch (_e) {}
                    } else if (rt === 'arraybuffer' && this.response) {
                        try {
                            const buf = this.response;
                            const bytes = new Uint8Array(buf);
                            const decoder = new TextDecoder('utf-8');
                            handleText(decoder.decode(bytes));
                        } catch (_e) {}
                    }
                }
            } catch(e) {}
        });
        origXHR.apply(this, arguments);
    };

})(); 