"""Retain waiting invitations across reload, restore cancel controls, and release input after cancellation."""

import json
from pathlib import Path

import pytest

from tests.unit.test_visit_chat_assembly_node import CHAT_PATH, HARNESS, PACER_PATH, RELAY_SAMPLES
from tests.unit.test_visit_peer_crop_node import _BRIDGE_JS
from tests.visit_js_harness import BRIDGE_FILES, run_visit_js

ROOT = Path(__file__).resolve().parents[2]


def _prelude():
    chat = (
        HARNESS.split("const report = {};", 1)[0]
        .replace("__CHAT_PATH__", json.dumps(str(CHAT_PATH)))
        .replace("__PACER_PATH__", json.dumps(str(PACER_PATH)))
        .replace("__RELAY_SAMPLES__", json.dumps(RELAY_SAMPLES))
        .replace("return { win, I, chat,", "return { sandbox, win, I, chat,")
    )
    return _BRIDGE_JS + "\nfunction makeChat(opts) {\n" + chat + "\nreturn createHarness(opts);\n}\n" + f"""
const SOCIAL_HUB = {json.dumps(str(ROOT / 'static/social-hub.js'))};
const DISPLAY_RELAY = {json.dumps(str(ROOT / 'static/visit/display-relay.js'))};
const FRIEND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VID = 'A'.repeat(22);
const STATE_URL = '/api/visit/state?catgirl=%E5%92%AA%E5%92%AA';
function snapshot(extra) {{
  return Object.assign({{ active: true, enabled: true, side: 'host', phase: 'invite_ready',
    visit_id: VID, target_user_id: FRIEND, invite_expires_at: 9e9 }}, extra || {{}});
}}
function installHub(h) {{
  const storage = new Map();
  h.sandbox.sessionStorage = {{ getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }};
  h.sandbox.requestAnimationFrame = () => {{}};
  const source = fs.readFileSync(SOCIAL_HUB, 'utf8').replace('_inviteFriend: inviteFriend,',
    '_inviteFriend: inviteFriend, _cancelInvitation: cancelInvitation,');
  vm.runInContext(source, h.sandbox);
  const hub = h.win.nekoSocialHub;
  hub._state.accountId = 'account';
  hub._state.friends = [{{ id: FRIEND, displayName: 'Friend', avatarUrl: '' }}];
  return hub;
}}
function connectMedia(h, multi) {{
  const pet = makeBridge();
  pet.ctx.nekoVisitParentBridge = pet.bridge;
  pet.ctx.lanlan_config = {{ lanlan_name: '咪咪' }};
  if (multi) {{
    const channels = [];
    class Channel {{
      constructor(name) {{ this.name = name; channels.push(this); }}
      postMessage(data) {{
        for (const peer of channels) if (peer !== this && peer.name === this.name && peer.onmessage) peer.onmessage({{ data }});
      }}
    }}
    pet.ctx.__NEKO_MULTI_WINDOW__ = true;
    pet.ctx.BroadcastChannel = Channel;
    load(pet.ctx, [DISPLAY_RELAY]);
    h.win.location.pathname = '/chat';
    h.win.__NEKO_MULTI_WINDOW__ = true;
    h.sandbox.BroadcastChannel = Channel;
  }} else {{ h.win.nekoVisitParentBridge = pet.bridge; }}
  vm.runInContext(fs.readFileSync(DISPLAY_RELAY, 'utf8'), h.sandbox);
  pet.bridge.onStateChange({{ type: 'visit_state_change', action: 'invite_ready', side: 'host', visit_id: VID }});
  return pet;
}}
"""


