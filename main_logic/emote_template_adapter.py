# -*- coding: utf-8 -*-
"""Read-only adapters for template packages used by the emote maker.

The adapter deliberately stops at the package boundary.  EmoteLab templates
are Spine packages (skeleton + atlas + metadata), not collections of PNG
layers.  It safely inspects and normalizes metadata without shipping the
user's model files; the browser-side Spine renderer consumes the same manifest
without changing this contract.
"""

from __future__ import annotations

import csv
import io
import json
import re
import stat
import struct
import zipfile
from pathlib import PurePosixPath
from typing import Any


EMOTE_TEMPLATE_SCHEMA_VERSION = 1
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 5_000
MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_METADATA_FILE_BYTES = 8 * 1024 * 1024

_ALLOWED_METADATA_SUFFIXES = (
    ".json",
    ".csv",
    ".atlas.txt",
    ".skel.bytes",
    ".png",
)
_SCRIPT_SUFFIXES = {".cmd", ".bat", ".ps1", ".reg", ".exe", ".dll", ".js"}
_SPINE_VERSION_RE = re.compile(rb"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9])")
_LOCALE_ALIASES = {
    "zh-hans": "zh-CN",
    "zh-hant": "zh-TW",
    "pt-br": "pt-BR",
}


class EmoteTemplatePackageError(ValueError):
    """Raised when an uploaded archive is not a safe EmoteLab package."""


def inspect_emotelab_zip(data: bytes, *, filename: str = "") -> dict[str, Any]:
    """Inspect an EmoteLab ZIP and return a renderer-neutral manifest.

    The archive is never extracted.  Only bounded JSON/CSV/atlas metadata is
    read; skeleton, texture, and atlas image files are represented by relative
    paths and sizes.  This keeps imported third-party assets local to the
    caller and makes the result safe to persist as editor state later.
    """

    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise EmoteTemplatePackageError("上传内容不是二进制数据")
    raw = bytes(data)
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise EmoteTemplatePackageError(
            f"模板包过大，当前导入上限为 {MAX_ARCHIVE_BYTES // (1024 * 1024)} MB"
        )
    if not zipfile.is_zipfile(io.BytesIO(raw)):
        raise EmoteTemplatePackageError("不是有效的 ZIP 模板包")

    try:
        archive = zipfile.ZipFile(io.BytesIO(raw), "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise EmoteTemplatePackageError("无法读取 ZIP 模板包") from exc

    with archive:
        entries, warnings = _collect_entries(archive)
        if not entries:
            raise EmoteTemplatePackageError("ZIP 中没有可读取的模板文件")
        return _normalize_archive(archive, entries, warnings, filename=filename)


def _collect_entries(
    archive: zipfile.ZipFile,
) -> tuple[dict[str, zipfile.ZipInfo], list[str]]:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise EmoteTemplatePackageError(
            f"ZIP 文件数超过上限（最多 {MAX_ARCHIVE_ENTRIES} 个）"
        )

    entries: dict[str, zipfile.ZipInfo] = {}
    entry_keys: set[str] = set()
    warnings: list[str] = []
    uncompressed_total = 0
    for info in infos:
        name = _decode_zip_name(info)
        normalized = _normalize_archive_name(name)
        if not normalized:
            continue
        if _is_symlink(info):
            raise EmoteTemplatePackageError("ZIP 包含不允许的符号链接")
        normalized_key = normalized.casefold()
        if normalized_key in entry_keys:
            raise EmoteTemplatePackageError(f"ZIP 包含重复路径：{normalized}")
        entry_keys.add(normalized_key)
        uncompressed_total += max(0, int(info.file_size))
        if uncompressed_total > MAX_UNCOMPRESSED_BYTES:
            raise EmoteTemplatePackageError(
                f"ZIP 解压后大小超过上限（最多 {MAX_UNCOMPRESSED_BYTES // (1024 * 1024)} MB）"
            )
        suffix = _suffix(normalized)
        if suffix in _SCRIPT_SUFFIXES:
            warnings.append(f"已忽略非模板脚本：{normalized}")
            continue
        if not normalized.lower().endswith(_ALLOWED_METADATA_SUFFIXES):
            warnings.append(f"已忽略不支持的文件：{normalized}")
            continue
        if info.file_size > MAX_METADATA_FILE_BYTES and suffix in {".json", ".csv", ".atlas.txt"}:
            raise EmoteTemplatePackageError(f"元数据文件过大：{normalized}")
        entries[normalized] = info
    return entries, warnings


def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    """Recover common legacy ZIP names while retaining ASCII paths."""

    name = info.filename or ""
    if info.flag_bits & 0x800:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name

    candidates = [name]
    for encoding in ("utf-8", "gb18030", "cp932", "big5", "euc-kr"):
        try:
            candidates.append(raw.decode(encoding))
        except UnicodeDecodeError:
            continue

    def score(value: str) -> tuple[int, int, int]:
        replacement = value.count("�")
        control = sum(ord(char) < 32 and char not in "\t\r\n" for char in value)
        readable = sum(
            char.isalnum() or char in "._-/()[] {}" for char in value
        )
        return (-replacement, -control, readable)

    return max(candidates, key=score)


def _normalize_archive_name(name: str) -> str:
    normalized = str(name or "").replace("\\", "/").strip()
    if not normalized or normalized.endswith("/"):
        return ""
    if "\x00" in normalized or normalized.startswith("/"):
        raise EmoteTemplatePackageError("ZIP 包含不安全的绝对路径")
    parts: list[str] = []
    for part in normalized.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise EmoteTemplatePackageError("ZIP 包含不安全的路径穿越")
        parts.append(part)
    if not parts:
        return ""
    return "/".join(parts)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def _suffix(path: str) -> str:
    lowered = path.lower()
    if lowered.endswith(".atlas.txt"):
        return ".atlas.txt"
    if lowered.endswith(".skel.bytes"):
        return ".skel.bytes"
    return PurePosixPath(lowered).suffix


def _normalize_path(path: str) -> str:
    return "/".join(part for part in path.replace("\\", "/").split("/") if part)


def _is_historical(path: str) -> bool:
    parts = {part.casefold() for part in _normalize_path(path).split("/")}
    return bool(parts & {"历史版本", "history", "historical", "backup", "backups"})


def _read_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    if info.file_size > limit:
        raise EmoteTemplatePackageError(f"文件过大，无法读取：{info.filename}")
    try:
        content = archive.read(info)
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise EmoteTemplatePackageError(f"读取文件失败：{info.filename}") from exc
    if len(content) > limit:
        raise EmoteTemplatePackageError(f"文件过大，无法读取：{info.filename}")
    return content


def _decode_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030", "cp932", "big5"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _read_json(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo
) -> dict[str, Any] | list[Any] | None:
    try:
        value = json.loads(_decode_text(_read_entry(archive, info, MAX_METADATA_FILE_BYTES)))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return value if isinstance(value, (dict, list)) else None


