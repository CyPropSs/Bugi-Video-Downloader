/**
 * JSON import profil dosyası ayrıştırma + chrome.storage (download manager + popup ortak).
 *
 * Profil sürümü 2: match + extract (alan yolları profil/şema dosyasında; kod sadece modları yorumlar).
 * JSON Schema içe aktarımında kök şema yanında "x-bugi-extract" bloğu zorunlu.
 */
(function (global) {
    const STORAGE_KEY = "bugiJsonImportSchemaProfiles";

    function slug(s) {
        const t = String(s || "profil").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return (t || "profil").slice(0, 56);
    }

    function looksLikeJsonSchema(obj) {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
        if (obj.$schema != null) return true;
        if (obj.type && (obj.properties || obj.items || obj.definitions)) return true;
        return false;
    }

    function validateExtract(ex) {
        if (!ex || typeof ex !== "object") return "extract nesnesi gerekli.";
        const mode = ex.mode;
        if (mode === "nestedEpisodes") {
            if (!ex.episodesPath) return "extract.episodesPath gerekli.";
            const s = ex.sources;
            if (!s || typeof s !== "object") return "extract.sources gerekli.";
            if (!s.containersPath) return "extract.sources.containersPath gerekli.";
            if (!s.variantsPath) return "extract.sources.variantsPath gerekli.";
            if (!s.urlKey) return "extract.sources.urlKey gerekli.";
            if (!s.qualityKey) return "extract.sources.qualityKey gerekli.";
            if (!s.languageFromKey) return "extract.sources.languageFromKey gerekli.";
            if (!s.languageLabelKey) return "extract.sources.languageLabelKey gerekli.";
            return null;
        }
        if (mode === "seasonsArray") {
            if (!ex.episodesPath) return "extract.episodesPath gerekli.";
            if (!ex.streamsPath) return "extract.streamsPath gerekli.";
            if (!ex.streamUrlKey) return "extract.streamUrlKey gerekli.";
            return null;
        }
        return "extract.mode: nestedEpisodes veya seasonsArray olmalı.";
    }

    function inferImportProfileFromSchema(schema) {
        if (!schema || typeof schema !== "object") {
            return { error: "Geçersiz şema." };
        }
        if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
            return { error: "Kök oneOf/anyOf/allOf desteklenmiyor." };
        }
        const x = schema["x-bugi-extract"];
        if (!x || typeof x !== "object") {
            return {
                error: "Bu şema dosyasında \"x-bugi-extract\" bloğu yok. Alan yollarını orada tanımlayın veya tam profil JSON (bugiJsonImportProfile: 2) kullanın."
            };
        }
        const ve = validateExtract(x);
        if (ve) return { error: ve };

        const title = String(schema.title || "").trim() || "Şema";
        let baseId = slug(schema.$id || title);
        if (!baseId || baseId === "profil") baseId = "schema";
        baseId = baseId + "-" + Date.now().toString(36);

        if (schema.type === "object") {
            const req = Array.isArray(schema.required) ? schema.required.slice() : [];
            const requiredKeys = req.length ? req : ["episodes"];
            return {
                profile: {
                    bugiJsonImportProfile: 2,
                    id: baseId,
                    label: title,
                    match: { rootType: "object", requiredKeys },
                    extract: x,
                    importedAt: Date.now()
                }
            };
        }

        if (schema.type === "array") {
            return {
                profile: {
                    bugiJsonImportProfile: 2,
                    id: baseId,
                    label: title,
                    match: { rootType: "array", firstItemRequiredKeys: Array.isArray(x.firstItemRequiredKeys) ? x.firstItemRequiredKeys : ["episodes"] },
                    extract: x,
                    importedAt: Date.now()
                }
            };
        }

        return { error: "Şema kök type object veya array olmalı." };
    }

    function normalizeExplicitProfileV2(obj) {
        if (!obj || obj.bugiJsonImportProfile !== 2) return null;
        const id = slug(obj.id || obj.label || "profil");
        const label = String(obj.label || id).trim();
        const match = obj.match;
        const extract = obj.extract;
        if (!match || (match.rootType !== "object" && match.rootType !== "array")) {
            return { error: "match.rootType: object veya array gerekli." };
        }
        const ve = validateExtract(extract);
        if (ve) return { error: ve };
        return {
            profile: {
                bugiJsonImportProfile: 2,
                id,
                label,
                match,
                extract,
                importedAt: Date.now()
            }
        };
    }

    function parseProfileFromImportedJson(obj) {
        const v2 = normalizeExplicitProfileV2(obj);
        if (v2 && v2.error) return v2;
        if (v2 && v2.profile) return v2;
        if (looksLikeJsonSchema(obj)) {
            return inferImportProfileFromSchema(obj);
        }
        return { error: "Geçersiz profil. bugiJsonImportProfile: 2 + match + extract veya x-bugi-extract içeren JSON Schema kullanın." };
    }

    function getAllProfiles() {
        return new Promise((resolve) => {
            chrome.storage.local.get({ [STORAGE_KEY]: [] }, (res) => {
                resolve(Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : []);
            });
        });
    }

    function persistProfile(profile) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get({ [STORAGE_KEY]: [] }, (res) => {
                const arr = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY].slice() : [];
                const idx = arr.findIndex((p) => p && p.id === profile.id);
                if (idx >= 0) arr[idx] = profile;
                else arr.unshift(profile);
                chrome.storage.local.set({ [STORAGE_KEY]: arr }, () => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(arr);
                });
            });
        });
    }

    function removeProfile(profileId) {
        const id = String(profileId || "").trim();
        if (!id) return Promise.resolve([]);
        return new Promise((resolve) => {
            chrome.storage.local.get({ [STORAGE_KEY]: [] }, (res) => {
                const arr = (res[STORAGE_KEY] || []).filter((p) => p && p.id !== id);
                chrome.storage.local.set({ [STORAGE_KEY]: arr }, () => resolve(arr));
            });
        });
    }

    global.BugiJsonImportProfiles = {
        STORAGE_KEY,
        parseProfileFromImportedJson,
        getAllProfiles,
        persistProfile,
        removeProfile
    };
})(typeof self !== "undefined" ? self : this);
