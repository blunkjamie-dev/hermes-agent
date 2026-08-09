"""Tests for the Buzz WebSocket transport (NIP-42) and Nostr signing module.

The signing module and WS transport were contributed in PR #73636 by
@ScaleLeanChris and consolidated onto the merged poll-based adapter; these
tests cover the crypto (against the official BIP-340 vector) and the WS
lifecycle as wired into BuzzAdapter.
"""

import asyncio
import json
import sys
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from tests.gateway._plugin_adapter_loader import load_plugin_adapter

_buzz_mod = load_plugin_adapter("buzz")
BuzzAdapter = _buzz_mod.BuzzAdapter

import importlib.util as _ilu
from pathlib import Path as _Path

_auth_path = _Path(_buzz_mod.__file__).with_name("nostr_auth.py")
_spec = _ilu.spec_from_file_location("plugin_adapter_buzz_nostr_auth", _auth_path)
nostr_auth = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(nostr_auth)

SELF_PUBKEY = "9fd5c7ba6d3ef224da78f541e0fcb9c50f72cc63edb19aae76ac6a0474dfa860"
# BIP-340 test vector 0 private key
TEST_PRIVATE_KEY = "00" * 31 + "03"
CHANNEL = "ccc2bc1a-7a82-5a8f-8c4e-57a070cbe7cd"


def _make_adapter(extra=None):
    from gateway.config import PlatformConfig

    cfg = PlatformConfig(enabled=True, extra={"relay_url": "https://test.relay", **(extra or {})})
    adapter = BuzzAdapter(cfg)
    adapter._self_pubkey = SELF_PUBKEY
    adapter._private_key = TEST_PRIVATE_KEY
    adapter._display_name = "Chip"
    return adapter


# ── nostr_auth: BIP-340 / NIP-42 ──────────────────────────────────────────


def test_schnorr_sign_matches_official_bip340_vector_zero():
    signature = nostr_auth.schnorr_sign(
        bytes(32), TEST_PRIVATE_KEY, auxiliary_randomness=bytes(32)
    )
    assert nostr_auth.public_key_hex(TEST_PRIVATE_KEY).upper() == (
        "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9"
    )
    assert signature.hex().upper() == (
        "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA8215"
        "25F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0"
    )


def test_decode_private_key_rejects_bad_input():
    with pytest.raises(ValueError):
        nostr_auth.decode_private_key("not-a-key")
    with pytest.raises(ValueError):
        nostr_auth.decode_private_key("00" * 32)  # zero — outside range
    with pytest.raises(ValueError):
        nostr_auth.decode_private_key("nsec1qqqqqqqq")  # bad checksum/length


def test_build_auth_event_shape_and_owner_tag():
    tag = json.dumps(["auth", "b" * 64, "", "c" * 128])
    event = nostr_auth.build_auth_event(
        private_key=TEST_PRIVATE_KEY,
        challenge="challenge-1",
        relay_url="wss://relay.example",
        auth_tag_json=tag,
        created_at=1_700_000_000,
        auxiliary_randomness=bytes(32),
    )
    assert event["kind"] == 22242
    assert ["relay", "wss://relay.example"] in event["tags"]
    assert ["challenge", "challenge-1"] in event["tags"]
    assert ["auth", "b" * 64, "", "c" * 128] in event["tags"]
    assert len(bytes.fromhex(event["sig"])) == 64
    assert event["pubkey"] == nostr_auth.public_key_hex(TEST_PRIVATE_KEY)


# ── Adapter WS wiring ─────────────────────────────────────────────────────


class _FakeWebSocket:
    """Replays a NIP-42 handshake: AUTH challenge, then OK for the reply."""

    def __init__(self):
        self.sent = []

    async def recv(self):
        if self.sent:
            auth_event = self.sent[0][1]
            return json.dumps(["OK", auth_event["id"], True, "authenticated"])
        return json.dumps(["AUTH", "relay-challenge"])

    async def send(self, raw):
        self.sent.append(json.loads(raw))


