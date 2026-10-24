# -*- coding: utf-8 -*-
"""Emote template package inspection endpoints.

两个职责， deliberately separate：

- ``/import/emotelab`` 保持只读：上传的压缩包在内存里校验、瘦身成渲染中立的
  manifest，不落盘。
- ``/library`` 是「导入即拷副本」：导入成功后把整份 zip（和附带的补全贴图）
  存进用户数据目录，重开时直接从副本恢复，不再要求重新定位原件。
"""

from __future__ import annotations

import io
import os
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from main_logic.emote_template_adapter import (
    MAX_ARCHIVE_BYTES,
    EmoteTemplatePackageError,
    inspect_emotelab_zip,
)
from main_logic.emote_template_store import (
    EmoteTemplateArchiveStore,
    EmoteTemplateStoreError,
)
from .shared_state import get_config_manager


router = APIRouter(prefix="/api/emote-maker", tags=["emote-maker"])
_CHUNK_SIZE = 1024 * 1024
_EXPORT_FILE_LIMIT = 32 * 1024 * 1024
_EXPORT_HEADER = "x-neko-emote-export"
_INVALID_EXPORT_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


async def _read_upload(upload: UploadFile) -> bytes:
    if not upload or not upload.filename:
        raise EmoteTemplatePackageError("没有上传模板包")
    if not upload.filename.lower().endswith(".zip"):
        raise EmoteTemplatePackageError("请上传支持的模板文件")

    buffer = io.BytesIO()
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_ARCHIVE_BYTES:
            raise EmoteTemplatePackageError(
                f"模板包过大，当前导入上限为 {MAX_ARCHIVE_BYTES // (1024 * 1024)} MB"
            )
        buffer.write(chunk)
    return buffer.getvalue()


@router.post("/import/emotelab")
async def import_emotelab_template(file: UploadFile = File(...)):
    """Inspect one locally selected EmoteLab ZIP without persisting its assets."""

    try:
        content = await _read_upload(file)
        package = inspect_emotelab_zip(content, filename=file.filename or "")
    except EmoteTemplatePackageError as exc:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": str(exc)},
        )
    finally:
        await file.close()

    return JSONResponse(content={"success": True, "package": package})


# ── 导入即拷副本 ────────────────────────────────────────────────────────────
# 键走 query 参数而不是路径段：前端库条目键是 `包名::模型key::场景数::动画数`，
# 包名里完全可以有 `/`，进了路径段就把路由切碎了。
def _archive_store() -> EmoteTemplateArchiveStore:
    config_mgr = get_config_manager()
    if not config_mgr.ensure_emote_templates_directory():
        raise EmoteTemplateStoreError("本地模板目录不可用")
    return EmoteTemplateArchiveStore(config_mgr.emote_templates_dir)


def _store_error(exc: Exception, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": str(exc)})


async def _read_upload_bytes(upload: UploadFile, limit: int, label: str) -> bytes:
    buffer = io.BytesIO()
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise EmoteTemplateStoreError(f"{label}超过上限")
        buffer.write(chunk)
    return buffer.getvalue()


@router.get("/library")
async def list_template_library():
    try:
        store = _archive_store()
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=500)
    entries = store.list()
    return {
        "success": True,
        "entries": entries,
        "totalBytes": sum(entry["bytes"] for entry in entries),
    }


@router.post("/library/archive")
async def save_template_library_archive(
    key: str = Query(...),
    file: UploadFile = File(...),
    textures: list[UploadFile] | None = File(None),
    texture_paths: list[str] | None = Form(None),
):
    try:
        store = _archive_store()
        archive = await _read_upload_bytes(file, MAX_ARCHIVE_BYTES, "模板包")
        paths = [str(path or "") for path in (texture_paths or [])]
        blobs: list[tuple[str, bytes]] = []
        for index, texture in enumerate(textures or []):
            # 路径数组与文件数组按位对齐；缺的那份退回文件名，路径不合法会被 store 拒掉
            relative = paths[index] if index < len(paths) else (texture.filename or "")
            blobs.append((relative, await _read_upload_bytes(
                texture, MAX_ARCHIVE_BYTES, "附带贴图")))
        entry = store.save(key, archive, blobs, filename=file.filename or "")
    except EmoteTemplateStoreError as exc:
        return _store_error(exc)
    finally:
        await file.close()
        for texture in textures or []:
            await texture.close()
    return JSONResponse(content={"success": True, "entry": entry})