def _read_csv(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> list[list[str]]:
    text = _decode_text(_read_entry(archive, info, MAX_METADATA_FILE_BYTES))
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]


def _path_key(path: str) -> str:
    return _normalize_path(path).casefold()


def _has_segment(path: str, segment: str) -> bool:
    target = segment.casefold()
    return any(part.casefold() == target for part in _normalize_path(path).split("/"))


def _child_segment(path: str, parent: str) -> str:
    parts = _normalize_path(path).split("/")
    target = str(parent or "").casefold()
    for index, part in enumerate(parts):
        if part.casefold() == target and index + 1 < len(parts):
            return parts[index + 1]
    return ""


def _under(path: str, parent: str) -> bool:
    path_key = _path_key(path)
    parent_key = _path_key(parent).rstrip("/")
    return path_key == parent_key or path_key.startswith(parent_key + "/")


def _basename(path: str) -> str:
    return _normalize_path(path).rsplit("/", 1)[-1]


def _parent(path: str) -> str:
    normalized = _normalize_path(path)
    return normalized.rsplit("/", 1)[0] if "/" in normalized else ""


def _candidate_model_meta_paths(entries: dict[str, zipfile.ZipInfo]) -> list[str]:
    paths = [
        path
        for path in entries
        if _basename(path).casefold() == "model.meta.json"
        and any(part.casefold() == "spinemodels" for part in path.split("/"))
        and not _is_historical(path)
    ]
    return sorted(paths, key=lambda value: (value.count("/"), value.casefold()))


