# -*- coding: utf-8 -*-
"""Contract tests for the renderer-neutral EmoteLab importer."""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from main_logic.emote_template_adapter import (
    EmoteTemplatePackageError,
    inspect_emotelab_zip,
)


def _package(
    *,
    character_key: str = "Demo",
    character_root: str = "Demo",
    outline: bool = False,
    texts: list | None = None,
) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root = "wrapper/EmoteLab"
        archive.writestr(
            f"{root}/SpineModels/Demo/model.meta.json",
            json.dumps({"DisplayName": "Demo", "SharedModelKey": "Demo"}),
        )
        archive.writestr(f"{root}/SpineModels/Demo/Demo.skel.bytes", b"4.3.23")
        archive.writestr(
            f"{root}/SpineModels/Demo/Demo.atlas.txt",
            "Page.png\nsize: 2, 3\nscale: 0.5\n",
        )
        archive.writestr(f"{root}/SpineModels/Demo/Page.png", b"not-a-png")
        for name, header, row in (
            (
                "Animations.csv",
                "AnimationName,DisplayName,en,zh-Hans",
                "ANIM/Demo,Demo,Demo,演示",
            ),
            ("SkinGroups.csv", "GroupName,DisplayName,en", "Hair,Hair,Hair"),
            ("Sliders.csv", "SliderName,DisplayName,en", "Character/X,X,X"),
            ("SlotGroups.csv", "GroupName,DisplayName,en", "Body,Body,Body"),
        ):
            archive.writestr(
                f"{root}/SpineModels/Demo/DisplayInfo/{name}",
                f"{header}\n{row}\n",
            )
        archive.writestr(
            f"{root}/Characters/{character_root}/Demo.json",
            json.dumps(
                {
                    "SharedModelKey": character_key,
                    "ActiveSkins": {"Items": [{"Key": "Hair", "Value": "A"}]},
                    "SliderConstraints": [],
                    "SlotGroups": [],
                }
            ),
        )
        archive.writestr(
            f"{root}/SceneLists/Demo/Demo.json",
            json.dumps(
                {
                    "sharedModelKey": "Demo",
                    "scenes": [
                        {
                            "name": "One",
                            "animationName": "ANIM/Demo",
                            "cameraPosition": {"x": 1, "y": 2, "z": 3},
                            "model": {"outlineEnabled": outline},
                            "texts": texts or [],
                        }
                    ],
                }
            ),
        )
    return stream.getvalue()


def test_normalizes_emotelab_model_character_and_scene():
    result = inspect_emotelab_zip(_package(), filename="demo.zip")

    assert result["schemaVersion"] == 1
    assert result["source"]["sharedModelKey"] == "Demo"
    assert result["source"]["spineVersion"] == "4.3.23"
    assert result["counts"] == {
        "atlasPages": 1,
        "animations": 1,
        "skinGroups": 1,
        "sliders": 1,
        "slotGroups": 1,
        "sceneLists": 1,
        "scenes": 1,
        "activeSkins": 1,
    }
    assert result["scenes"][0]["camera"]["position"] == [1.0, 2.0, 3.0]
    assert result["capabilities"]["spineRender"] is False
    assert result["capabilities"]["characterSlotTint"] is True
    assert result["capabilities"]["sceneOutline"] is True
    assert result["capabilities"]["sceneText"] is True


def test_reports_character_key_mismatch_without_rewriting_it():
    result = inspect_emotelab_zip(
        _package(character_key="LegacyDemo", character_root="LegacyDemo")
    )

    assert result["character"]["sharedModelKey"] == "LegacyDemo"
    assert any("不一致" in warning for warning in result["warnings"])


