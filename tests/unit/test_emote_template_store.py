# -*- coding: utf-8 -*-
"""「导入即拷副本」的存储规则：覆盖语义、真实占用、路径安全。

存取本体（main_logic/emote_template_store.py）不依赖 FastAPI，直接用 tmp_path 单测；
路由层只补两件事：multipart 的对齐解析、错误码。规则本身在这里钉死：

- 同键再导一次 = 原地替换，不会攒出第二份；
- bytes 一律来自 stat，不是保存时记的数；
- 贴图路径永远是仓库内部相对路径。
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from main_logic import emote_template_store as store_module
from main_logic.emote_template_store import (
    EmoteTemplateArchiveStore,
    EmoteTemplateStoreError,
    dir_key_for,
)


def _zip(content: bytes | str = b"template") -> bytes:
    payload = content.encode("utf-8") if isinstance(content, str) else content
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("wrapper/model.json", payload.decode("utf-8", "ignore"))
    return stream.getvalue()


@pytest.fixture()
def store(tmp_path: Path) -> EmoteTemplateArchiveStore:
    return EmoteTemplateArchiveStore(tmp_path / "emote_templates")


def test_save_list_delete_roundtrip_reports_real_bytes(store, tmp_path):
    key = "YUI 道具::ModelA::191::191"
    entry = store.save(key, _zip())
    assert entry["key"] == key

    listed = store.list()
    assert [item["key"] for item in listed] == [key]
    # bytes 是 stat 出来的真实占用：往贴图目录里再塞一张图，数字必须跟着涨
    texture = store._entry_dir(key) / "textures" / "Cache" / "a.png"
    texture.parent.mkdir(parents=True)
    texture.write_bytes(b"12345")
    assert store.list()[0]["bytes"] == entry["bytes"] + 5

    assert store.archive_path(key).read_bytes() == _zip()
    assert store.texture_paths(key) == ["Cache/a.png"]
    assert store.texture_path(key, "Cache/a.png") == texture

    freed = store.delete(key)
    assert freed["freedBytes"] == entry["bytes"] + 5
    assert store.list() == []
    assert not store.has(key)
    # 再删一次不报错：删不存在的东西等于没删
    assert store.delete(key)["freedBytes"] == 0


def test_resaving_the_same_key_replaces_instead_of_piling_up(store):
    key = "pkg::model::3::3"
    store.save(key, _zip("old"), [("Texture Cache/a.png", b"old-tex")])
    store.save(key, _zip("new-content-here"), [])
    listed = store.list()
    assert len(listed) == 1, "同键再导必须原地替换，不能攒出第二份副本"
    assert store.archive_path(key).read_bytes() == _zip("new-content-here")
    # 替换就是替换：没随新包带来的贴图不保留（原件语义，没有合并）
    assert store.texture_paths(key) == []


def test_two_keys_never_share_a_directory_even_with_slashes(store, tmp_path):
    weird = "a/b::c d::1::2"
    other = "a/b::c d::1::3"
    store.save(weird, _zip("w"))
    store.save(other, _zip("o"))
    assert len(store.list()) == 2
    # 键里的 `/` 不许变成目录层级；磁盘名是 sha256
    assert dir_key_for(weird) == dir_key_for(weird)
    assert dir_key_for(weird) != dir_key_for(other)
    assert "/" not in dir_key_for(weird)
    assert store.archive_path(weird).read_bytes() == _zip("w")


def test_texture_paths_are_sandboxed(store):
    key = "k"
    store.save(key, _zip(), [("Texture Cache/Custom Textures/x.png", b"png")])
    assert store.texture_path(key, "Texture Cache/Custom Textures/x.png").read_bytes() == b"png"

    for evil in (
        "../escape.png",
        "a/../../escape.png",
        "/abs.png",
        "C:/abs.png",
        "ok.txt",
        "",
    ):
        with pytest.raises(EmoteTemplateStoreError):
            store.texture_path(key, evil)


def test_save_rejects_bad_input(store, monkeypatch):
    with pytest.raises(EmoteTemplateStoreError):
        store.save("", _zip())
    with pytest.raises(EmoteTemplateStoreError):
        store.save("k", b"")
    with pytest.raises(EmoteTemplateStoreError):
        store.save("k", _zip(), [("../evil.png", b"x")])
    monkeypatch.setattr(store_module, "MAX_ARCHIVE_BYTES", 10)
    with pytest.raises(EmoteTemplateStoreError):
        store.save("k", _zip())
    # 超限的贴图同理
    monkeypatch.setattr(store_module, "MAX_ARCHIVE_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(store_module, "MAX_TEXTURE_BYTES", 2)
    with pytest.raises(EmoteTemplateStoreError):
        store.save("k", _zip(), [("a.png", b"xxxx")])


def test_staging_leftovers_are_invisible(store):
    store.save("k", _zip())
    junk = store.root / ".uploading-crashed"
    junk.mkdir(parents=True)
    (junk / "template.zip").write_bytes(_zip())
    assert len(store.list()) == 1
    assert store.total_bytes() == store.list()[0]["bytes"]


# ── 路由层：multipart 对齐 + 错误码 ─────────────────────────────────────────
@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import main_routers.emote_template_router as router_module

    app = FastAPI()
    app.include_router(router_module.router)
    monkeypatch.setattr(
        router_module, "_archive_store",
        lambda: EmoteTemplateArchiveStore(tmp_path / "emote_templates"),
    )
    return TestClient(app)


def test_router_roundtrip_with_textures(client):
    key = "demo::Demo::2::2"
    response = client.post(
        "/api/emote-maker/library/archive",
        params={"key": key},
        files={
            "file": ("my-template.zip", _zip("router"), "application/zip"),
            "textures": ("x.png", b"png-bytes", "image/png"),
        },
        data={"texture_paths": "Texture Cache/Custom Textures/x.png"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["entry"]["key"] == key
    assert response.json()["entry"]["textures"] == ["Texture Cache/Custom Textures/x.png"]

    listed = client.get("/api/emote-maker/library").json()
    assert listed["totalBytes"] == listed["entries"][0]["bytes"] > 0

    archive = client.get("/api/emote-maker/library/archive", params={"key": key})
    assert archive.status_code == 200
    assert archive.content == _zip("router")
    # 原始文件名要原样归还：库键的第一段就是它，弄丢等于把模板分裂成两个身份
    assert archive.headers["X-Archive-Filename"] == "my-template.zip"

    paths = client.get("/api/emote-maker/library/textures", params={"key": key}).json()
    assert paths["paths"] == ["Texture Cache/Custom Textures/x.png"]
    texture = client.get("/api/emote-maker/library/texture", params={
        "key": key, "path": "Texture Cache/Custom Textures/x.png"})
    assert texture.status_code == 200

    freed = client.delete("/api/emote-maker/library", params={"key": key}).json()
    assert freed["freedBytes"] > 0
    assert client.get("/api/emote-maker/library").json()["entries"] == []


def test_router_rejects_texture_escape_and_missing_archive(client):
    bad = client.post(
        "/api/emote-maker/library/archive",
        params={"key": "k"},
        files={
            "file": ("template.zip", _zip(), "application/zip"),
            "textures": ("x.png", b"png", "image/png"),
        },
        data={"texture_paths": "../evil.png"},
    )
    assert bad.status_code == 400

    missing = client.get("/api/emote-maker/library/archive", params={"key": "nope"})
    assert missing.status_code == 404


def test_late_textures_merge_into_the_existing_copy(store):
    """导入之后才补的贴图：同路径覆盖、其余保留；没有副本时明确拒绝。"""
    key = "k"
    store.save(key, _zip())
    with pytest.raises(EmoteTemplateStoreError):
        store.save_textures("no-copy-yet", [("a.png", b"x")])

    store.save_textures(key, [("Tex/a.png", b"one")])
    store.save_textures(key, [("Tex/a.png", b"two"), ("Tex/b.png", b"b")])
    assert store.texture_path(key, "Tex/a.png").read_bytes() == b"two"
    assert store.texture_path(key, "Tex/b.png").read_bytes() == b"b"

    with pytest.raises(EmoteTemplateStoreError):
        store.save_textures(key, [("../escape.png", b"x")])