def _choose_model(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    warnings: list[str],
) -> tuple[str, dict[str, Any], str | None, str | None, str | None]:
    candidates = _candidate_model_meta_paths(entries)
    model_meta_path: str | None = candidates[0] if candidates else None
    model_meta: dict[str, Any] = {}
    if model_meta_path:
        parsed = _read_json(archive, entries[model_meta_path])
        if isinstance(parsed, dict):
            model_meta = parsed
    if not model_meta_path:
        spine_paths = [
            path
            for path in entries
            if _has_segment(path, "spinemodels") and not _is_historical(path)
        ]
        skeletons = [path for path in spine_paths if _suffix(path) == ".skel.bytes"]
        atlases = [path for path in spine_paths if _suffix(path) == ".atlas.txt"]
        if not skeletons or not atlases:
            raise EmoteTemplatePackageError(
                "未找到兼容的模型资源（需要 .skel.bytes 和 .atlas.txt）"
            )
        model_root = _parent(skeletons[0])
        skeleton_path = skeletons[0]
        atlas_path = next((path for path in atlases if _parent(path) == model_root), atlases[0])
        shared_key = PurePosixPath(model_root).name
        warnings.append("模板包缺少模型标识，已使用目录名继续读取")
        return model_root, {"SharedModelKey": shared_key}, skeleton_path, atlas_path, None

    model_root = _parent(model_meta_path)
    shared_key = str(model_meta.get("SharedModelKey") or PurePosixPath(model_root).name)
    model_files = [path for path in entries if _under(path, model_root) and not _is_historical(path)]
    skeletons = [path for path in model_files if _suffix(path) == ".skel.bytes"]
    atlases = [path for path in model_files if _suffix(path) == ".atlas.txt"]
    skeleton_path = _pick_model_file(skeletons, shared_key)
    atlas_path = _pick_model_file(atlases, shared_key)
    if not skeleton_path or not atlas_path:
        raise EmoteTemplatePackageError(
            "模型元数据存在，但未找到配套的 .skel.bytes 或 .atlas.txt"
        )
    return model_root, model_meta, skeleton_path, atlas_path, shared_key


def _pick_model_file(paths: list[str], shared_key: str) -> str | None:
    if not paths:
        return None
    key = shared_key.casefold()
    return sorted(paths, key=lambda path: (0 if key in _basename(path).casefold() else 1, path.casefold()))[0]