@pytest.mark.asyncio
async def test_websocket_auth_raises_on_rejection():
    adapter = _make_adapter()

    class RejectingWs(_FakeWebSocket):
        async def recv(self):
            if self.sent:
                auth_event = self.sent[0][1]
                return json.dumps(["OK", auth_event["id"], False, "denied"])
            return json.dumps(["AUTH", "relay-challenge"])

    with pytest.raises(ConnectionError):
        await adapter._authenticate_websocket(RejectingWs())


class _ReplayWebSocket:
    def __init__(self, frames):
        self._frames = iter(frames)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return json.dumps(next(self._frames))
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _ReplayContext:
    def __init__(self, websocket):
        self.websocket = websocket

    async def __aenter__(self):
        return self.websocket

    async def __aexit__(self, exc_type, exc, tb):
        return False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("include_eose", "expected_cursor"),
    [(False, 50), (True, 200)],
)
async def test_membership_cursor_commits_only_after_eose(
    monkeypatch,
    include_eose,
    expected_cursor,
):
    adapter = _make_adapter()
    adapter._membership_since = 50
    membership_id = _buzz_mod._WS_MEMBERSHIP_SUB_ID
    frames = [
        ["EVENT", membership_id, {"created_at": 200, "tags": []}],
        ["EVENT", membership_id, {"created_at": 102, "tags": []}],
    ]
    if include_eose:
        frames.append(["EOSE", membership_id])

    adapter._authenticate_websocket = AsyncMock()
    adapter._subscribe_websocket = AsyncMock(
        return_value={membership_id: None}
    )
    adapter._handle_membership_event = AsyncMock(
        side_effect=lambda _ws, _subscriptions, event: int(event["created_at"])
    )

    calls = 0

    def connect(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return _ReplayContext(_ReplayWebSocket(frames))

        class CancelOnReconnect:
            async def __aenter__(self):
                assert adapter._membership_since == expected_cursor
                raise asyncio.CancelledError

            async def __aexit__(self, exc_type, exc, tb):
                return False

        return CancelOnReconnect()

    monkeypatch.setitem(sys.modules, "websockets", SimpleNamespace(connect=connect))

    with pytest.raises(asyncio.CancelledError):
        await adapter._websocket_loop()

    assert adapter._membership_since == expected_cursor
    assert adapter._handle_membership_event.await_count == 2


@pytest.mark.asyncio
async def test_reconnect_defers_unbound_dm_until_its_membership_event(monkeypatch):
    """Broad discovery must not give an older DM a now-minus-one cursor."""
    adapter = _make_adapter()
    older_dm = "11111111-1111-4111-8111-111111111111"
    newer_dm = "22222222-2222-4222-8222-222222222222"

    async def discover_dms(*, seed):
        assert seed is False
        for channel_id in (older_dm, newer_dm):
            adapter._channel_state.setdefault(
                channel_id,
                {
                    "chat_type": "dm",
                    "last_ts": 0,
                    "seen": {},
                    "membership_bound": False,
                },
            )

    monkeypatch.setattr(adapter, "_discover_dms", discover_dms)

    first_websocket = _FakeWebSocket()
    first_subscriptions = {_buzz_mod._WS_MEMBERSHIP_SUB_ID: None}
    await adapter._handle_membership_event(
        first_websocket,
        first_subscriptions,
        {"created_at": 200, "tags": [["d", newer_dm]]},
    )
    assert newer_dm in first_subscriptions.values()
    assert older_dm not in first_subscriptions.values()

    # Disconnect before the older membership event and before membership EOSE.
    # Reconnect must not subscribe the broadly discovered, still-unbound DM at
    # now-minus-one; its own replayed membership event will provide the anchor.
    reconnect_websocket = _FakeWebSocket()
    reconnect_subscriptions = await adapter._subscribe_websocket(
        reconnect_websocket
    )
    assert newer_dm in reconnect_subscriptions.values()
    assert older_dm not in reconnect_subscriptions.values()

    await adapter._handle_membership_event(
        reconnect_websocket,
        reconnect_subscriptions,
        {"created_at": 102, "tags": [["d", older_dm]]},
    )
    assert older_dm in reconnect_subscriptions.values()
    older_requests = [
        request
        for request in reconnect_websocket.sent
        if request[0] == "REQ" and request[2].get("#h") == [older_dm]
    ]
    assert len(older_requests) == 1
    assert older_requests[0][2]["since"] == 72


