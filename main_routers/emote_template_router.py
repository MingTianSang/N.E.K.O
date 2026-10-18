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
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

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


@router.get("/template-schema")
async def get_emote_template_schema():
    """Expose the adapter version for the frontend/provider registry."""

    return {
        "schemaVersion": 1,
        "sources": ["emotelab"],
        "renderers": {
            "raster": {"available": True},
            "spine": {
                "available": True,
                "mode": "client-lazy",
                "runtimeVersion": "4.3.13",
                "compatibleModelFamily": "4.3.x",
                "reason": "浏览器端按需加载官方 Spine 4.3 WebGL 运行时；模板资源仍只在本地内存中使用",
            },
        },
    }


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


__all__ = ["router"]