def _normalize_archive(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    warnings: list[str],
    *,
    filename: str,
) -> dict[str, Any]:
    model_root, model_meta, skeleton_path, atlas_path, shared_key = _choose_model(
        archive, entries, warnings
    )
    shared_key = str(shared_key or model_meta.get("SharedModelKey") or PurePosixPath(model_root).name)

    skeleton_info = entries[skeleton_path] if skeleton_path else None
    atlas_info = entries[atlas_path] if atlas_path else None
    spine_version = _detect_spine_version(archive, skeleton_info) if skeleton_info else None
    atlas_text = _decode_text(_read_entry(archive, atlas_info, MAX_METADATA_FILE_BYTES)) if atlas_info else ""
    atlas_pages = _normalize_atlas_pages(
        atlas_text, entries, _parent(atlas_path or model_root), archive
    )
    if not atlas_pages:
        warnings.append("未从 atlas.txt 解析到贴图页")
    missing_pages = [page["name"] for page in atlas_pages if not page.get("path")]
    if missing_pages:
        warnings.append(f"缺少 atlas 贴图页：{', '.join(missing_pages[:5])}")

    character_path, character_data = _find_character(
        archive,
        entries,
        shared_key,
        model_root=model_root,
    )
    character = _normalize_character(character_data)
    character_key = character.get("sharedModelKey")
    character_directory = _child_segment(character_path or "", "characters").casefold()
    model_directory = _basename(model_root).casefold()
    if (
        character_key
        and character_key.casefold() != str(shared_key or "").casefold()
        and character_directory != model_directory
    ):
        warnings.append(
            "部分角色数据与当前模型不一致；已保留兼容信息供渲染层处理"
        )
    custom_texture_required = bool(character.get("customTexture"))
    if custom_texture_required:
        warnings.append(
            "部分贴图未随模板提供，预览可能不完整"
        )

    catalogs = _read_catalogs(archive, entries, model_root)
    scene_lists = _read_scene_lists(archive, entries, shared_key)
    scenes = [scene for scene_list in scene_lists for scene in scene_list["scenes"]]
    if not scene_lists:
        warnings.append("未找到包含 scenes 数组的 SceneList JSON")
    if any(scene.get("model", {}).get("outline", {}).get("enabled") for scene in scenes):
        warnings.append("部分场景启用了轮廓；浏览器预览将使用兼容绘制")
    if any(scene.get("texts") for scene in scenes):
        warnings.append("部分场景包含文本层；浏览器预览将使用兼容绘制")

    model_display_name = str(model_meta.get("DisplayName") or shared_key)
    model = {
        "id": shared_key,
        "displayName": model_display_name,
        "metaPath": _relative_package_path(model_meta, model_root, entries),
        "skeleton": {
            "path": skeleton_path,
            "bytes": skeleton_info.file_size if skeleton_info else 0,
            "spineVersion": spine_version,
        },
        "atlas": {
            "path": atlas_path,
            "pages": atlas_pages,
        },
        "customTexture": bool(model_meta.get("IsUsingCustomTexture", False)) or custom_texture_required,
        "customTextureCache": {
            "required": custom_texture_required,
            "provided": False,
        },
    }

    package_name = _basename(str(filename).replace("\\", "/")) if filename else "template.zip"
    return {
        "schemaVersion": EMOTE_TEMPLATE_SCHEMA_VERSION,
        "source": {
            "kind": "emotelab",
            "packageName": package_name,
            "spineVersion": spine_version,
            "sharedModelKey": shared_key,
            "assetsPersisted": False,
            "assetPolicy": "local-import-and-render-only",
        },
        "model": model,
        "character": {**character, "path": character_path},
        "catalogs": catalogs,
        "sceneLists": scene_lists,
        "scenes": scenes,
        "counts": {
            "atlasPages": len(atlas_pages),
            "animations": len(catalogs["animations"]),
            "skinGroups": len(catalogs["skinGroups"]),
            "sliders": len(catalogs["sliders"]),
            "slotGroups": len(catalogs["slotGroups"]),
            "sceneLists": len(scene_lists),
            "scenes": len(scenes),
            "activeSkins": len(character["skins"]),
        },
        "capabilities": {
            "metadata": True,
            "spineRender": False,
            "nativeExport": False,
            "staticPngExport": False,
            "animatedExport": False,
            "characterSkinSelection": True,
            "characterNativeSliders": True,
            "characterSlotTint": True,
            "sceneCamera": True,
            "sceneCameraRotation": True,
            "sceneMirror": True,
            "sceneVisibility": True,
            "sceneOutline": True,
            "sceneText": True,
            "sceneOverlay": "canvas2d-compatible",
            "reason": "服务端只返回元数据；浏览器端可按需启用 Spine 4.3 渲染，原始资源不会被公开或保存。",
        },
        "warnings": warnings,
    }


def _relative_package_path(
    model_meta: dict[str, Any], model_root: str, entries: dict[str, zipfile.ZipInfo]
) -> str | None:
    # The caller only needs a stable reference; finding the exact path again is
    # unnecessary for the common case and avoids leaking an absolute local path.
    del model_meta, entries
    return f"{model_root}/model.meta.json"


def _detect_spine_version(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo | None
) -> str | None:
    if info is None:
        return None
    try:
        with archive.open(info, "r") as stream:
            head = stream.read(256)
    except (OSError, RuntimeError, zipfile.BadZipFile):
        return None
    match = _SPINE_VERSION_RE.search(head)
    return match.group(1).decode("ascii") if match else None


