# Copyright 2025-2026 Project N.E.K.O. Team
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Molili archive parser: mapping, limits and security-boundary tests.

Fixtures mirror the real export structure (molili-user-data-export schema 1):
manifest counts, personality file quadruplet, long_term.jsonl v1/cache dual
format, diary and event same-day merging, attachments only in skip report."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import zipfile

import pytest

from memory.external_markdown_import import ExternalMemoryImportError, MAX_ENTRIES
from memory.external_molili_import import build_molili_candidates, detect_molili_archive


def _molili_members() -> dict[str, str]:
    manifest = {
        "format": "molili-user-data-export",
        "schema_version": 1,
        "task_id": "task",
        "user_id": "user",
        "snapshot_time": "2026-10-15T13:15:28.415+08:00",
        "timezone": "Asia/Shanghai",
        "counts": {
            "conversation_messages": 794,
            "diaries": 1,
            "personality_agents": 1,
            "personality_files": 4,
            "attachment_files": 1,
            "owned_items": 3,
            "volc_memory_records": 2,
            "cached_memory_records": 1,
        },
    }
    long_term = [
        {
            "memory_type": "profile_v1",
            "content": json.dumps(
                {
                    "基础信息": {"昵称": "璃琉期"},
                    "兴趣偏好": {"食物": ["[+]喜欢猫薄荷"]},
                },
                ensure_ascii=False,
            ),
        },
        {
            "memory_type": "event_v1",
            "time_iso": "2026-08-24T13:58:58.796+08:00",
            "memory_info": {"original_messages": "对话原文", "summary": "八月二十四日用户为称呼道歉"},
        },
        {
            "memory_type": "event_v1",
            "time_iso": "2026-08-25T14:11:01+08:00",
            "memory_info": {"summary": "八月二十五日约定去看以太之花"},
        },
        {"memory_type": "event_cache", "content": "[]"},
    ]
    return {
        "manifest.json": json.dumps(manifest, ensure_ascii=False),
        "personality/1_74000/role_prompt.md":
            "## 自然属性\n\n你是言叶 (Kotonoha)【重要，请按此翻译】、18岁，猫瑞人。\n"
            "## 👍 言叶性格\n\n核心气质为抑郁质与胆汁质混合。\n",
        "personality/1_74000/trait_profile.md": "抑郁质与胆汁质的混合类型。情感体验深刻。\n",
        "personality/1_74000/interaction_profile.md": "交互习惯以渴望深度连接为基础。\n",
        "personality/1_74000/cognitive.md":
            "1. [重要设定]我有生成图片的能力 (@2026-08-24 14:06:00)\n"
            "2. [重要设定]必须用「言叶」称呼我 (@2026-08-28 13:51:48)\n",
        "memory/long_term.jsonl": "\n".join(
            json.dumps(record, ensure_ascii=False) for record in long_term
        ),
        "diaries/diaries.jsonl": json.dumps(
            {"type": 1, "date": "2026-08-24", "content": "今天写第一篇日记，终于连上了。"},
            ensure_ascii=False,
        ),
        "game/progress.json": json.dumps(
            {
                "favor": [{
                    "total_favor": 2086, "level": 22, "level_favor": 80,
                    "updated_at": "2026-10-14T16:25:00+08:00",
                }],
                "owned_items": ["a", "b", "c"],
            },
            ensure_ascii=False,
        ),
        "attachments/input/1.png": "not-really-an-image",
        "conversations/history.jsonl": json.dumps({"role": "user", "content": "hi"}),
    }


