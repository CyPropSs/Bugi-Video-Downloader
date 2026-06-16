# -*- coding: utf-8 -*-
"""Fill gaps between locale *.json and en.json (Google Translate via deep-translator).

Run: python locales/fill_missing_translations.py
"""
from __future__ import annotations

import json
import re
import sys
import time
import os
from pathlib import Path

from deep_translator import GoogleTranslator

SCRIPT_DIR = Path(__file__).resolve().parent

ALL_LANG_MAP = {"es": "es", "fr": "fr", "de": "de", "pt": "pt", "ru": "ru", "ja": "ja", "zh": "zh-CN", "ar": "ar"}
_pick = os.environ.get("BUGI_LOCALE_ONLY", "").strip().lower()
LANG_MAP = {k: v for k, v in ALL_LANG_MAP.items() if not _pick or k == _pick}
if not LANG_MAP:
    LANG_MAP = ALL_LANG_MAP

PH_L = "!Ｐ"
PH_R = "Ｐ!"


def shield_placeholders(val: str) -> tuple[str, list[str]]:
    parts: list[str] = []

    def repl(m):
        parts.append(m.group(0))
        return f"{PH_L}{len(parts) - 1}{PH_R}"

    return re.sub(r"\{[a-zA-Z0-9_]+\}", repl, val), parts


def unshield_placeholders(val: str, parts: list[str]) -> str:
    for i, p in enumerate(parts):
        val = val.replace(f"{PH_L}{i}{PH_R}", p)
    return val


NO_AUTO_KEYS = frozenset(
    {
        "media.durationLine",
        "content.rangeEstLineHtml",
        "dm.emptyPendingHtml",
        "dm.fixedDirNoteHtml",
        "dm.rangeEstLegacyHtml",
        "legal.summary",
    }
)