def _normalize_atlas_pages(
    atlas_text: str,
    entries: dict[str, zipfile.ZipInfo],
    atlas_root: str,
    archive: zipfile.ZipFile,
) -> list[dict[str, Any]]:
    # Spine atlas page declarations are standalone *.png lines followed by a
    # size/format/filter block.  Region names can also contain dots, so only
    # lines ending in .png are considered page candidates.
    lines = [line.strip() for line in atlas_text.replace("\ufeff", "").splitlines()]
    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        if not line.lower().endswith(".png") or ":" in line:
            continue
        key = line.casefold()
        if key in seen:
            continue
        seen.add(key)
        width = height = None
        scale = None
        for follow in lines[index + 1 : index + 8]:
            if follow.lower().endswith(".png") and ":" not in follow:
                break
            if follow.lower().startswith("size:"):
                match = re.search(r"size:\s*(\d+)\s*,\s*(\d+)", follow, re.I)
                if match:
                    width, height = int(match.group(1)), int(match.group(2))
            elif follow.lower().startswith("scale:"):
                try:
                    scale = float(follow.split(":", 1)[1].strip())
                except ValueError:
                    pass
        match_path = _find_asset_by_basename(entries, atlas_root, line)
        png_width, png_height = (
            _read_png_size(entries[match_path], archive) if match_path else (None, None)
        )
        pages.append(
            {
                "name": line,
                "path": match_path,
                "width": width or png_width,
                "height": height or png_height,
                "scale": scale,
            }
        )
    return pages


def _find_asset_by_basename(
    entries: dict[str, zipfile.ZipInfo], root: str, basename: str
) -> str | None:
    target = basename.casefold()
    candidates = [
        path for path in entries
        if _under(path, root) and _suffix(path) == ".png" and _basename(path).casefold() == target
    ]
    if not candidates:
        candidates = [
            path for path in entries
            if _suffix(path) == ".png" and _basename(path).casefold() == target
        ]
    return sorted(candidates, key=lambda path: (path.count("/"), path.casefold()))[0] if candidates else None


def _read_png_size(
    info: zipfile.ZipInfo | None, archive: zipfile.ZipFile | None
) -> tuple[int | None, int | None]:
    # Atlas dimensions are authoritative.  This fallback only enriches a
    # package whose atlas omits a size line, so it intentionally reads 24 bytes.
    if info is None or archive is None:
        return None, None
    try:
        with archive.open(info, "r") as stream:
            head = stream.read(24)
    except (OSError, RuntimeError, zipfile.BadZipFile):
        return None, None
    if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
        return struct.unpack(">II", head[16:24])
    return None, None


def _find_character(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    shared_key: str,
    *,
    model_root: str | None = None,
) -> tuple[str | None, dict[str, Any]]:
    # EmoteLab's character JSON often keeps an old SharedModelKey (for
    # example, YUI_PropsV1's file says CoffeeBean), while the directory under
    # Characters still identifies the exact model variant.  Prefer that
    # directory affinity before falling back to the legacy key so a ZIP that
    # contains several CoffeeBean character presets cannot silently select a
    # different outfit/hat variant.
    model_directory = _basename(model_root or "").casefold()

    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for path, info in entries.items():
        if not _has_segment(path, "characters") or _is_historical(path) or _suffix(path) != ".json":
            continue
        parsed = _read_json(archive, info)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("ActiveSkins"), dict):
            continue
        key = str(parsed.get("SharedModelKey") or "")
        score = 10
        if key.casefold() == str(shared_key or "").casefold():
            score -= 3
        if model_directory and _child_segment(path, "characters").casefold() == model_directory:
            score -= 10
        if model_directory and model_directory in _path_key(path).split("/"):
            score -= 2
        if str(shared_key or "").casefold() in _path_key(path):
            score -= 1
        candidates.append((score, path, parsed))
    if not candidates:
        return None, {}
    _, path, parsed = sorted(candidates, key=lambda item: (item[0], item[1].casefold()))[0]
    return path, parsed


def _normalize_character(data: dict[str, Any]) -> dict[str, Any]:
    active = data.get("ActiveSkins") if isinstance(data.get("ActiveSkins"), dict) else {}
    skins = []
    for item in active.get("Items", []) if isinstance(active, dict) else []:
        if not isinstance(item, dict):
            continue
        group = item.get("Key", item.get("Name"))
        value = item.get("Value", item.get("value"))
        if group is not None and value is not None:
            skins.append({"group": str(group), "value": str(value)})

    sliders = []
    for item in data.get("SliderConstraints", []) if isinstance(data.get("SliderConstraints"), list) else []:
        if not isinstance(item, dict) or item.get("Name") is None:
            continue
        sliders.append({"name": str(item["Name"]), "value": item.get("Value")})

    slots = []
    for item in data.get("SlotGroups", []) if isinstance(data.get("SlotGroups"), list) else []:
        if not isinstance(item, dict) or item.get("Name") is None:
            continue
        slots.append(
            {
                "name": str(item["Name"]),
                "tintColor": _normalize_color(item.get("TintColor")),
                "tintBlackColor": _normalize_color(item.get("TintBlackColor")),
                "renderMode": item.get("RenderMode"),
            }
        )
    return {
        "sharedModelKey": data.get("SharedModelKey"),
        "customTexture": bool(data.get("IsUsingCustomTexture", False)),
        "skins": skins,
        "sliders": sliders,
        "slots": slots,
    }