@pytest.mark.parametrize("phase", ["pending", "invite_ready"])
@pytest.mark.parametrize("reconnecting", [False, True])
def test_reload_keeps_the_invitation_and_restores_friend_and_waiting_input(phase, reconnecting):
    out = run_visit_js(
        f"""
        const h = makeChat({{ routes: {{ [STATE_URL]: async () => ({{ status: 200,
          body: snapshot({{ phase: {json.dumps(phase)}, reconnecting: {json.dumps(reconnecting)} }}) }}) }} }});
        const hub = installHub(h);
        hub._state.invitations.set(FRIEND, {{ visitId: VID, phase: 'invite_ready', expiresAt: 9e9 }});
        h.advance(5000); // 社区先恢复，串门状态仍未读回：不能把缓存当成过期邀请删掉。
        const retainedBeforeBind = hub._state.invitations.has(FRIEND);
        await h.chat.afterBind(h.socket, '咪咪');
        const view = h.I.getVisitChatView();
        return {{ retainedBeforeBind, state: h.chat.getState(), invitation: hub._state.invitations.get(FRIEND),
          disabled: view.composerDisabled, placeholder: view.inputPlaceholder,
          submitted: h.I.submitVisitChatText({{ text: 'hello', requestId: 'waiting' }}),
          toast: h.toasts.at(-1), mutations: h.fetches.filter(item => item.method === 'POST') }};
        """,
        files=(), extra_prelude=_prelude(),
    )
    assert out["retainedBeforeBind"] and out["state"]["ready"]
    assert out["state"]["phase"] == out["invitation"]["phase"] == phase
    assert out["state"]["targetUserId"] == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    assert out["state"]["inviteExpiresAt"] == 9e9
    assert not out["disabled"] and not out["submitted"]
    assert out["placeholder"] == "客人还没到等等再聊吧"
    assert out["toast"] == "visit.status.VISIT_INPUT_REFUSED_NOT_READY"
    assert out["mutations"] == []


def test_snapshot_rebuilds_the_cancel_control_even_without_a_cached_invitation():
    out = run_visit_js(
        """
        const h = makeChat({ routes: { [STATE_URL]: async () => ({ status: 200, body: snapshot() }) } });
        const hub = installHub(h);
        await h.chat.afterBind(h.socket, '咪咪');
        return { invitation: hub._state.invitations.get(FRIEND) };
        """,
        files=(), extra_prelude=_prelude(),
    )
    assert out["invitation"]["phase"] == "invite_ready"
    assert out["invitation"]["expiresAt"] == 9e9


@pytest.mark.parametrize("multi", [False, True])
@pytest.mark.parametrize("status", [200, 404, 503])
def test_cancel_after_reload_releases_both_text_and_voice_only_when_backend_releases(multi, status):
    out = run_visit_js(
        f"""
        let reads = 0;
        const h = makeChat({{ routes: {{
          [STATE_URL]: async () => ({{ status: 200, body: ++reads <= 2 ? snapshot() : {{ active: false, enabled: true }} }}),
          '/api/visit/route/end': async () => ({{ status: {status}, body: {{}} }}),
        }} }});
        const hub = installHub(h);
        const pet = connectMedia(h, {json.dumps(multi)});
        await h.chat.afterBind(h.socket, '咪咪');
        const before = {{ text: h.chat.isActive(), voice: pet.bridge.blocksOrdinaryVoice() }};
        const result = await h.chat.cancelDirectInvitation(VID);
        const afterRequest = {{ text: h.chat.isActive(), voice: pet.bridge.blocksOrdinaryVoice(), phase: h.chat.getState().phase }};
        h.advance(5000); await h.settle();
        const duringCleanup = h.chat.isActive();
        h.advance(5000); await h.settle();
        return {{ before, result, afterRequest, duringCleanup, reads,
          after: {{ text: h.chat.isActive(), voice: pet.bridge.blocksOrdinaryVoice(), invitations: hub._state.invitations.size }} }};
        """,
        files=BRIDGE_FILES, extra_prelude=_prelude(),
    )
    assert out["before"] == {"text": True, "voice": True}
    if status == 200:
        assert out["result"] and out["afterRequest"]["phase"] == "cancelling"
        assert out["afterRequest"]["text"] and out["afterRequest"]["voice"] and out["duringCleanup"]
        assert out["reads"] == 3
    elif status == 404:
        assert out["result"] and not out["afterRequest"]["text"] and not out["afterRequest"]["voice"]
    else:
        assert not out["result"] and out["afterRequest"]["phase"] == "invite_ready"
        assert out["after"] == {"text": True, "voice": True, "invitations": 1}
        return
    assert out["after"] == {"text": False, "voice": False, "invitations": 0}


def test_cancel_poll_does_not_restore_a_waiting_phase_over_a_newer_live_frame():
    out = run_visit_js(
        """
        let release;
        const gate = new Promise(r => { release = r; });
        const h = makeChat({ routes: {
          '/api/visit/route/end': async () => ({ status: 200, body: {} }),
          [STATE_URL]: async () => { await gate; return { status: 200, body: snapshot() }; },
        } });
        h.state('invite_ready', { target_user_id: FRIEND });
        await h.chat.cancelDirectInvitation(VID);
        h.advance(5000); await h.settle();
        h.state('started');
        release(); await h.settle();
        return { phase: h.chat._test.state().visit.phase };
        """,
        files=(), extra_prelude=_prelude(),
    )
    assert out["phase"] == "active"