MANUAL_HTML = {
    "es": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ Duración: {time} ({segCount} segmentos)</span>",
        "content.rangeEstLineHtml": 'Duración: <b style="color:#4fc3f7">{dur}</b> — Aprox.: <b style="color:#ffb74d">~{mb} MB</b>',
        "dm.emptyPendingHtml": 'Aún no hay descargas pendientes.<br>Inicia desde un vídeo o el menú de doblaje con la acción de descarga de la extensión.',
        "dm.fixedDirNoteHtml": 'Carpeta seleccionada: {name} <span style="color:#de1212; margin-left:6px;">(los MP4 siguen yendo a la carpeta Descargas del navegador)</span>',
        "dm.rangeEstLegacyHtml": 'Duración: <b style="color:#4fc3f7">{dur}</b> — Aprox.: <b style="color:#ffb74d">~{mb} MB</b>',
    },
    "fr": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ Durée : {time} ({segCount} segments)</span>",
        "content.rangeEstLineHtml": 'Durée : <b style="color:#4fc3f7">{dur}</b> — Est. : <b style="color:#ffb74d">~{mb} Mo</b>',
        "dm.emptyPendingHtml": "Aucun téléchargement en attente pour l'instant.<br>Démarrez depuis une vidéo ou le menu doublage via l'action télécharger de l'extension.",
        "dm.fixedDirNoteHtml": 'Dossier sélectionné : {name} <span style="color:#de1212; margin-left:6px;">(les MP4 vont encore dans le dossier Téléchargements du navigateur)</span>',
        "dm.rangeEstLegacyHtml": 'Durée : <b style="color:#4fc3f7">{dur}</b> — Est. : <b style="color:#ffb74d">~{mb} Mo</b>',
    },
    "de": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ Dauer: {time} ({segCount} Segmente)</span>",
        "content.rangeEstLineHtml": 'Dauer: <b style="color:#4fc3f7">{dur}</b> — Geschätzt: <b style="color:#ffb74d">~{mb} MB</b>',
        "dm.emptyPendingHtml": "Noch keine ausstehenden Downloads.<br>Über eine Video- oder Dubbing-Menüaktion der Erweiterung starten.",
        "dm.fixedDirNoteHtml": 'Ordner gewählt: {name} <span style="color:#de1212; margin-left:6px;">(MP4 landen weiter im Browser-Downloadordner)</span>',
        "dm.rangeEstLegacyHtml": 'Dauer: <b style="color:#4fc3f7">{dur}</b> — Geschätzt: <b style="color:#ffb74d">~{mb} MB</b>',
    },
    "pt": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ Duração: {time} ({segCount} segmentos)</span>",
        "content.rangeEstLineHtml": 'Duração: <b style="color:#4fc3f7">{dur}</b> — Est.: <b style="color:#ffb74d">~{mb} MB</b>',
        "dm.emptyPendingHtml": "Ainda não há downloads pendentes.<br>Comece a partir de um vídeo ou do menu de dublagem com a ação de download da extensão.",
        "dm.fixedDirNoteHtml": 'Pasta selecionada: {name} <span style="color:#de1212; margin-left:6px;">(ficheiros MP4 vão para a pasta Downloads do navegador)</span>',
        "dm.rangeEstLegacyHtml": 'Duração: <b style="color:#4fc3f7">{dur}</b> — Est.: <b style="color:#ffb74d">~{mb} MB</b>',
    },
    "ru": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ Длительность: {time} ({segCount} фрагм.)</span>",
        "content.rangeEstLineHtml": 'Длительность: <b style="color:#4fc3f7">{dur}</b> — Оценка: <b style="color:#ffb74d">~{mb} МБ</b>',
        "dm.emptyPendingHtml": "Ожидающих загрузок пока нет.<br>Начните с видео или меню дубляжа через действие загрузки расширения.",
        "dm.fixedDirNoteHtml": 'Выбранная папка: {name} <span style="color:#de1212; margin-left:6px;">(MP4 всё равно попадают в папку «Загрузки» браузера)</span>',
        "dm.rangeEstLegacyHtml": 'Длительность: <b style="color:#4fc3f7">{dur}</b> — Оценка: <b style="color:#ffb74d">~{mb} МБ</b>',
    },
    "ja": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ 時間: {time}（{segCount} セグメント）</span>",
        "content.rangeEstLineHtml": '時間: <b style="color:#4fc3f7">{dur}</b> — 目安: <b style="color:#ffb74d">~{mb} MB</b>',
        "dm.emptyPendingHtml": "保留中のダウンロードはまだありません。<br>動画または吹き替えメニューから拡張機能のダウンロード操作で開始してください。",
        "dm.fixedDirNoteHtml": '選択したフォルダ: {name} <span style="color:#de1212; margin-left:6px;">（MP4はブラウザのダウンロードフォルダに保存されます）</span>',
        "dm.rangeEstLegacyHtml": '時間: <b style="color:#4fc3f7">{dur}</b> — 目安: <b style="color:#ffb74d">~{mb} MB</b>',
    },
    "zh": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ 时长：{time}（{segCount} 个分片）</span>",
        "content.rangeEstLineHtml": '时长：<b style="color:#4fc3f7">{dur}</b> — 估计：<b style="color:#ffb74d">~{mb} MB</b>',
        "dm.emptyPendingHtml": '暂无排队下载。<br>请从视频或配音菜单中使用扩展的下载操作开始。',
        "dm.fixedDirNoteHtml": '所选文件夹：{name} <span style="color:#de1212; margin-left:6px;">（MP4仍会保存到浏览器“下载”文件夹）</span>',
        "dm.rangeEstLegacyHtml": '时长：<b style="color:#4fc3f7">{dur}</b> — 估计：<b style="color:#ffb74d">~{mb} MB</b>',
    },
    "ar": {
        "media.durationLine": "<br><span style='font-size:11px; color:#a5d6a7;'>⏱ المدة: {time} ({segCount} مقاطع)</span>",
        "content.rangeEstLineHtml": 'المدة: <b style="color:#4fc3f7">{dur}</b> — تقديري: <b style="color:#ffb74d">~{mb} م.ب.</b>',
        "dm.emptyPendingHtml": 'لا توجد تنزيلات قيد الانتظار بعد.<br>ابدأ من الفيديو أو قائمة الدبلجة عبر إجراء التنزيل في الإضافة.',
        "dm.fixedDirNoteHtml": 'المجلد المحدد: {name} <span style="color:#de1212; margin-left:6px;">(ملفات MP4 ما زالت تُحفظ في مجلد تنزيلات المتصفح)</span>',
        "dm.rangeEstLegacyHtml": 'المدة: <b style="color:#4fc3f7">{dur}</b> — تقديري: <b style="color:#ffb74d">~{mb} م.ب.</b>',
    },
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj: dict) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2))
        f.write("\n")


def translate_value(translator: GoogleTranslator, val: str) -> str:
    shielded, parts = shield_placeholders(val)
    return unshield_placeholders(translator.translate(shielded), parts)


def main() -> None:
    en_path = SCRIPT_DIR / "en.json"
    en = load_json(en_path)
    en_keys = list(en.keys())

    for fname, tgt in LANG_MAP.items():
        path = SCRIPT_DIR / f"{fname}.json"
        if not path.exists():
            continue
        orig = load_json(path)
        missing = [k for k in en_keys if k not in orig]
        if not missing:
            print(f"{fname}: up to date")
            continue

        translator = GoogleTranslator(source="en", target=tgt)
        manual = MANUAL_HTML.get(fname, {})
        new_vals: dict = {}

        for key in missing:
            raw_en = en[key]
            if not isinstance(raw_en, str):
                new_vals[key] = raw_en
                continue
            if key in NO_AUTO_KEYS:
                new_vals[key] = manual[key] if key in manual else raw_en
                continue
            try:
                new_vals[key] = translate_value(translator, raw_en)
            except Exception as e:
                print(f"  {fname} [{key}] {e}", file=sys.stderr)
                new_vals[key] = raw_en
            time.sleep(0.055)

        merged = dict(orig)
        merged.update(new_vals)

        ordered = {k: merged[k] for k in en_keys if k in merged}
        stray = sorted(set(merged.keys()) - set(en_keys))
        for sk in stray:
            ordered[sk] = merged[sk]

        save_json(path, ordered)
        print(f"{fname}: +{len(missing)} keys")


if __name__ == "__main__":
    main()