def _normalize_color(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, float] = {}
    for channel in ("r", "g", "b", "a"):
        try:
            result[channel] = float(value.get(channel, 0 if channel != "a" else 1))
        except (TypeError, ValueError):
            result[channel] = 0.0 if channel != "a" else 1.0
    return result


def _read_catalogs(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    model_root: str,
) -> dict[str, list[dict[str, Any]]]:
    names = {
        "animations": "animations.csv",
        "skinGroups": "skingroups.csv",
        "sliders": "sliders.csv",
        "slotGroups": "slotgroups.csv",
    }
    catalogs: dict[str, list[dict[str, Any]]] = {key: [] for key in names}
    for key, filename in names.items():
        candidates = [
            path for path in entries
            if _under(path, model_root)
            and _basename(path).casefold() == filename
            and not _is_historical(path)
        ]
        if not candidates:
            continue
        try:
            rows = _read_csv(archive, entries[sorted(candidates)[0]])
        except EmoteTemplatePackageError:
            continue
        catalogs[key] = _normalize_catalog_rows(rows, key)
    return catalogs


def _normalize_catalog_rows(rows: list[list[str]], kind: str) -> list[dict[str, Any]]:
    if not rows:
        return []
    header = [cell.strip() for cell in rows[0]]
    id_index = 0
    expected = {
        "animations": "animationname",
        "skinGroups": "groupname",
        "sliders": "slidername",
        "slotGroups": "groupname",
    }[kind]
    for index, cell in enumerate(header):
        if cell.casefold() == expected:
            id_index = index
            break
    labels: dict[int, str] = {}
    for index, cell in enumerate(header):
        normalized = cell.casefold()
        labels[index] = _LOCALE_ALIASES.get(normalized, cell) if cell else cell
    result = []
    for row in rows[1:]:
        if id_index >= len(row) or not row[id_index]:
            continue
        item_labels: dict[str, str] = {}
        for index, value in enumerate(row):
            locale = labels.get(index, "")
            if not locale or locale.casefold() in {"displayname", expected} or not value:
                continue
            item_labels[locale] = value
        display = row[1] if len(row) > 1 else row[id_index]
        result.append({"id": row[id_index], "displayName": display, "labels": item_labels})
    return result


def _read_scene_lists(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    shared_key: str,
) -> list[dict[str, Any]]:
    result = []
    for path, info in sorted(entries.items(), key=lambda item: item[0].casefold()):
        if not _has_segment(path, "scenelists") or _is_historical(path) or _suffix(path) != ".json":
            continue
        parsed = _read_json(archive, info)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("scenes"), list):
            continue
        source_key = parsed.get("sharedModelKey")
        scenes = [_normalize_scene(scene, path, index) for index, scene in enumerate(parsed["scenes"]) if isinstance(scene, dict)]
        result.append(
            {
                "id": f"scene-list:{path}",
                "name": PurePosixPath(path).stem,
                "path": path,
                "sharedModelKey": source_key,
                "keyMatchesModel": source_key in (None, shared_key),
                "scenes": scenes,
            }
        )
    return result