def test_prefers_character_directory_matching_model_over_legacy_shared_key():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root = "wrapper/EmoteLab"
        archive.writestr(
            f"{root}/SpineModels/YUI_PropsV1/model.meta.json",
            json.dumps({"DisplayName": "YUI", "SharedModelKey": "CoffeeBean"}),
        )
        archive.writestr(f"{root}/SpineModels/YUI_PropsV1/YUI_PropsV1.skel.bytes", b"4.3.23")
        archive.writestr(
            f"{root}/SpineModels/YUI_PropsV1/YUI_PropsV1.atlas.txt",
            "Page.png\nsize: 2, 3\nscale: 0.5\n",
        )
        archive.writestr(f"{root}/SpineModels/YUI_PropsV1/Page.png", b"not-a-png")
        archive.writestr(
            f"{root}/Characters/CoffeeBean/YUI_BlueLace/YUI_BlueLace.json",
            json.dumps(
                {
                    "SharedModelKey": "CoffeeBean",
                    "ActiveSkins": {"Items": [{"Key": "Hat", "Value": "Hat_A_Custom"}]},
                }
            ),
        )
        archive.writestr(
            f"{root}/Characters/YUI_PropsV1/YUI_PropsV1/YUI_PropsV1.json",
            json.dumps(
                {
                    "SharedModelKey": "CoffeeBean",
                    "ActiveSkins": {"Items": [{"Key": "Hat", "Value": "Hat_C_Custom"}]},
                }
            ),
        )
        archive.writestr(
            f"{root}/SceneLists/YUI_PropsV1/list.json",
            json.dumps(
                {
                    "sharedModelKey": "CoffeeBean",
                    "scenes": [{"animationName": "ANIM/Idle"}],
                }
            ),
        )

    result = inspect_emotelab_zip(stream.getvalue(), filename="variants.zip")

    assert result["character"]["path"].endswith(
        "Characters/YUI_PropsV1/YUI_PropsV1/YUI_PropsV1.json"
    )
    assert result["character"]["skins"] == [{"group": "Hat", "value": "Hat_C_Custom"}]
    assert not any("不一致" in warning for warning in result["warnings"])


def test_normalizes_scene_outline_and_text_overlay_fields():
    result = inspect_emotelab_zip(
        _package(
            outline=True,
            texts=[
                {
                    "name": "Greeting",
                    "side": "Behind",
                    "transformData": {
                        "localPosition": {"x": 1, "y": 2, "z": 3},
                        "rotationZ": 12,
                        "sortingOrder": 4,
                        "visible": True,
                    },
                    "style": {"text": "<b>Hi</b>", "fontSize": 48},
                    "material": {"outlineEnabled": True, "outlineWidth": 2},
                }
            ],
        )
    )

    assert any("轮廓" in warning for warning in result["warnings"])
    assert any("文本层" in warning for warning in result["warnings"])
    scene = result["scenes"][0]
    assert scene["model"]["outline"]["enabled"] is True
    assert scene["texts"][0]["side"] == "Behind"
    assert scene["texts"][0]["transformData"]["localPosition"] == [1.0, 2.0, 3.0]
    assert scene["texts"][0]["transformData"]["sortingOrder"] == 4
    assert scene["texts"][0]["style"]["text"] == "<b>Hi</b>"
    assert scene["texts"][0]["material"]["outlineEnabled"] is True
    assert result["capabilities"]["sceneOutline"] is True
    assert result["capabilities"]["sceneText"] is True


def test_normalizes_unity_textmeshpro_numeric_enums_and_keeps_source_values():
    result = inspect_emotelab_zip(
        _package(
            texts=[
                {
                    "name": "Numeric",
                    "side": 1,
                    "transformData": {"sortingOrder": -2},
                    "style": {
                        "text": "<b>Hello</b>",
                        "fontStyle": 3,
                        "horizontalAlignment": 4,
                        "verticalAlignment": 256,
                        "overflowMode": 2,
                    },
                }
            ],
        )
    )

    text = result["scenes"][0]["texts"][0]
    assert text["side"] == "Behind"
    assert text["style"]["fontStyle"] == "Bold Italic"
    assert text["style"]["horizontalAlignment"] == "Right"
    assert text["style"]["verticalAlignment"] == "Top"
    assert text["style"]["overflowMode"] == "Masking"
    assert text["style"]["fontStyleValue"] == 3
    assert text["style"]["horizontalAlignmentValue"] == 4
    assert text["style"]["verticalAlignmentValue"] == 256
    assert text["style"]["overflowModeValue"] == 2


def test_scene_text_defaults_match_emotelab_create_default():
    result = inspect_emotelab_zip(_package(texts=[{"name": "Defaults"}]))
    style = result["scenes"][0]["texts"][0]["style"]
    assert style["fontName"] == ""
    assert style["fontStyle"] == "Normal"
    assert style["horizontalAlignment"] == "Left"
    assert style["verticalAlignment"] == "Top"
    assert style["autoSizeTextContainer"] is True
    assert style["enableWordWrapping"] is False
    assert style["overflowMode"] == "Overflow"


def test_flattened_scene_text_style_is_only_a_compatibility_fallback():
    result = inspect_emotelab_zip(
        _package(
            texts=[
                {
                    "name": "Legacy",
                    "fontSize": 18,
                    "fontStyle": 1,
                    "style": {"fontSize": 42, "fontStyle": 2},
                }
            ],
        )
    )
    style = result["scenes"][0]["texts"][0]["style"]
    assert style["fontSize"] == 42.0
    assert style["fontStyle"] == "Italic"


def test_rejects_zip_path_traversal():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../escape.json", "{}")

    with pytest.raises(EmoteTemplatePackageError):
        inspect_emotelab_zip(stream.getvalue())