@pytest.mark.parametrize("status", [200, 404, 503])
def test_hub_cancel_control_waits_for_authoritative_completion(status):
    out = run_visit_js(
        f"""
        let reads = 0;
        const h = makeChat({{ routes: {{
          [STATE_URL]: async () => ({{ status: 200, body: ++reads === 1 ? snapshot() : {{ active: false, enabled: true }} }}),
          '/api/visit/route/end': async () => ({{ status: {status}, body: {{}} }}),
        }} }});
        const hub = installHub(h);
        await h.chat.afterBind(h.socket, '咪咪');
        await hub._cancelInvitation(FRIEND, hub._state.invitations.get(FRIEND));
        const afterResponse = hub._state.invitations.get(FRIEND);
        const phase = afterResponse ? afterResponse.phase : '';
        h.advance(5000); await h.settle();
        return {{ phase, remaining: hub._state.invitations.size }};
        """,
        files=(), extra_prelude=_prelude(),
    )
    assert out["phase"] == {200: "cancelling", 404: "", 503: "invite_ready"}[status]
    assert out["remaining"] == (1 if status == 503 else 0)


@pytest.mark.parametrize("action", ["ending", "ended"])
def test_late_cancel_response_never_reblocks_input_after_ending(action):
    out = run_visit_js(
        f"""
        const h = makeChat({{ routes: {{
          '/api/visit/route/end': async () => {{ h.state({json.dumps(action)}); return {{ status: 200, body: {{}} }}; }},
        }} }});
        h.state('invite_ready', {{ target_user_id: FRIEND }});
        await h.chat.cancelDirectInvitation(VID);
        return {{ blocked: h.chat.isActive() }};
        """,
        files=(), extra_prelude=_prelude(),
    )
    assert not out["blocked"]


@pytest.mark.parametrize("outcome", ["ended", "still_waiting", "new_visit", "network_error"])
def test_refresh_after_cancel_reconciles_pet_without_clearing_a_valid_invitation(outcome):
    out = run_visit_js(
        f"""
        const h = makeChat({{ routes: {{ [STATE_URL]: async () => ({{ status: 200,
          body: {{ active: false, enabled: true, visit_id: null }} }}) }} }});
        const pet = connectMedia(h, true);
        let respond;
        pet.ctx.fetch = () => new Promise(r => {{ respond = r; }});
        await h.chat.afterBind(h.socket, '咪咪');
        await settle();
        const beforeConfirmation = pet.bridge.blocksOrdinaryVoice();
        if ({json.dumps(outcome)} === 'new_visit') pet.bridge.onStateChange({{
          type: 'visit_state_change', action: 'pending', side: 'host', visit_id: 'B'.repeat(22)
        }});
        respond({{ ok: {json.dumps(outcome != 'network_error')}, json: async () =>
          ({json.dumps(outcome)} === 'still_waiting' ? snapshot() : {{ active: false, visit_id: null }}) }});
        await settle();
        return {{ beforeConfirmation, blocked: pet.bridge.blocksOrdinaryVoice(), visitId: pet.bridge._state.visitId }};
        """,
        files=BRIDGE_FILES, extra_prelude=_prelude(),
    )
    assert out["beforeConfirmation"]
    assert out["blocked"] is (outcome != "ended")
    assert out["visitId"] == (None if outcome == "ended" else "B" * 22 if outcome == "new_visit" else "A" * 22)


def test_late_idle_recovery_cannot_clear_an_invitation_restored_by_a_newer_snapshot():
    out = run_visit_js(
        """
        const pet = makeBridge();
        const replies = [];
        pet.ctx.fetch = () => new Promise(resolve => replies.push(resolve));
        const oldRequest = pet.bridge.recoverAfterReload('咪咪');
        await settle();
        const newRequest = pet.bridge.recoverAfterReload('咪咪');
        await settle();
        replies[1]({ ok: true, json: async () => snapshot() });
        await newRequest;
        replies[0]({ ok: true, json: async () => ({ active: false, visit_id: null }) });
        await oldRequest;
        return { blocked: pet.bridge.blocksOrdinaryVoice(), visitId: pet.bridge._state.visitId };
        """,
        files=BRIDGE_FILES, extra_prelude=_prelude(),
    )
    assert out == {"blocked": True, "visitId": "A" * 22}