def _normalize_scene(scene: dict[str, Any], source_path: str, index: int) -> dict[str, Any]:
    animation_name = scene.get("animationName")
    model = scene.get("model") if isinstance(scene.get("model"), dict) else {}
    camera = {
        "position": _vector(scene.get("cameraPosition"), (0.0, 0.0, 0.0), ("x", "y", "z")),
        "rotation": _vector(scene.get("cameraRotation"), (0.0, 0.0, 0.0, 1.0), ("x", "y", "z", "w")),
        "orthographicSize": _number(scene.get("cameraOrthographicSize"), 5.0),
    }
    outline = {
        "enabled": bool(model.get("outlineEnabled", False)),
        "width": _number(model.get("outlineWidth"), 0.0),
        "color": _normalize_color(model.get("outlineColor")),
    }
    normalized_model = {
        **model,
        "visible": bool(model.get("visible", True)),
        "mirrored": bool(model.get("mirrored", False)),
        "outline": outline,
    }
    # Keep EmoteLab's nested TextMeshPro fields intact while normalizing the
    # values the browser overlay needs.  Unknown fields are deliberately
    # preserved so newer EmoteLab versions can be consumed without dropping
    # metadata before the renderer learns about it.
    raw_texts = scene.get("texts") if isinstance(scene.get("texts"), list) else []
    texts = [
        _normalize_scene_text(item, text_index)
        for text_index, item in enumerate(raw_texts)
        if isinstance(item, dict)
    ]
    return {
        "id": f"{source_path}#{index}",
        "source": {"sceneList": source_path, "index": index},
        "name": str(scene.get("name") or f"Scene {index + 1}"),
        "animation": {
            "id": str(animation_name or ""),
            "time": _number(scene.get("trackTime"), 0.0),
            "speed": _number(scene.get("playbackSpeed"), 1.0),
            "paused": bool(scene.get("isPaused", False)),
        },
        "camera": camera,
        "model": normalized_model,
        "texts": texts,
    }


def _enum_number(value: Any) -> int | None:
    """Return an integer enum value without treating booleans as numbers."""

    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            number = float(value.strip())
        except ValueError:
            return None
        if number.is_integer():
            return int(number)
    return None


def _normalize_text_enum(value: Any, labels: dict[int, str], default: str) -> str:
    number = _enum_number(value)
    if number is not None:
        return labels.get(number, str(value))
    text = str(value or "").strip()
    return text or default


def _normalize_font_style(value: Any, default: str = "Normal") -> str:
    number = _enum_number(value)
    if number is not None:
        if number == 0:
            return default
        bits = (
            (1, "Bold"),
            (2, "Italic"),
            (4, "Underline"),
            (8, "LowerCase"),
            (16, "UpperCase"),
            (32, "SmallCaps"),
            (64, "Strikethrough"),
            (128, "Superscript"),
            (256, "Subscript"),
            (512, "Highlight"),
        )
        names = [name for bit, name in bits if number & bit]
        return " ".join(names) if names else str(value)
    text = str(value or "").strip()
    return text or default


def _normalize_layer_side(value: Any) -> str:
    number = _enum_number(value)
    if number is not None:
        return "Behind" if number == 1 else "Front"
    return "Behind" if str(value or "").strip().casefold() == "behind" else "Front"


