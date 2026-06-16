/* global Hls, chrome, BugiI18n */
(function () {
    function pvT(key) {
        return typeof BugiI18n !== "undefined" && BugiI18n.t ? BugiI18n.t(key) : key;
    }
    function pvTf(key, vars) {
        return typeof BugiI18n !== "undefined" && BugiI18n.tf ? BugiI18n.tf(key, vars) : key;
    }

    let previewReferer = "";
    let hlsInstance = null;
    let seekDragging = false;
    let previewRangeStartSec = null;
    let previewRangeEndSec = null;
    let rangeStopHandler = null;

    function b64ToArrayBuffer(b64) {
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function newLoaderStats() {
        return {
            aborted: false,
            loaded: 0,
            retry: 0,
            total: 0,
            chunkCount: 0,
            bwEstimate: 0,
            loading: { start: 0, first: 0, end: 0 },
            parsing: { start: 0, end: 0 },
            buffering: { start: 0, first: 0, end: 0 }
        };
    }

    class BugiExtLoader {
        constructor(_config) {
            this.stats = newLoaderStats();
            this.context = null;
            this.callbacks = null;
            this._destroyed = false;
        }
        destroy() {
            this._destroyed = true;
            this.context = null;
            this.callbacks = null;
        }
        abort() {
            this._destroyed = true;
            this.stats.aborted = true;
            if (this.callbacks && this.callbacks.onAbort) {
                try {
                    this.callbacks.onAbort(this.stats, this.context, null);
                } catch (_e) {}
            }
        }
        load(context, loaderConfig, callbacks) {
            if (this._destroyed) return;
            this.callbacks = callbacks;
            this.context = context;
            this.stats = newLoaderStats();
            this.stats.loading.start = performance.now();

            const isArrayBuffer = context.responseType === "arraybuffer";
            let range;
            if (Number.isFinite(context.rangeEnd) && context.rangeEnd > 0) {
                range = `bytes=${context.rangeStart}-${context.rangeEnd - 1}`;
            }

            chrome.runtime.sendMessage(
                {
                    action: "fetchUrl",
                    url: context.url,
                    referer: previewReferer,
                    isBinary: isArrayBuffer,
                    range: range || undefined
                },
                (resp) => {
                    if (this._destroyed) return;
                    if (chrome.runtime.lastError) {
                        callbacks.onError(
                            { code: 0, text: chrome.runtime.lastError.message || "runtime" },
                            context,
                            null,
                            this.stats
                        );
                        return;
                    }
                    if (!resp || !resp.success) {
                        callbacks.onError(
                            { code: 0, text: (resp && resp.error) ? String(resp.error) : pvT("pv.requestFailed") },
                            context,
                            null,
                            this.stats
                        );
                        return;
                    }
                    const now = performance.now();
                    this.stats.loading.first = now;
                    this.stats.loading.end = now;
                    try {
                        let data;
                        if (isArrayBuffer) {
                            data = b64ToArrayBuffer(resp.data);
                            const len = data.byteLength;
                            this.stats.loaded = this.stats.total = len;
                        } else {
                            data = resp.data;
                            const len = typeof data === "string" ? data.length : 0;
                            this.stats.loaded = this.stats.total = len;
                        }
                        callbacks.onSuccess(
                            { url: context.url, data, code: 200 },
                            this.stats,
                            context,
                            null
                        );
                    } catch (e) {
                        callbacks.onError({ code: 0, text: String(e) }, context, null, this.stats);
                    }
                }
            );
        }
    }

    function fmtTime(s) {
        if (!isFinite(s) || s < 0) return "00:00";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    function updateMetaPanel(video, hls) {
        const el = document.getElementById("pvMeta");
        if (!el) return;
        const lines = [];

        lines.push("");
        if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
            lines.push(pvT("pv.metaHlsSubs"));
            hls.subtitleTracks.forEach((t, i) => {
                const name = t.name || "";
                const lang = t.lang || "";
                const lbl = [name, lang].filter(Boolean).join(" / ") || pvTf("content.subtitleN", { n: i });
                const cur = hls.subtitleTrack === i ? pvT("pv.trackCurrent") : "";
                lines.push(pvTf("pv.trackLine", { i, label: lbl, current: cur }));
            });
        }

        if (video.textTracks && video.textTracks.length) {
            lines.push("");
            lines.push(pvT("pv.metaTextTracks"));
            for (let i = 0; i < video.textTracks.length; i++) {
                const tt = video.textTracks[i];
                lines.push(`  • [${i}] kind=${tt.kind} label="${tt.label}" lang="${tt.language}" mode=${tt.mode}`);
            }
        }

        el.textContent = lines.join("\n");
    }

    function bindSeek(video) {
        const seek = document.getElementById("pvSeek");
        const timeEl = document.getElementById("pvTime");
        if (!seek || !timeEl) return;

        const tick = () => {
            const d = video.duration;
            const c = video.currentTime;
            if (!seekDragging && isFinite(d) && d > 0) {
                seek.value = String(Math.min(1000, Math.round((c / d) * 1000)));
            }
            timeEl.textContent = `${fmtTime(c)} / ${isFinite(d) ? fmtTime(d) : "--:--"}`;
        };

        video.addEventListener("timeupdate", tick);
        video.addEventListener("loadedmetadata", tick);
        video.addEventListener("durationchange", tick);

        seek.addEventListener("pointerdown", () => { seekDragging = true; });
        seek.addEventListener("pointerup", () => { seekDragging = false; tick(); });
        seek.addEventListener("input", () => {
            const d = video.duration;
            if (!isFinite(d) || d <= 0) return;
            const v = parseInt(seek.value, 10) || 0;
            video.currentTime = (v / 1000) * d;
        });
    }

    function destroyHls() {
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch (_e) {}
            hlsInstance = null;
        }
    }

    function clearRangeStopHandler(video) {
        if (!video || !rangeStopHandler) return;
        try { video.removeEventListener("timeupdate", rangeStopHandler); } catch (_e) {}
        rangeStopHandler = null;
    }

    function setupRangePlayback(video) {
        if (!video) return;
        clearRangeStopHandler(video);

        const start = Number.isFinite(previewRangeStartSec) ? Math.max(0, previewRangeStartSec) : null;
        const end = Number.isFinite(previewRangeEndSec) ? Math.max(0, previewRangeEndSec) : null;
        if (!Number.isFinite(start) && !Number.isFinite(end)) return;

        let initialSeekApplied = false;
        const applyInitialSeek = () => {
            if (initialSeekApplied) return;
            if (!Number.isFinite(start)) return;
            const d = video.duration;
            if (isFinite(d) && d > 0) {
                video.currentTime = Math.min(start, d);
            } else {
                video.currentTime = start;
            }
            initialSeekApplied = true;
        };

        video.addEventListener("loadedmetadata", applyInitialSeek, { once: true });
        video.addEventListener("canplay", applyInitialSeek, { once: true });
        setTimeout(applyInitialSeek, 0);

        if (Number.isFinite(end)) {
            rangeStopHandler = () => {
                if (video.currentTime >= end) {
                    video.pause();
                    try { video.currentTime = end; } catch (_e) {}
                }
            };
            video.addEventListener("timeupdate", rangeStopHandler);
        }
    }

    function showErr(msg) {
        const e = document.getElementById("pvErr");
        if (e) e.textContent = msg || "";
    }

    function setVideoMode(on) {
        const vb = document.getElementById("pvVideoBlock");
        const tb = document.getElementById("pvVttBlock");
        if (vb) vb.style.display = on ? "block" : "none";
        if (tb) tb.style.display = on ? "none" : "block";
    }

    function parseVttMeta(text) {
        const raw = String(text || "");
        const lines = raw.split(/\r?\n/);
        let cues = 0;
        const reCueVtt = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}\.\d{2,3}\s+-->\s+/;
        const reCueSrt = /^\s*\d{1,2}:\d{2}:\d{2},\d{2,3}\s+-->\s+/;
        for (let i = 0; i < lines.length; i++) {
            const L = lines[i];
            if (reCueVtt.test(L) || reCueSrt.test(L)) cues++;
        }
        const hasWebVtt = /^\s*WEBVTT/i.test(raw.trim());
        return { cues, hasWebVtt, bytes: raw.length };
    }

    function startVttPreview(url) {
        setVideoMode(false);
        showErr("");
        const metaEl = document.getElementById("pvVttMeta");
        const pre = document.getElementById("pvVttText");
        if (metaEl) metaEl.textContent = pvT("pv.loading");
        if (pre) pre.textContent = "";

        chrome.runtime.sendMessage(
            { action: "fetchUrl", url, referer: previewReferer },
            (resp) => {
                if (chrome.runtime.lastError) {
                    showErr(chrome.runtime.lastError.message || "runtime");
                    if (metaEl) metaEl.textContent = "";
                    return;
                }
                if (!resp || !resp.success) {
                    showErr((resp && resp.error) ? String(resp.error) : pvT("pv.requestFailed"));
                    if (metaEl) metaEl.textContent = "";
                    return;
                }
                let text = typeof resp.data === "string" ? resp.data : String(resp.data || "");
                if (text.length > 800000) {
                    text = text.slice(0, 800000) + pvT("pv.textTruncated");
                }
                const info = parseVttMeta(text);
                if (metaEl) {
                    const parts = [];
                    parts.push(pvTf("pv.vttMetaSize", { n: info.bytes }));
                    if (info.hasWebVtt) parts.push(pvT("pv.vttMetaWebvttYes"));
                    else parts.push(pvT("pv.vttMetaWebvttNo"));
                    parts.push(pvTf("pv.vttMetaCues", { n: info.cues }));
                    metaEl.textContent = parts.join(" · ");
                }
                if (pre) pre.textContent = text;
            }
        );
    }

    function startPreview(url, mode) {
        const video = document.getElementById("pvVideo");
        const meta = document.getElementById("pvMeta");
        if (!video) return;
        setVideoMode(true);
        showErr("");
        if (meta) meta.textContent = pvT("pv.loading");
        video.pause();
        video.removeAttribute("src");
        video.load();
        destroyHls();
        clearRangeStopHandler(video);

        bindSeek(video);
        setupRangePlayback(video);

        if (mode === "mp4") {
            video.src = url;
            video.play().catch(() => {});
            video.addEventListener("loadeddata", () => updateMetaPanel(video, null), { once: true });
            return;
        }

        if (typeof Hls === "undefined") {
            showErr(pvT("pv.hlsJsMissing"));
            return;
        }

        if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
                video.src = url;
                video.play().catch(() => {});
                return;
            }
            showErr(pvT("pv.hlsNotSupported"));
            return;
        }

        hlsInstance = new Hls({
            loader: BugiExtLoader,
            enableWorker: true,
            lowLatencyMode: false
        });

        hlsInstance.on(Hls.Events.ERROR, (_evt, data) => {
            if (data && data.fatal) {
                showErr(pvTf("pv.hlsFatal", { type: data.type, details: data.details || "" }));
            }
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            updateMetaPanel(video, hlsInstance);
            video.play().catch(() => {});
        });
        hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => updateMetaPanel(video, hlsInstance));
        hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => updateMetaPanel(video, hlsInstance));

        video.addEventListener("addtrack", () => updateMetaPanel(video, hlsInstance));

        hlsInstance.attachMedia(video);
        hlsInstance.loadSource(url);
    }

    window.addEventListener("message", (event) => {
        const d = event.data;
        if (!d || d.type !== "BUGI_PREVIEW_INIT") return;
        previewReferer = d.referer || "";
        previewRangeStartSec = Number.isFinite(d.rangeStartSec) ? d.rangeStartSec : null;
        previewRangeEndSec = Number.isFinite(d.rangeEndSec) ? d.rangeEndSec : null;
        if (Number.isFinite(previewRangeStartSec) && Number.isFinite(previewRangeEndSec) && previewRangeEndSec <= previewRangeStartSec) {
            previewRangeStartSec = null;
            previewRangeEndSec = null;
        }
        const url = d.url;
        if (!url) return;
        if (d.mode === "vtt") {
            startVttPreview(url);
            return;
        }
        const mode = d.mode === "mp4" ? "mp4" : "hls";
        startPreview(url, mode);
    });

    const PREVIEW_NUDGE_SEC = 1;

    document.addEventListener("keydown", (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const code = e.code;
        if (code !== "KeyZ" && code !== "KeyX") return;

        const vb = document.getElementById("pvVideoBlock");
        if (!vb || vb.style.display === "none") return;

        const video = document.getElementById("pvVideo");
        if (!video) return;

        const ae = document.activeElement;
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) {
            return;
        }

        let t = video.currentTime;
        const dur = video.duration;
        if (code === "KeyZ") {
            t = Math.max(0, t - PREVIEW_NUDGE_SEC);
            e.preventDefault();
        } else {
            if (isFinite(dur) && dur > 0) {
                t = Math.min(dur, t + PREVIEW_NUDGE_SEC);
            } else {
                t = t + PREVIEW_NUDGE_SEC;
            }
            e.preventDefault();
        }
        video.currentTime = t;
    });
})();
