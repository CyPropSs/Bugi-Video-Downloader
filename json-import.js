/**
 * JSON video listesi içe aktarma (İndirme Yöneticisi penceresinde sayfa geneli sürükle-bırak).
 * download.js içindeki addJob / dmAnalyzeSegments / dmTryDecodeBase64Playlist ile çalışır.
 *
 * Format şeması: eklenti popup → profil seç (chrome.storage).
 *   - schemas/*.schema.json → kök type + required alanlarından eşleşme üretilir (tam JSON Schema doğrulaması değil).
 *   - Profil bugiJsonImportProfile: 2 + match + extract (alan yolları profilde).
 *   - JSON Schema → kök eşleşme + şemadaki "x-bugi-extract" ile extract.
 * Sürüklenen anime JSON: kayıtlı profiller + registerAdapter. Siteye özel alan adları koddan değil profil/şemadan gelir.
 *
 * Özel format: BugiJsonImport.registerAdapter({ id, match, build }, { prepend: true });
 */
(function (global) {
    let _addJob;
    let _dmAnalyzeSegments;
    let _dmTryDecodeBase64Playlist;

    const jmiActiveSubtitleDownloads = new Set();

    function jmiT(key) {
        return typeof BugiI18n !== "undefined" && BugiI18n.t ? BugiI18n.t(key) : key;
    }
    function jmiTf(key, vars) {
        return typeof BugiI18n !== "undefined" && BugiI18n.tf ? BugiI18n.tf(key, vars) : key;
    }

    /** @type {{ id: string, match: function, build: function }[]} */
    const jmiCustomAdapters = [];

    /** İçe aktarılan şema profillerinden üretilen adapter'lar (sırayla en önce denenir). */
    const jmiSchemaProfileAdapters = [];

    function init(deps) {
        if (!deps || typeof deps.addJob !== "function") return;
        _addJob = deps.addJob;
        _dmAnalyzeSegments = deps.dmAnalyzeSegments;
        _dmTryDecodeBase64Playlist = deps.dmTryDecodeBase64Playlist;
        reloadSchemaProfiles();
        try {
            if (typeof BugiJsonImportProfiles !== "undefined" && chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener((changes, area) => {
                    if (area !== "local" || !changes[BugiJsonImportProfiles.STORAGE_KEY]) return;
                    BugiJsonImportProfiles.getAllProfiles().then((arr) => jmiApplyStoredProfiles(arr));
                });
            }
        } catch (_e) {}
    }

    function dmSetJsonDropActive(active) {
        const overlay = document.getElementById("json-drop-overlay");
        if (!overlay) return;
        overlay.classList.toggle("active", !!active);
    }

    function dmResolutionScore(val) {
        const text = String(val || "").toLowerCase();
        const m = text.match(/(\d{3,4})p/);
        if (m && m[1]) return parseInt(m[1], 10) || 0;
        return 0;
    }

    function dmSelectPreferredStream(streams) {
        const list = Array.isArray(streams) ? streams.filter((s) => s && s.url) : [];
        if (!list.length) return null;
        const sorted = list.slice().sort((a, b) => {
            const la = String(a.language || "").toLowerCase();
            const lb = String(b.language || "").toLowerCase();
            const pa = (la === "original" || la === "orijinal") ? 1 : 0;
            const pb = (lb === "original" || lb === "orijinal") ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return dmResolutionScore(b.resolution) - dmResolutionScore(a.resolution);
        });
        return sorted[0];
    }

    function dmParseMasterPlaylistVariants(masterBody, baseUrl) {
        const lines = String(masterBody || "").split(/\r?\n/);
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            const line = (lines[i] || "").trim();
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
            const next = (lines[i + 1] || "").trim();
            if (!next || next.startsWith("#")) continue;
            let url = next;
            try { url = new URL(next, baseUrl).href; } catch (_e) {}
            const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
            const bwMatch = line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
            const height = resMatch && resMatch[2] ? parseInt(resMatch[2], 10) : 0;
            const bandwidth = bwMatch && bwMatch[1] ? parseInt(bwMatch[1], 10) : 0;
            variants.push({ url, height, bandwidth });
        }
        return variants.sort((a, b) => {
            if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
            return (b.bandwidth || 0) - (a.bandwidth || 0);
        });
    }

    async function dmFetchPlaylistText(url, referer) {
        const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: "fetchUrl", url, referer: referer || "" },
                (r) => resolve(r || null)
            );
        });
        if (!resp || !resp.success || !resp.data) return "";
        return _dmTryDecodeBase64Playlist(resp.data);
    }

    async function dmResolveImportToSegments(url, referer) {
        const firstBody = await dmFetchPlaylistText(url, referer);
        if (!firstBody) throw new Error(jmiT("jmi.errNoPlaylist"));

        let analyzedUrl = url;
        let analyzedBody = firstBody;
        let masterBody = "";
        let masterUrl = "";
        const upper = String(firstBody).toUpperCase();
        if (upper.includes("#EXT-X-STREAM-INF")) {
            masterBody = firstBody;
            masterUrl = url;
            const vars = dmParseMasterPlaylistVariants(firstBody, url);
            if (!vars.length) throw new Error(jmiT("jmi.errNoVariantInMaster"));
            analyzedUrl = vars[0].url;
            analyzedBody = await dmFetchPlaylistText(analyzedUrl, referer);
            if (!analyzedBody) throw new Error(jmiT("jmi.errChildPlaylist"));
        }

        const segs = _dmAnalyzeSegments(analyzedBody, analyzedUrl);
        if (!Array.isArray(segs) || !segs.length) throw new Error(jmiT("jmi.errNoSegments"));
        if (segs.initSegmentUrl) throw new Error(jmiT("jmi.errFm4Unsupported"));

        return {
            playlistUrl: analyzedUrl,
            segs,
            snapshot: {
                v: 1,
                masterUrl,
                masterBody,
                variantBodies: masterBody ? { [analyzedUrl]: analyzedBody } : {},
                audioBodies: {},
                analyzedUrl,
                analyzedBody,
                analyzedBw: 2000000,
                analyzedIsAudio: false,
                analyzedAudioLang: ""
            }
        };
    }

    function dmCreateImportedJob(importEntry, sourceLabel, resolved) {
        const seasonNum = parseInt(importEntry.season, 10) || 1;
        const episodeNum = parseInt(importEntry.episode, 10) || 1;
        const stream = importEntry.stream || {};
        const extra = [stream.resolution, stream.language].filter(Boolean).join(" ");
        const titleBase = `${sourceLabel} Season ${seasonNum} Episode ${episodeNum}`.trim();
        const fullTitle = extra ? `${titleBase} ${extra}` : titleBase;
        const totalDuration = resolved.segs[resolved.segs.length - 1]?.endTime || 0;
        return {
            id: Date.now().toString(36) + "_" + Math.random().toString(16).slice(2),
            title: fullTitle,
            sourceUrl: resolved.playlistUrl,
            pageUrl: stream.url || resolved.playlistUrl,
            createdAt: Date.now(),
            totalDuration,
            segments: resolved.segs.map((seg, idx) => ({
                url: seg.url,
                index: typeof seg.index === "number" ? seg.index : idx,
                duration: seg.duration
            })),
            captured: { snapshot: resolved.snapshot }
        };
    }

    function dmHumanizeImportedBaseName(fileName) {
        const base = String(fileName || "import").replace(/\.json$/i, "");
        const normalized = base
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (!normalized) return "Import";
        return normalized
            .split(" ")
            .map((w) => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w)
            .join(" ");
    }

    function dmShowImportOptionsDialog(title, options) {
        return new Promise((resolve) => {
            const langs = Array.isArray(options && options.languages) ? options.languages : [];
            const qualities = Array.isArray(options && options.qualities) ? options.qualities : [];
            const subs = Array.isArray(options && options.subtitles) ? options.subtitles : [];
            const episodes = Array.isArray(options && options.episodes) ? options.episodes : [];

            const old = document.getElementById("json-import-options-backdrop");
            if (old) old.remove();

            const backdrop = document.createElement("div");
            backdrop.id = "json-import-options-backdrop";
            backdrop.className = "modal-backdrop";
            const modal = document.createElement("div");
            modal.className = "modal";
            modal.style.minWidth = "520px";
            modal.innerHTML = `
            <div class="modal-title">${jmiT("jmi.modalTitle")}</div>
            <div class="modal-sub">${title}</div>
            <div class="modal-row"><label>${jmiT("jmi.lang")}</label><select id="json-opt-lang" style="flex:1; background:#111; color:#eee; border:1px solid #444; border-radius:4px; padding:4px;"></select></div>
            <div class="modal-row"><label>${jmiT("jmi.quality")}</label><select id="json-opt-quality" style="flex:1; background:#111; color:#eee; border:1px solid #444; border-radius:4px; padding:4px;"></select></div>
            <div class="modal-row"><label>${jmiT("jmi.subtitle")}</label><select id="json-opt-sub" style="flex:1; background:#111; color:#eee; border:1px solid #444; border-radius:4px; padding:4px;"></select></div>
            <div class="modal-row"><label></label><label style="display:flex; gap:6px; min-width:0;"><input id="json-opt-auto-sub" type="checkbox" checked>${jmiT("jmi.autoSub")}</label></div>
            <div class="modal-row"><label></label><button id="json-opt-show-episodes" style="background:#2a2a2a; color:#eee; border:1px solid #555; border-radius:4px; padding:4px 8px; cursor:pointer;">${jmiT("jmi.showEpisodes")}</button></div>
            <div id="json-episode-panel" style="display:none; margin-top:8px; border:1px solid #3a3a3a; border-radius:6px; max-height:250px; overflow:auto;">
                <div style="position:sticky; top:0; z-index:2; display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin:0; padding:8px; background:#1f1f1f; border-bottom:1px solid #333;">
                    <button id="json-ep-remove-selected" style="background:#2a2a2a; color:#eee; border:1px solid #555; border-radius:4px; padding:3px 8px; cursor:pointer;">${jmiT("jmi.removeSelected")}</button>
                    <button id="json-ep-add-selected" style="background:#2a2a2a; color:#eee; border:1px solid #555; border-radius:4px; padding:3px 8px; cursor:pointer;">${jmiT("jmi.addSelected")}</button>
                    <button id="json-ep-invert" style="background:#2a2a2a; color:#eee; border:1px solid #555; border-radius:4px; padding:3px 8px; cursor:pointer;">${jmiT("jmi.invert")}</button>
                    <span id="json-ep-count" style="font-size:11px; color:#bbb;"></span>
                </div>
                <div id="json-ep-list" style="display:grid; grid-template-columns:1fr; gap:4px; padding:8px;"></div>
            </div>
            <div class="modal-actions">
                <button id="json-opt-cancel">${jmiT("jmi.cancel")}</button>
                <button id="json-opt-ok" class="primary">${jmiT("jmi.add")}</button>
            </div>
        `;
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);

            const langSel = modal.querySelector("#json-opt-lang");
            const qualitySel = modal.querySelector("#json-opt-quality");
            const subSel = modal.querySelector("#json-opt-sub");
            const autoSubChk = modal.querySelector("#json-opt-auto-sub");
            const epShowBtn = modal.querySelector("#json-opt-show-episodes");
            const epPanel = modal.querySelector("#json-episode-panel");
            const epList = modal.querySelector("#json-ep-list");
            const epCount = modal.querySelector("#json-ep-count");

            const addOpt = (sel, val, label) => {
                const o = document.createElement("option");
                o.value = String(val);
                o.textContent = label;
                sel.appendChild(o);
            };

            const episodeKeys = episodes.map((ep) => `${parseInt(ep.season, 10) || 1}:${parseInt(ep.episode, 10) || 1}`);
            const selectedEpisodes = new Set(episodeKeys);
            const highlightedEpisodes = new Set();
            let lastClickedIndex = -1;

            const updateEpisodeCount = () => {
                if (!epCount) return;
                epCount.textContent = jmiTf("jmi.episodeCount", {
                    selected: selectedEpisodes.size,
                    total: episodeKeys.length
                });
            };
            const updateHighlightUI = () => {
                epList.querySelectorAll("[data-ep-row]").forEach((row) => {
                    const key = row.getAttribute("data-ep-key");
                    const isOn = highlightedEpisodes.has(key);
                    row.style.background = isOn ? "#21405f" : "transparent";
                    row.style.borderRadius = "4px";
                    row.style.padding = "2px 4px";
                });
            };
            const clearHighlight = () => {
                highlightedEpisodes.clear();
                updateHighlightUI();
            };
            const applyHighlightToSelection = (shouldAdd) => {
                if (!highlightedEpisodes.size) return;
                highlightedEpisodes.forEach((k) => {
                    if (shouldAdd) selectedEpisodes.add(k);
                    else selectedEpisodes.delete(k);
                    const box = epList.querySelector(`input[data-ep-key="${k}"]`);
                    if (box) box.checked = shouldAdd;
                });
                updateEpisodeCount();
            };
            const renderEpisodeUI = () => {
                if (!epList) return;
                epList.innerHTML = "";
                const sortedEpisodes = episodes
                    .slice()
                    .sort((a, b) => {
                        const sa = parseInt(a.season, 10) || 1;
                        const sb = parseInt(b.season, 10) || 1;
                        if (sa !== sb) return sa - sb;
                        return (parseInt(a.episode, 10) || 1) - (parseInt(b.episode, 10) || 1);
                    });
                sortedEpisodes.forEach((ep, idx) => {
                    const seasonNum = parseInt(ep.season, 10) || 1;
                    const episodeNum = parseInt(ep.episode, 10) || 1;
                    const key = `${seasonNum}:${episodeNum}`;
                    const row = document.createElement("label");
                    row.setAttribute("data-ep-row", "1");
                    row.setAttribute("data-ep-key", key);
                    row.setAttribute("data-ep-index", String(idx));
                    row.style.display = "flex";
                    row.style.alignItems = "center";
                    row.style.gap = "8px";
                    row.style.fontSize = "11px";
                    row.style.color = "#ddd";
                    row.style.cursor = "pointer";
                    const titleText = (ep.title || "").toString().trim();
                    row.innerHTML = `<input type="checkbox" data-ep-key="${key}" checked style="margin:0;"><span>${jmiTf("jmi.episodeRow", {
                        season: seasonNum,
                        episode: episodeNum,
                        suffix: titleText ? ` - ${titleText}` : ""
                    })}</span>`;
                    const box = row.querySelector("input");
                    box.addEventListener("change", () => {
                        if (box.checked) selectedEpisodes.add(key);
                        else selectedEpisodes.delete(key);
                        updateEpisodeCount();
                    });
                    row.addEventListener("click", (ev) => {
                        if (ev.target && ev.target.tagName && ev.target.tagName.toLowerCase() === "input") return;
                        const currentIndex = parseInt(row.getAttribute("data-ep-index"), 10) || 0;
                        if (ev.shiftKey && lastClickedIndex >= 0) {
                            highlightedEpisodes.clear();
                            const a = Math.min(lastClickedIndex, currentIndex);
                            const b = Math.max(lastClickedIndex, currentIndex);
                            for (let i = a; i <= b; i++) {
                                const epx = sortedEpisodes[i];
                                const k = `${parseInt(epx.season, 10) || 1}:${parseInt(epx.episode, 10) || 1}`;
                                highlightedEpisodes.add(k);
                            }
                        } else {
                            if (highlightedEpisodes.has(key) && highlightedEpisodes.size === 1) highlightedEpisodes.clear();
                            else {
                                highlightedEpisodes.clear();
                                highlightedEpisodes.add(key);
                            }
                            lastClickedIndex = currentIndex;
                        }
                        updateHighlightUI();
                    });
                    epList.appendChild(row);
                });
                updateEpisodeCount();
            };

            addOpt(langSel, "__all__", jmiT("jmi.allLanguages"));
            langs.forEach((l) => addOpt(langSel, l.key, l.label));
            const jpOpt = langs.find((l) => {
                const k = String(l.key || "").toLowerCase();
                const n = String(l.label || "").toLowerCase();
                return k === "original" || k === "orijinal" || n.includes("japon");
            });
            if (jpOpt) langSel.value = jpOpt.key;

            if (qualities.length) {
                qualities.forEach((q, idx) =>
                    addOpt(qualitySel, String(q), `${q}p${idx === 0 ? jmiT("jmi.recommendedSuffix") : ""}`)
                );
            } else {
                addOpt(qualitySel, "0", jmiT("jmi.autoQuality"));
            }

            addOpt(subSel, "__none__", jmiT("jmi.noSubtitleDownload"));
            addOpt(subSel, "__all__", jmiT("jmi.allSubtitles"));
            subs.forEach((s) => addOpt(subSel, s.key, s.label));

            renderEpisodeUI();
            epShowBtn.onclick = () => {
                const isOpen = epPanel.style.display !== "none";
                epPanel.style.display = isOpen ? "none" : "block";
                epShowBtn.textContent = isOpen ? jmiT("jmi.showEpisodes") : jmiT("jmi.hideEpisodes");
                if (isOpen) clearHighlight();
            };
            modal.querySelector("#json-ep-remove-selected").onclick = () => applyHighlightToSelection(false);
            modal.querySelector("#json-ep-add-selected").onclick = () => applyHighlightToSelection(true);
            modal.querySelector("#json-ep-invert").onclick = () => {
                epList.querySelectorAll('input[data-ep-key]').forEach((el) => {
                    const key = el.getAttribute("data-ep-key");
                    const next = !el.checked;
                    el.checked = next;
                    if (next) selectedEpisodes.add(key);
                    else selectedEpisodes.delete(key);
                });
                updateEpisodeCount();
            };

            modal.querySelector("#json-opt-cancel").onclick = () => {
                backdrop.remove();
                resolve(null);
            };
            backdrop.addEventListener("click", (e) => {
                if (e.target === backdrop) {
                    backdrop.remove();
                    resolve(null);
                }
            });
            modal.querySelector("#json-opt-ok").onclick = () => {
                const quality = parseInt(qualitySel.value, 10) || 0;
                const subtitle = subSel.value;
                const includeSubtitles = subtitle !== "__none__";
                const autoDownloadSubtitles = includeSubtitles && !!autoSubChk.checked;
                backdrop.remove();
                resolve({
                    language: langSel.value,
                    quality,
                    subtitle,
                    includeSubtitles,
                    autoDownloadSubtitles,
                    selectedEpisodes: Array.from(selectedEpisodes)
                });
            };
        });
    }

    function jmiPick(root, path) {
        if (path == null || path === "") return root;
        const parts = String(path).split(".").filter((seg) => seg.length);
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            if (cur == null || typeof cur !== "object") return undefined;
            cur = cur[parts[i]];
        }
        return cur;
    }

    function jmiPickLangGroup(groups, languageSel, src) {
        const list = Array.isArray(groups) ? groups : [];
        if (!list.length) return null;
        const lk = src.languageFromKey;
        const nk = src.languageLabelKey;
        const isJapaneseGroup = (g) => {
            const key = String(g && g[lk] || "").toLowerCase();
            const name = String(g && g[nk] || "").toLowerCase();
            return key === "original" || key === "orijinal" || name.includes("japon");
        };
        const jp = list.find(isJapaneseGroup);
        if (!languageSel || languageSel === "__all__") return jp || list[0];
        const target = String(languageSel).toLowerCase();
        const exact = list.find((g) => String(g && g[lk] || "").toLowerCase() === target);
        if (exact) return exact;
        return jp || list[0];
    }

    function jmiPickQualityItem(items, quality, src) {
        const urlKey = src.urlKey;
        const qKey = src.qualityKey;
        const list = (Array.isArray(items) ? items : [])
            .filter((it) => it && it[urlKey])
            .map((it) => ({ quality: parseInt(it[qKey], 10) || 0, link: it[urlKey] }));
        if (!list.length) return null;
        list.sort((a, b) => (b.quality || 0) - (a.quality || 0));
        if (!quality) return list[0];
        const exact = list.find((it) => it.quality === quality);
        if (exact) return exact;
        return list[0];
    }

    function jmiSelectSubsDynamic(subs, subtitleOption, subEx) {
        if (!subEx) return [];
        const lk = subEx.groupKey;
        const nk = subEx.nameKey;
        const urlK = subEx.linkKey;
        const list = Array.isArray(subs) ? subs.filter((s) => s && s[urlK]) : [];
        if (!list.length) return [];
        if (subtitleOption === "__all__") {
            return list.map((s) => ({
                url: s[urlK],
                label: s[nk] || s[lk] || "Subtitle",
                lang: s[lk] || ""
            }));
        }
        const one = list.find((s) => String(s[lk] || "").toLowerCase() === String(subtitleOption || "").toLowerCase());
        if (!one) return [];
        return [{ url: one[urlK], label: one[nk] || one[lk] || "Subtitle", lang: one[lk] || "" }];
    }

    async function jmiBuildNestedEpisodesMode(parsed, baseName, ex) {
        const src = ex.sources;
        if (!src || !src.containersPath || !src.variantsPath) return null;

        const eps = jmiPick(parsed, ex.episodesPath);
        if (!Array.isArray(eps) || !eps.length) return null;

        const ek = ex.episode || {};
        const sk = ek.seasonKey != null ? ek.seasonKey : "season";
        const epk = ek.episodeKey != null ? ek.episodeKey : "episode";
        const tk = ek.titleKey != null ? ek.titleKey : "title";
        const subEx = ex.subtitles;

        const langMap = new Map();
        const qualitySet = new Set();
        const subMap = new Map();

        eps.forEach((ep) => {
            const groups = jmiPick(ep, src.containersPath);
            const glist = Array.isArray(groups) ? groups : [];
            glist.forEach((g) => {
                const key = String(g && g[src.languageFromKey] || "").trim();
                if (!key) return;
                const label = (g && g[src.languageLabelKey]) ? `${g[src.languageLabelKey]} (${key})` : key;
                if (!langMap.has(key.toLowerCase())) langMap.set(key.toLowerCase(), { key, label });
                const items = jmiPick(g, src.variantsPath);
                const ilist = Array.isArray(items) ? items : [];
                ilist.forEach((it) => {
                    const q = parseInt(it && it[src.qualityKey], 10) || 0;
                    if (q > 0) qualitySet.add(q);
                });
            });
            if (subEx && subEx.listPath) {
                const subs = jmiPick(ep, subEx.listPath);
                const slist = Array.isArray(subs) ? subs : [];
                slist.forEach((s) => {
                    const key = String(s && s[subEx.groupKey] || "").trim();
                    if (!key) return;
                    const label = (s && s[subEx.nameKey]) ? `${s[subEx.nameKey]} (${key})` : key;
                    if (!subMap.has(key.toLowerCase())) subMap.set(key.toLowerCase(), { key, label });
                });
            }
        });

        const qualities = Array.from(qualitySet).sort((a, b) => b - a);
        const importOptions = await dmShowImportOptionsDialog(baseName, {
            languages: Array.from(langMap.values()),
            qualities,
            subtitles: Array.from(subMap.values()),
            episodes: eps.map((ep) => ({
                season: (ep && ep[sk]) || 1,
                episode: (ep && ep[epk]) || 1,
                title: (ep && ep[tk]) || ""
            }))
        });
        if (!importOptions) {
            return { cancelled: true };
        }
        const selectedEpSet = new Set(Array.isArray(importOptions.selectedEpisodes) ? importOptions.selectedEpisodes : []);

        const imports = [];
        eps.forEach((ep) => {
            const epKey = `${parseInt((ep && ep[sk]) || 1, 10)}:${parseInt((ep && ep[epk]) || 1, 10)}`;
            if (selectedEpSet.size && !selectedEpSet.has(epKey)) return;
            const groups = jmiPick(ep, src.containersPath);
            const chosenGroup = jmiPickLangGroup(groups, importOptions.language, src);
            if (!chosenGroup) return;
            const variantItems = jmiPick(chosenGroup, src.variantsPath);
            const chosenItem = jmiPickQualityItem(variantItems, importOptions.quality, src);
            if (!chosenItem || !chosenItem.link) return;
            const epSubs = subEx && subEx.listPath ? jmiPick(ep, subEx.listPath) : [];
            const selectedSubs = importOptions.includeSubtitles
                ? jmiSelectSubsDynamic(epSubs, importOptions.subtitle, subEx)
                : [];
            imports.push({
                season: (ep && ep[sk]) || 1,
                episode: (ep && ep[epk]) || 1,
                stream: {
                    url: chosenItem.link,
                    language: String(chosenGroup[src.languageFromKey] || chosenGroup[src.languageLabelKey] || ""),
                    resolution: chosenItem.quality ? `${chosenItem.quality}p` : "",
                    domain: (() => { try { return new URL(chosenItem.link).hostname; } catch (_e) { return ""; } })()
                },
                subtitles: selectedSubs
            });
        });

        if (!imports.length) return null;
        return { imports, importOptions };
    }

    async function jmiBuildSeasonsArrayMode(parsed, baseName, ex) {
        if (!Array.isArray(parsed) || !parsed.length) return null;
        const snKey = ex.seasonNumberKey != null ? ex.seasonNumberKey : "season";
        const epPath = ex.episodesPath;
        const enKey = ex.episodeNumberKey != null ? ex.episodeNumberKey : "episode";
        const streamsPath = ex.streamsPath;
        const urlKey = ex.streamUrlKey;
        const langKey = ex.streamLanguageKey;
        const resKey = ex.streamResolutionKey;
        if (!epPath || !streamsPath || !urlKey) return null;

        const out = [];
        parsed.forEach((seasonObj, seasonIdx) => {
            const seasonNum = seasonObj && seasonObj[snKey] != null ? seasonObj[snKey] : (seasonIdx + 1);
            const episodes = jmiPick(seasonObj, epPath);
            if (!Array.isArray(episodes)) return;
            episodes.forEach((epObj, epIdx) => {
                const epNum = epObj && epObj[enKey] != null ? epObj[enKey] : (epIdx + 1);
                const rawStreams = jmiPick(epObj, streamsPath);
                const streams = Array.isArray(rawStreams) ? rawStreams.map((s) => ({
                    url: s && s[urlKey],
                    language: s && langKey ? s[langKey] : "",
                    resolution: s && resKey ? s[resKey] : ""
                })).filter((s) => s && s.url) : [];
                const chosen = dmSelectPreferredStream(streams);
                if (!chosen || !chosen.url) return;
                out.push({
                    season: seasonNum,
                    episode: epNum,
                    stream: chosen
                });
            });
        });
        if (!out.length) return null;
        return { imports: out, importOptions: null };
    }

    async function jmiBuildFromExtractSpec(parsed, baseName, ex) {
        if (!ex || !ex.mode) return null;
        if (ex.mode === "nestedEpisodes") return jmiBuildNestedEpisodesMode(parsed, baseName, ex);
        if (ex.mode === "seasonsArray") return jmiBuildSeasonsArrayMode(parsed, baseName, ex);
        return null;
    }

    function jmiGetAdaptersInOrder() {
        return jmiSchemaProfileAdapters.concat(jmiCustomAdapters);
    }

    function jmiMatchStoredProfile(parsed, spec) {
        if (!spec || !spec.rootType) return false;
        if (spec.rootType === "object") {
            if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return false;
            const keys = Array.isArray(spec.requiredKeys) ? spec.requiredKeys : [];
            for (let i = 0; i < keys.length; i++) {
                if (!(keys[i] in parsed)) return false;
            }
            return true;
        }
        if (spec.rootType === "array") {
            if (!Array.isArray(parsed) || parsed.length === 0) return false;
            const fk = Array.isArray(spec.firstItemRequiredKeys) ? spec.firstItemRequiredKeys : [];
            if (!fk.length) return true;
            const first = parsed[0];
            if (!first || typeof first !== "object") return false;
            for (let i = 0; i < fk.length; i++) {
                if (!(fk[i] in first)) return false;
            }
            return true;
        }
        return false;
    }

    function jmiApplyStoredProfiles(profiles) {
        jmiSchemaProfileAdapters.length = 0;
        const list = Array.isArray(profiles) ? profiles : [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || p.bugiJsonImportProfile !== 2 || !p.id || !p.match || !p.extract) continue;
            const matchSpec = p.match;
            const extract = p.extract;
            jmiSchemaProfileAdapters.push({
                id: "profile:" + p.id,
                match(parsed) {
                    return jmiMatchStoredProfile(parsed, matchSpec);
                },
                build(parsed, baseName) {
                    return jmiBuildFromExtractSpec(parsed, baseName, extract);
                }
            });
        }
    }

    function reloadSchemaProfiles() {
        if (typeof BugiJsonImportProfiles === "undefined") return Promise.resolve();
        return BugiJsonImportProfiles.getAllProfiles().then((arr) => {
            jmiApplyStoredProfiles(arr);
        });
    }

    function removeSchemaProfile(profileId) {
        if (typeof BugiJsonImportProfiles === "undefined") return Promise.resolve(false);
        return BugiJsonImportProfiles.removeProfile(profileId).then((arr) => {
            jmiApplyStoredProfiles(arr);
            return true;
        });
    }

    async function jmiPersistProfile(profile) {
        if (typeof BugiJsonImportProfiles === "undefined") return;
        const arr = await BugiJsonImportProfiles.persistProfile(profile);
        jmiApplyStoredProfiles(arr);
    }

    async function importSchemaProfileFile(file) {
        const raw = await file.text();
        const obj = JSON.parse(raw);
        const r = BugiJsonImportProfiles.parseProfileFromImportedJson(obj);
        if (r.error) throw new Error(r.error);
        await jmiPersistProfile(r.profile);
        return r.profile;
    }

    /**
     * Kod ile adapter ekle. Sıra: şema profilleri → registerAdapter ile eklenenler (yerleşik otomatik eşleşme yok).
     * @param {{ id: string, match: (parsed: any) => boolean, build: (parsed: any, baseName: string) => Promise<{ imports: any[], importOptions?: any } | { cancelled: true } | null> }} adapter
     * @param {{ prepend?: boolean }} [opts] prepend: true ise listenin başına alınır (önce denenir).
     */
    function registerAdapter(adapter, opts) {
        if (!adapter || typeof adapter.id !== "string" || !adapter.id.trim()) return false;
        if (typeof adapter.match !== "function" || typeof adapter.build !== "function") return false;
        const id = adapter.id.trim();
        unregisterAdapter(id);
        const entry = { id, match: adapter.match, build: adapter.build };
        if (opts && opts.prepend) {
            jmiCustomAdapters.unshift(entry);
        } else {
            jmiCustomAdapters.push(entry);
        }
        return true;
    }

    function unregisterAdapter(id) {
        const s = String(id || "").trim();
        if (!s) return false;
        const idx = jmiCustomAdapters.findIndex((a) => a.id === s);
        if (idx < 0) return false;
        jmiCustomAdapters.splice(idx, 1);
        return true;
    }

    function listAdapters() {
        return jmiGetAdaptersInOrder().map((a) => a.id);
    }

    function dmMakeSubtitleDownloadName(job, sub) {
        let safe = (job.customTitle || job.title || "subtitle").replace(/[\\/:*?"<>|]/g, "-").trim();
        safe = safe.replace(/[\x00-\x1f]/g, "");
        if (safe.length > 120) safe = safe.substring(0, 120);
        const lang = (sub.lang || "").toString().trim();
        const suffix = lang && /^[a-z]{2,5}$/i.test(lang) ? "_" + lang.toLowerCase() : "";
        return `${safe}${suffix}.vtt`;
    }

    function dmDownloadSubtitleTrackSilent(job, sub) {
        if (!job || !sub || !sub.url) return;
        const url = sub.url;
        if (jmiActiveSubtitleDownloads.has(url)) return;
        jmiActiveSubtitleDownloads.add(url);
        const referer = job.pageUrl || "";
        chrome.runtime.sendMessage({ action: "fetchUrl", url, referer }, (resp) => {
            try {
                if (!resp || !resp.success || typeof resp.data !== "string") return;
                const blob = new Blob([resp.data], { type: "text/vtt" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = dmMakeSubtitleDownloadName(job, sub);
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    URL.revokeObjectURL(a.href);
                    a.remove();
                }, 1000);
            } catch (_e) {
                // no-op
            } finally {
                jmiActiveSubtitleDownloads.delete(url);
            }
        });
    }

    async function importJsonFiles(files) {
        if (!_addJob) return;
        const jsonFiles = Array.from(files || []).filter((f) => /\.json$/i.test(f.name || ""));
        if (!jsonFiles.length) return;

        let added = 0;
        let failed = 0;
        let noProfiles = false;

        for (const file of jsonFiles) {
            try {
                const raw = await file.text();
                const r = await jmiProcessJsonString(raw, dmHumanizeImportedBaseName(file.name || "import.json"));
                added += r.added;
                failed += r.failed;
                if (r.noProfiles) noProfiles = true;
            } catch (_e) {
                failed++;
            }
        }

        if (noProfiles) {
            alert(jmiT("jmi.alertNoSchema"));
        } else if (added || failed) {
            alert(jmiTf("jmi.importSummary", { added, failed }));
        }
    }

    async function importJsonText(raw, labelName) {
        if (!_addJob) return;
        const baseName = dmHumanizeImportedBaseName(labelName || "yapistir.json");
        let added = 0;
        let failed = 0;
        try {
            const r = await jmiProcessJsonString(raw, baseName);
            added = r.added;
            failed = r.failed;
            if (r.noProfiles) {
                alert(jmiT("jmi.alertNoSchemaPick"));
                return;
            }
        } catch (_e) {
            failed++;
        }
        if (added || failed) {
            alert(jmiTf("jmi.importSummary", { added, failed }));
        }
    }

    async function jmiProcessJsonString(raw, baseName) {
        let added = 0;
        let failed = 0;
        const parsed = JSON.parse(raw);
        const adapters = jmiGetAdaptersInOrder();
        let imports = [];
        let importOptions = null;

        if (!adapters.length) {
            return { added: 0, failed: 1, noProfiles: true };
        }

        for (const adapter of adapters) {
            let matched = false;
            try {
                matched = !!adapter.match(parsed);
            } catch (_e) {
                matched = false;
            }
            if (!matched) continue;

            let built = null;
            try {
                built = await adapter.build(parsed, baseName);
            } catch (_e) {
                built = null;
            }

            if (built && built.cancelled) {
                return { added: 0, failed: 0 };
            }
            if (built && Array.isArray(built.imports) && built.imports.length) {
                imports = built.imports;
                importOptions = built.importOptions != null ? built.importOptions : null;
                break;
            }
        }

        if (!imports.length) {
            failed++;
            return { added, failed };
        }
        for (const item of imports) {
            try {
                const ref = item.stream && item.stream.domain ? `https://${item.stream.domain}/` : (item.stream && item.stream.url ? item.stream.url : "");
                const resolved = await dmResolveImportToSegments(item.stream.url, ref);
                const job = dmCreateImportedJob(item, baseName, resolved);
                if (Array.isArray(item.subtitles) && item.subtitles.length) {
                    job.captured = job.captured || {};
                    job.captured.media = job.captured.media || {};
                    job.captured.media.subtitles = item.subtitles.map((s) => ({
                        url: s.url,
                        label: s.label || s.lang || "Subtitle",
                        lang: s.lang || ""
                    }));
                }
                _addJob(job);
                if (importOptions && importOptions.autoDownloadSubtitles && Array.isArray(item.subtitles)) {
                    item.subtitles.forEach((sub) => dmDownloadSubtitleTrackSilent(job, sub));
                }
                added++;
            } catch (_e) {
                failed++;
            }
        }
        return { added, failed };
    }

    function installGlobalDrop() {
        let dragDepth = 0;
        const isFileDrag = (e) => {
            const types = e && e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
            return types.includes("Files");
        };

        window.addEventListener("dragenter", (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth += 1;
            dmSetJsonDropActive(true);
        });
        window.addEventListener("dragover", (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
        });
        window.addEventListener("dragleave", (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) dmSetJsonDropActive(false);
        });
        window.addEventListener("drop", async (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth = 0;
            dmSetJsonDropActive(false);
            const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
            await importJsonFiles(files);
        });
    }

    global.BugiJsonImport = {
        init,
        installGlobalDrop,
        importJsonFiles,
        importJsonText,
        registerAdapter,
        unregisterAdapter,
        listAdapters,
        reloadSchemaProfiles,
        removeSchemaProfile,
        importSchemaProfileFile
    };
})(typeof self !== "undefined" ? self : this);