def _zip_bytes(members: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, text in members.items():
            archive.writestr(path, text)
    return buffer.getvalue()


def _molili_zip() -> bytes:
    return _zip_bytes(_molili_members())


def test_molili_archive_maps_to_layers():
    analysis = build_molili_candidates(_molili_zip())

    assert analysis["source_format"] == "molili"
    card = analysis["character_card"]
    assert card["suggested_name"] == "言叶"
    assert "自然属性" in card["system_prompt"]
    # role_prompt 按 ## 标题拆节（tag=节标题、emoji 清理），不再是单一设定整块
    assert [s["tag"] for s in card["sections"]] == ["自然属性", "言叶性格"]
    assert "抑郁质" in card["sections"][1]["text"]
    assert "👍" not in json.dumps(card["sections"], ensure_ascii=True)

    neko_persona = [c for c in analysis["candidates"]
                    if c["target"] == "persona" and c["entity"] == "neko"]
    sections = {c["source_section"] for c in neko_persona}
    assert {"特质人格", "交互习惯", "重要设定"} <= sections
    # 好感度快照改走「Molili 我的档案」字段（卡面受保护事实），不进 persona
    # 候选——避免与分节卡面事实话题重叠被矛盾守卫误拒
    # 好感度为 Molili 游戏属性，不迁移（卡面/记忆/我的档案均不出现）
    assert "好感度" not in analysis["master_profile"]
    assert not any("好感度" in c["text"] for c in analysis["candidates"])

    master_persona = [c for c in analysis["candidates"]
                      if c["target"] == "persona" and c["entity"] == "master"]
    assert any("喜欢猫薄荷" in c["text"] for c in master_persona)
    # 身份字段（基本信息）拆出 master_profile，不进记忆候选：避免与全局主人卡
    # 冲突被人格守卫整条拒绝
    assert analysis["master_profile"] == {"昵称": "璃琉期"}
    assert not any("璃琉期" in c["text"] for c in analysis["candidates"])

    daily = [c for c in analysis["candidates"] if c["kind"] == "daily"]
    assert {c["target"] for c in daily} == {"facts"}
    assert {c["source_file"] for c in daily} == {
        "molili/memory/2026-08-24.md",
        "molili/memory/2026-08-25.md",
    }
    assert {c["event_date"] for c in daily} == {"2026-08-24", "2026-08-25"}
    # 同一天的日记与事件合并进同一个 daily 文件
    same_day = [c for c in daily if c["source_file"] == "molili/memory/2026-08-24.md"]
    assert {c["source_section"] for c in same_day} == {"记忆", "日记"}

    skipped = analysis["skipped"]
    assert skipped["attachments"]["count"] == 1
    assert skipped["conversation_messages"] == 794
    assert skipped["cache_memory_records"] == 1
    assert skipped["owned_items"] == 3
    # 附件与原始对话绝不进候选
    assert not any(c["source_file"].startswith(("attachments/", "conversations/"))
                   for c in analysis["candidates"])


def test_molili_detect_sniffs_manifest():
    assert detect_molili_archive(_molili_zip()) is True
    assert detect_molili_archive(_zip_bytes({"readme.txt": "hello"})) is False
    assert detect_molili_archive(b"not a zip") is False


def test_molili_rejects_format_mismatch():
    members = _molili_members()
    members["manifest.json"] = json.dumps({"format": "something-else", "schema_version": 1})
    with pytest.raises(ExternalMemoryImportError, match="manifest format"):
        build_molili_candidates(_zip_bytes(members))


def test_molili_rejects_malformed_jsonl():
    members = _molili_members()
    members["memory/long_term.jsonl"] = "{not json}\n"
    with pytest.raises(ExternalMemoryImportError, match="malformed JSONL"):
        build_molili_candidates(_zip_bytes(members))


def test_molili_skips_unsafe_zip_paths_without_raising():
    members = _molili_members()
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, text in members.items():
            archive.writestr(path, text)
        archive.writestr("../escape.md", "injected")
    analysis = build_molili_candidates(raw.getvalue())

    assert not any(c["source_file"] == "../escape.md" for c in analysis["candidates"])
    assert "../escape.md" in analysis["skipped"]["attachments"]["samples"]


def test_molili_caps_entries_at_limit():
    members = _molili_members()
    events = [
        {
            "memory_type": "event_v1",
            "time_iso": f"2026-09-{(i % 28) + 1:02d}T10:00:00+08:00",
            "memory_info": {"summary": f"事件 {i}：彼此不同的记忆内容 {i} 号"},
        }
        for i in range(MAX_ENTRIES + 2)
    ]
    members["memory/long_term.jsonl"] = "\n".join(
        json.dumps(record, ensure_ascii=False) for record in events
    )
    with pytest.raises(ExternalMemoryImportError, match="too many entries"):
        build_molili_candidates(_zip_bytes(members))


def test_molili_dedupes_repeated_event_summaries():
    members = _molili_members()
    events = [
        {
            "memory_type": "event_v1",
            "time_iso": "2026-08-24T13:58:58.796+08:00",
            "memory_info": {"summary": "同一句话出现了两次"},
        },
        {
            "memory_type": "event_v1",
            "time_iso": "2026-08-24T15:00:00+08:00",
            "memory_info": {"summary": "同一句话出现了两次"},
        },
    ]
    members["memory/long_term.jsonl"] = "\n".join(
        json.dumps(record, ensure_ascii=False) for record in events
    )
    analysis = build_molili_candidates(_zip_bytes(members))

    daily_texts = [c["text"] for c in analysis["candidates"] if c["kind"] == "daily"]
    assert daily_texts.count("记忆： 同一句话出现了两次") == 1


def test_molili_identity_falls_back_to_profile_cache():
    """The volc-flavored profile_v1 carries a null basic-info: identity falls back to the structured profile_cache record."""
    members = _molili_members()
    long_term = [
        {
            "memory_type": "profile_cache",
            "content": json.dumps({"基础信息": {"昵称": "璃琉期"}}, ensure_ascii=False),
        },
        {
            "memory_type": "profile_v1",
            "content": json.dumps(
                {"基础信息": None, "兴趣偏好": {"食物": ["[+]喜欢猫薄荷"]}},
                ensure_ascii=False,
            ),
        },
    ]
    members["memory/long_term.jsonl"] = "\n".join(
        json.dumps(record, ensure_ascii=False) for record in long_term
    )
    analysis = build_molili_candidates(_zip_bytes(members))

    assert analysis["master_profile"] == {"昵称": "璃琉期"}
    assert not any("璃琉期" in c["text"] for c in analysis["candidates"])
    assert any("喜欢猫薄荷" in c["text"] for c in analysis["candidates"]
               if c["entity"] == "master")


def test_molili_identity_key_is_jichu_not_jiben():
    """Regression anchor: the identity key uses U+7840, not the lookalike U+672C form (both render as CJK in console)."""
    wrong_key = "基" + chr(0x672C) + "信息"
    right_key = "基" + chr(0x7840) + "信息"
    members = _molili_members()
    members["memory/long_term.jsonl"] = json.dumps(
        {
            "memory_type": "profile_v1",
            "content": json.dumps(
                {wrong_key: {"昵称": "璃琉期"}, "兴趣偏好": {"食物": ["[+]喜欢猫薄荷"]}},
                ensure_ascii=False,
            ),
        },
        ensure_ascii=False,
    )
    analysis = build_molili_candidates(_zip_bytes(members))
    assert analysis["master_profile"] == {}

    members["memory/long_term.jsonl"] = json.dumps(
        {
            "memory_type": "profile_v1",
            "content": json.dumps(
                {right_key: {"昵称": "璃琉期"}, "兴趣偏好": {"食物": ["[+]喜欢猫薄荷"]}},
                ensure_ascii=False,
            ),
        },
        ensure_ascii=False,
    )
    analysis = build_molili_candidates(_zip_bytes(members))
    assert analysis["master_profile"] == {"昵称": "璃琉期"}


def test_molili_sections_dedupe_and_emoji_cleanup():
    """Duplicate section titles dedupe; emoji is cleaned from titles and bodies; CJK bodies are unaffected."""
    members = _molili_members()
    members["personality/1_74000/role_prompt.md"] = (
        "## 👍 关键正面规则\n\n坚持口语化聊天风格喵。\n\n"
        "## 👍 关键正面规则\n\n重复标题去重。\n"
    )
    analysis = build_molili_candidates(_zip_bytes(members))
    sections = analysis["character_card"]["sections"]

    assert [s["tag"] for s in sections] == ["关键正面规则", "关键正面规则 2"]
    assert "喵" in sections[0]["text"]  # 清理不伤 CJK 正文
    assert "👍" not in json.dumps(sections, ensure_ascii=True)


def test_molili_inline_files_mode():
    members = _molili_members()
    files = [{"path": path, "content": text} for path, text in members.items()]
    analysis = build_molili_candidates(files=files, source_format="molili")

    assert analysis["source_format"] == "molili"
    assert analysis["character_card"]["suggested_name"] == "言叶"
    assert any(c["kind"] == "daily" for c in analysis["candidates"])


def test_router_preview_dispatches_molili_zip():
    """The preview endpoint sniffs auto archives and routes Molili zips to the new parser, carrying card prefill material."""
    from main_routers.memory_router import preview_external_memory_import

    class _FakeRequest:
        def __init__(self, payload):
            self._payload = payload

        async def json(self):
            return self._payload

    payload = {
        "character_name": "言叶",
        "archive_b64": base64.b64encode(_molili_zip()).decode("ascii"),
    }
    result = asyncio.run(preview_external_memory_import(_FakeRequest(payload)))

    assert result["success"] is True
    assert result["source_format"] == "molili"
    assert result["character_card"]["suggested_name"] == "言叶"
    assert result["master_profile"] == {"昵称": "璃琉期"}
    # persona 融合按 entity 分组：neko（特质/交互/设定/好感度）+ master（画像）
    assert result["persona_fusion_calls"] == 2
    # 两个日期文件 → 2 次逐日抽取
    assert result["daily_extraction_calls"] == 2
    assert result["skipped"]["attachments"]["count"] == 1