@router.get("/library/archive")
async def open_template_library_archive(key: str = Query(...)):
    try:
        store = _archive_store()
        path = store.archive_path(key)
        name = store.archive_name(key)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=404)
    # 原始文件名走自定义头带回：Content-Disposition 对非 ASCII 会拆成 filename*，
    # 客户端解析容易踩坑；这里给一个 URL 编码过的现成值
    return FileResponse(
        path, filename=name, media_type="application/zip",
        headers={"X-Archive-Filename": quote(name)},
    )


@router.get("/library/textures")
async def list_template_library_textures(key: str = Query(...)):
    try:
        store = _archive_store()
        store.archive_path(key)
        paths = store.texture_paths(key)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=404)
    return JSONResponse(content={"success": True, "paths": paths})


@router.post("/library/textures")
async def merge_template_library_textures(
    key: str = Query(...),
    textures: list[UploadFile] | None = File(None),
    texture_paths: list[str] | None = Form(None),
):
    try:
        store = _archive_store()
        paths = [str(path or "") for path in (texture_paths or [])]
        blobs: list[tuple[str, bytes]] = []
        for index, texture in enumerate(textures or []):
            relative = paths[index] if index < len(paths) else (texture.filename or "")
            blobs.append((relative, await _read_upload_bytes(
                texture, MAX_ARCHIVE_BYTES, "附带贴图")))
        result = store.save_textures(key, blobs)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=404 if "还没有本地副本" in str(exc) else 400)
    finally:
        for texture in textures or []:
            await texture.close()
    return JSONResponse(content={"success": True, **result})


@router.post("/library/textures/remove")
async def remove_template_library_texture(
    key: str = Query(...),
    texture_paths: list[str] | None = Form(None),
):
    try:
        store = _archive_store()
        for path in (texture_paths or []):
            store.remove_texture(key, path)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=404)
    return JSONResponse(content={"success": True})


@router.get("/library/texture")
async def open_template_library_texture(key: str = Query(...), path: str = Query(...)):
    try:
        target = _archive_store().texture_path(key, path)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=404)
    return FileResponse(target, filename=target.name, media_type="image/png")


@router.delete("/library")
async def delete_template_library_archive(key: str = Query(...)):
    try:
        result = _archive_store().delete(key)
    except EmoteTemplateStoreError as exc:
        return _store_error(exc, status=500)
    return JSONResponse(content={"success": True, **result})


class ExportWriteError(Exception):
    pass


class ExportFolderBody(BaseModel):
    directory: str = Field(min_length=1, max_length=4096)
    folder: str = Field(default="group", max_length=120)


class ExportZipBody(BaseModel):
    directory: str = Field(min_length=1, max_length=4096)
    folder: str = Field(min_length=1, max_length=120)
    names: list[str] = Field(default_factory=list, max_length=400)
    zip_name: str = Field(default="", max_length=120)


def _reject_unscoped_export(request: Request) -> JSONResponse | None:
    # 自定义头让跨站表单写不进来；本页 fetch 会带上。
    if request.headers.get(_EXPORT_HEADER) != "1":
        return JSONResponse(status_code=403, content={"success": False, "error": "拒绝写入"})
    return None


