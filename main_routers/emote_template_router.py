# -*- coding: utf-8 -*-
"""Emote template package inspection endpoints.

The endpoint is intentionally read-only: uploaded EmoteLab archives are
validated in memory and reduced to a renderer-neutral manifest.  Native Spine
assets are not copied into ``static`` or persisted by this router; the browser
owns the short-lived asset store used by the optional renderer.
"""

from __future__ import annotations

import io

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse

from main_logic.emote_template_adapter import (
    MAX_ARCHIVE_BYTES,
    EmoteTemplatePackageError,
    inspect_emotelab_zip,
)


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


__all__ = ["router"]