def _normalize_scene_text(text: dict[str, Any], index: int) -> dict[str, Any]:
    transform = text.get("transformData") if isinstance(text.get("transformData"), dict) else {}
    nested_style = text.get("style") if isinstance(text.get("style"), dict) else {}
    # Official EmoteLab builds use a nested ``style`` object.  A few hand
    # authored/older exports flatten these fields; use them only as fallbacks
    # so an explicit nested value always wins.
    style_fields = {
        "fontName",
        "fontSize",
        "fontStyle",
        "horizontalAlignment",
        "verticalAlignment",
        "characterSpacing",
        "lineSpacing",
        "autoSizeTextContainer",
        "enableAutoSizing",
        "enableWordWrapping",
        "overflowMode",
        "richText",
        "parseCtrlCharacters",
        "wordSpacing",
        "paragraphSpacing",
    }
    style = {key: text[key] for key in style_fields if key in text}
    style.update(nested_style)
    material = text.get("material") if isinstance(text.get("material"), dict) else {}
    normalized_transform = {
        **transform,
        "localPosition": _vector(
            transform.get("localPosition"),
            (0.0, 0.0, 0.0),
            ("x", "y", "z"),
        ),
        "rotationZ": _number(transform.get("rotationZ"), 0.0),
        "sortingOrder": int(_number(transform.get("sortingOrder"), 0.0)),
        "visible": bool(transform.get("visible", True)),
    }
    raw_text = style.get("text", text.get("text", ""))
    if raw_text is None:
        raw_text = ""
    normalized_style = {
        **style,
        "text": str(raw_text),
        # TextMeshPro serializes these enum fields as integers in Unity's
        # JsonUtility output.  Canonical labels keep the browser renderer
        # readable while the ``*Value`` fields retain the source number for
        # forward-compatible consumers.
        "fontName": str(style.get("fontName", "") or ""),
        "fontSize": _number(style.get("fontSize"), 36.0),
        "fontStyle": _normalize_font_style(style.get("fontStyle"), "Normal"),
        "horizontalAlignment": _normalize_text_enum(
            style.get("horizontalAlignment"),
            {1: "Left", 2: "Center", 4: "Right", 8: "Justified", 16: "Flush", 32: "Geometry"},
            "Left",
        ),
        "verticalAlignment": _normalize_text_enum(
            style.get("verticalAlignment"),
            {256: "Top", 512: "Middle", 1024: "Bottom", 2048: "Baseline", 4096: "Geometry", 8192: "Capline"},
            "Top",
        ),
        "characterSpacing": _number(style.get("characterSpacing"), 0.0),
        "lineSpacing": _number(style.get("lineSpacing"), 0.0),
        "wordSpacing": _number(style.get("wordSpacing"), 0.0),
        "paragraphSpacing": _number(style.get("paragraphSpacing"), 0.0),
        "autoSizeTextContainer": bool(style.get("autoSizeTextContainer", True)),
        "enableAutoSizing": bool(style.get("enableAutoSizing", False)),
        "enableWordWrapping": bool(style.get("enableWordWrapping", False)),
        "overflowMode": _normalize_text_enum(
            style.get("overflowMode"),
            {0: "Overflow", 1: "Ellipsis", 2: "Masking", 3: "Truncate", 4: "ScrollRect", 5: "Page", 6: "Linked"},
            "Overflow",
        ),
        "richText": bool(style.get("richText", True)),
        "parseCtrlCharacters": bool(style.get("parseCtrlCharacters", True)),
    }
    for field in ("fontStyle", "horizontalAlignment", "verticalAlignment", "overflowMode"):
        source_value = style.get(field)
        source_number = _enum_number(source_value)
        if source_number is not None:
            normalized_style[f"{field}Value"] = source_number
    normalized_material = {
        **material,
        "faceColor": _normalize_color(material.get("faceColor"))
        or {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0},
        "outlineColor": _normalize_color(material.get("outlineColor"))
        or {"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0},
        "underlayColor": _normalize_color(material.get("underlayColor"))
        or {"r": 0.0, "g": 0.0, "b": 0.0, "a": 0.0},
        "outlineEnabled": bool(material.get("outlineEnabled", False)),
        "outlineWidth": _number(material.get("outlineWidth"), 0.0),
        "faceDilate": _number(material.get("faceDilate"), 0.0),
        "underlayEnabled": bool(material.get("underlayEnabled", False)),
        "underlayDilate": _number(material.get("underlayDilate"), 0.0),
        "underlayOffsetX": _number(material.get("underlayOffsetX"), 0.0),
        "underlayOffsetY": _number(material.get("underlayOffsetY"), 0.0),
    }
    normalized_text = {
        **text,
        "name": str(text.get("name") or f"Text {index + 1}"),
        "side": _normalize_layer_side(text.get("side", "Front")),
        "transformData": normalized_transform,
        "style": normalized_style,
        "material": normalized_material,
    }
    side_number = _enum_number(text.get("side"))
    if side_number is not None:
        normalized_text["sideValue"] = side_number
    return normalized_text


def _vector(value: Any, default: tuple[float, ...], keys: tuple[str, ...]) -> list[float]:
    if isinstance(value, (list, tuple)):
        result = []
        for index, fallback in enumerate(default):
            result.append(_number(value[index] if index < len(value) else None, fallback))
        return result
    if isinstance(value, dict):
        return [_number(value.get(key), fallback) for key, fallback in zip(keys, default)]
    return list(default)


def _number(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(default)
    return number if number == number and abs(number) != float("inf") else float(default)


__all__ = [
    "EMOTE_TEMPLATE_SCHEMA_VERSION",
    "EmoteTemplatePackageError",
    "inspect_emotelab_zip",
]