def _export_error(exc: Exception, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": str(exc)})


def _safe_export_segment(value: str, fallback: str = "group") -> str:
    cleaned = _INVALID_EXPORT_NAME.sub("_", str(value or ""))
    cleaned = cleaned.strip().strip(".").strip()[:80]
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    return cleaned


def _safe_export_file_name(value: str) -> str:
    text = str(value or "")
    if not text or text != Path(text).name or text in {".", ".."}:
        raise ExportWriteError("文件名不合法")
    if any(ord(char) < 32 for char in text):
        raise ExportWriteError("文件名不合法")
    return text


def _existing_export_directory(raw: str) -> Path:
    text = str(raw or "").strip()
    if not text:
        raise ExportWriteError("没有导出目录")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ExportWriteError("导出目录必须是绝对路径")
    try:
        resolved = Path(os.path.realpath(path))
    except OSError as exc:
        raise ExportWriteError("导出目录不可用") from exc
    if not resolved.is_dir():
        raise ExportWriteError("导出目录不存在")
    return resolved


def _direct_child(parent: Path, name: str) -> Path:
    child = parent / name
    try:
        child_real = Path(os.path.realpath(child))
        parent_real = Path(os.path.realpath(parent))
    except OSError as exc:
        raise ExportWriteError("导出路径不可用") from exc
    if os.path.normcase(str(child_real.parent)) != os.path.normcase(str(parent_real)):
        raise ExportWriteError("导出路径超出了所选目录")
    return child_real


def _create_export_folder(parent: Path, folder: str) -> str:
    name = _safe_export_segment(folder, "group")
    candidate = name
    for index in range(2, 500):
        try:
            (parent / candidate).mkdir(parents=False, exist_ok=False)
            return candidate
        except FileExistsError:
            candidate = f"{name} {index}"
    raise ExportWriteError("没法在这个目录里建文件夹")


def _unique_export_file(parent: Path, name: str) -> Path:
    safe = _safe_export_file_name(name)
    candidate = parent / safe
    if not candidate.exists():
        return candidate
    stem = Path(safe).stem
    suffix = Path(safe).suffix
    for index in range(2, 500):
        nxt = parent / f"{stem} {index}{suffix}"
        if not nxt.exists():
            return nxt
    raise ExportWriteError("没法写入压缩包")


@router.post("/export/folder")
async def create_export_folder(body: ExportFolderBody, request: Request):
    """在用户选好的目录里建一个不重名的子文件夹。只接受本页发起的请求。"""

    rejected = _reject_unscoped_export(request)
    if rejected is not None:
        return rejected
    try:
        directory = _existing_export_directory(body.directory)
        folder = _create_export_folder(directory, body.folder)
    except ExportWriteError as exc:
        return _export_error(exc)
    return JSONResponse(content={
        "success": True,
        "directory": str(directory),
        "folder": folder,
    })


@router.post("/export/file")
async def write_export_file(
    request: Request,
    directory: str = Form(...),
    folder: str = Form(...),
    name: str = Form(...),
    file: UploadFile = File(...),
):
    try:
        rejected = _reject_unscoped_export(request)
        if rejected is not None:
            return rejected
        parent = _existing_export_directory(directory)
        child = _direct_child(parent, _safe_export_segment(folder, "group"))
        if not child.is_dir():
            raise ExportWriteError("导出文件夹不存在")
        file_name = _safe_export_file_name(name)
        target = _direct_child(child, file_name)
        payload = await _read_limited_upload(file, _EXPORT_FILE_LIMIT)
        target.write_bytes(payload)
    except ExportWriteError as exc:
        return _export_error(exc)
    except OSError:
        return _export_error(ExportWriteError("没法写入这个文件"))
    finally:
        await file.close()
    return JSONResponse(content={"success": True})


@router.post("/export/zip")
async def zip_export_folder(body: ExportZipBody, request: Request):
    rejected = _reject_unscoped_export(request)
    if rejected is not None:
        return rejected
    try:
        parent = _existing_export_directory(body.directory)
        child = _direct_child(parent, _safe_export_segment(body.folder, "group"))
        if not child.is_dir():
            raise ExportWriteError("导出文件夹不存在")
        zip_label = _safe_export_segment(body.zip_name or f"{child.name}.zip", f"{child.name}.zip")
        if not zip_label.lower().endswith(".zip"):
            zip_label = f"{zip_label}.zip"
        archive_path = _unique_export_file(parent, zip_label)
        try:
            with zipfile.ZipFile(
                archive_path, "w", compression=zipfile.ZIP_DEFLATED,
            ) as archive:
                for name in body.names:
                    file_name = _safe_export_file_name(name)
                    source = _direct_child(child, file_name)
                    if not source.is_file():
                        raise ExportWriteError("要打包的文件不在文件夹里")
                    archive.write(source, arcname=file_name)
        except ExportWriteError:
            archive_path.unlink(missing_ok=True)
            raise
        except OSError as exc:
            archive_path.unlink(missing_ok=True)
            raise ExportWriteError("没法写入压缩包") from exc
    except ExportWriteError as exc:
        return _export_error(exc)
    return JSONResponse(content={"success": True, "zip": archive_path.name})


async def _read_limited_upload(upload: UploadFile, limit: int) -> bytes:
    buffer = io.BytesIO()
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ExportWriteError("单个导出文件过大")
        buffer.write(chunk)
    return buffer.getvalue()


__all__ = ["router"]
