"""End-to-end tests of the channel server (port of the original script to pytest).

The test plays the role of Claude Code: it speaks MCP over the server's stdin/stdout (initialize, receive channel
notifications, call `reply` and `notify`) while posting HTTP requests as the panel, the voice assistant and scripts.
Every test gets its own server process, port and state directory. ntfy is disabled; push decisions are read back from
the channel log. Requires Bun on PATH (or ~/.bun/bin) and `bun install` done once.
"""
import json
import os
import queue
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "channel", "src", "channel.ts")
BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
KEY = "test-key"
FAST_POLICY = {"QG_NORMAL_DELAY_MIN": "0.04", "QG_QUESTION_REMINDER_MIN": "0.06", "QG_POLICY_TICK_S": "0.3"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Channel:
    """A channel server process plus the fake Claude Code on the other end of its stdio."""

    def __init__(self, state=None):
        self.state = state or tempfile.mkdtemp(prefix="channel-test-")
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        env = {**os.environ, "QG_CHANNEL_KEY": KEY, "QG_CHANNEL_PORT": str(self.port), "QG_CHANNEL_STATE": self.state,
               "QG_CHANNEL_NO_NTFY": "1", **FAST_POLICY}
        self.proc = subprocess.Popen([BUN, SRC], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=env)
        self.channel_msgs = queue.Queue()
        self.responses = {}
        self._cv = threading.Condition()
        self._next_id = 100
        threading.Thread(target=self._reader, daemon=True).start()
        init = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": {"name": "test", "version": "0"}})
        self.instructions = init["instructions"]
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._wait_http()

    # --- MCP side (the fake Claude Code)
    def _send(self, o):
        self.proc.stdin.write(json.dumps(o) + "\n")
        self.proc.stdin.flush()

    def _reader(self):
        for line in self.proc.stdout:
            m = json.loads(line)
            if m.get("method") == "notifications/claude/channel":
                self.channel_msgs.put(m["params"])
            elif "id" in m:
                with self._cv:
                    self.responses[m["id"]] = m
                    self._cv.notify_all()

    def request(self, method, params):
        self._next_id += 1
        i = self._next_id
        self._send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        with self._cv:
            assert self._cv.wait_for(lambda: i in self.responses, timeout=10), f"no answer to {method}"
            return self.responses.pop(i)["result"]

    def call(self, name, args):
        return self.request("tools/call", {"name": name, "arguments": args})["content"][0]["text"]

    def notify(self, **args):
        """Calls the notify tool and returns the id of the published message."""
        return int(self.call("notify", args).split("id ")[1].split(")")[0])

    def next_message(self, timeout=10):
        """Next message the channel forwards to Claude: {content, meta: {chat_id, from, trust}}."""
        return self.channel_msgs.get(timeout=timeout)

    # --- HTTP side
    def http(self, path, body=None, auth=KEY, headers=None):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {auth}", "Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def _wait_http(self):
        for _ in range(50):
            try:
                if self.http("/health")[0] == 200:
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("channel did not start")

    def subscribe(self, query="", headers=None, stop=None):
        """Opens the SSE stream in a thread; returns the list that fills with parsed events (dicts with id/event/data)."""
        sink = []

        def run():
            req = urllib.request.Request(self.base + "/v1/events" + query, headers={"Authorization": f"Bearer {KEY}", **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                ev = {}
                for raw in r:
                    line = raw.decode().rstrip("\n")
                    if line.startswith("id: "):
                        ev["id"] = line[4:]
                    elif line.startswith("event: "):
                        ev["event"] = line[7:]
                    elif line.startswith("data: "):
                        ev["data"] = json.loads(line[6:])
                    elif line == "" and "data" in ev:
                        sink.append(ev)
                        ev = {}
                        if stop and stop(sink):
                            return
        threading.Thread(target=run, daemon=True).start()
        time.sleep(0.4)
        return sink

    def outbox(self):
        return {e["id"]: e for e in self.http("/v1/outbox?since=0")[1]["events"]}

    def pushes(self):
        """(id, kind) of every push decision the policy took, read from the channel log."""
        with open(os.path.join(self.state, "channel.jsonl")) as f:
            return sorted((l["id"], l["kind"]) for l in map(json.loads, f) if l.get("dir") == "ntfy-policy")

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


@pytest.fixture
def qg():
    c = Channel()
    yield c
    c.stop()
    shutil.rmtree(c.state, ignore_errors=True)


def wait_until(cond, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


def hang_up_stream_chat(c, text="long"):
    """Starts a streamed chat request and closes the connection before the QG answers."""
    req = urllib.request.Request(c.base + "/v1/chat/completions",
                                 data=json.dumps({"stream": True, "messages": [{"role": "user", "content": text}]}).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=10)
    r.read(10)
    r.close()


# ---------------------------------------------------------------- MCP surface and auth
def test_handshake_lists_reply_and_notify(qg):
    assert "notify" in qg.instructions
    tools = qg.request("tools/list", {})["tools"]
    assert {t["name"] for t in tools} == {"reply", "notify"}


def test_wrong_key_is_rejected(qg):
    assert qg.http("/message", {"text": "x"}, auth="wrong")[0] == 401
    assert qg.http("/v1/events", auth="wrong")[0] == 401
    assert qg.http("/health", auth="")[0] == 401


# ---------------------------------------------------------------- request / reply
def test_voice_roundtrip_is_trusted_as_the_user(qg):
    out = {}
    t = threading.Thread(target=lambda: out.update(r=qg.http("/message", {"text": "Hello QG", "from": "voice", "wait": True})))
    t.start()
    msg = qg.next_message()
    assert msg["meta"]["trust"] == "user" and msg["content"] == "Hello QG"
    assert qg.call("reply", {"chat_id": msg["meta"]["chat_id"], "text": "Hi"}) == "sent"
    t.join()
    assert out["r"][1]["reply"] == "Hi"


def test_openai_format_defaults_to_the_panel(qg):
    out = {}
    t = threading.Thread(target=lambda: out.update(r=qg.http("/v1/chat/completions", {"messages": [{"role": "user", "content": "What time is it?"}]})))
    t.start()
    msg = qg.next_message()
    assert msg["meta"]["from"] == "panel"
    qg.call("reply", {"chat_id": msg["meta"]["chat_id"], "text": "Midnight."})
    t.join()
    assert out["r"][1]["choices"][0]["message"]["content"] == "Midnight."


def test_script_messages_are_data_and_their_late_reply_is_not_published(qg):
    st, _ = qg.http("/message", {"text": "offer 92", "from": "some-scraper"})
    assert st == 202
    msg = qg.next_message()
    assert msg["meta"]["trust"] == "data"
    assert "nobody is waiting" in qg.call("reply", {"chat_id": msg["meta"]["chat_id"], "text": "noted"})
    assert qg.http("/v1/outbox?since=0")[1]["events"] == []


def test_late_reply_after_hangup_goes_on_the_stream(qg):
    events = qg.subscribe()
    threading.Thread(target=hang_up_stream_chat, args=(qg,)).start()
    msg = qg.next_message()
    time.sleep(0.5)
    assert "published" in qg.call("reply", {"chat_id": msg["meta"]["chat_id"], "text": "Late answer"})
    assert wait_until(lambda: len(events) == 1)
    assert events[0]["event"] == "reply" and events[0]["data"]["text"] == "Late answer"


# ---------------------------------------------------------------- notify and the event stream
def test_notify_validation(qg):
    assert qg.call("notify", {"title": ""}).startswith("title and text")
    assert qg.http("/v1/notify", {"title": "x"})[0] == 400


def test_notify_reaches_the_stream_with_its_fields(qg):
    events = qg.subscribe()
    qg.notify(title="Website: mockup ready", text="v2 is live on the LAN.", project="website",
              choices=["Look", "Later"], urgency="low", speak="The mockup is ready.")
    st, r = qg.http("/v1/notify", {"title": "Script ping", "text": "via HTTP", "from": "ci"})
    assert st == 201 and "id" in r
    assert wait_until(lambda: len(events) == 2)
    first, second = events[0]["data"], events[1]["data"]
    assert first["type"] == "notify" and first["choices"] == ["Look", "Later"]
    assert first["urgency"] == "low" and first["project"] == "website" and first["speak"] == "The mockup is ready."
    assert second["source"] == "http:ci"
    assert int(events[0]["id"]) < int(events[1]["id"])


def test_resume_with_last_event_id_and_since(qg):
    ids = [qg.notify(title=f"n{i}", text="x", urgency="low") for i in range(3)]
    got = qg.subscribe(headers={"Last-Event-ID": str(ids[0])}, stop=lambda s: len(s) >= 2)
    assert wait_until(lambda: len(got) == 2)
    assert [int(g["id"]) for g in got] == ids[1:]
    assert [e["id"] for e in qg.http(f"/v1/outbox?since={ids[1]}")[1]["events"]] == [ids[2]]
    h = qg.http("/health")[1]
    assert h["last_event_id"] == ids[2]
    assert len(open(os.path.join(qg.state, "outbox.jsonl")).read().splitlines()) == 3


def test_seen_events_only_for_subscribers_who_ask(qg):
    plain = qg.subscribe()
    with_seen = qg.subscribe("?with=seen")
    i = qg.notify(title="a", text="b", urgency="low")
    assert wait_until(lambda: len(plain) == 1)
    assert qg.http("/v1/seen", {"ids": [i, 123]})[1]["marked"] == [i]
    assert wait_until(lambda: any(e["event"] == "seen" for e in with_seen))
    assert not any(e["event"] == "seen" for e in plain)
    assert qg.http("/v1/seen", {})[0] == 400


# ---------------------------------------------------------------- phone push policy
def test_push_policy_end_to_end(qg):
    high = qg.notify(title="High", text="x", urgency="high")
    low = qg.notify(title="Low!", text="x", urgency="low")
    unread = qg.notify(title="Normal unread", text="x")
    read_in_time = qg.notify(title="Normal read early", text="x")
    forgotten = qg.notify(title="Forgotten question", text="x", choices=["a", "b"])
    clicked = qg.notify(title="Answered by click", text="x", choices=["a", "b"])
    typed = qg.notify(title="Answered by typing", text="x", choices=["a", "b"])
    st, r = qg.http("/v1/seen", {"ids": [read_in_time, forgotten, clicked, typed]})
    assert sorted(r["marked"]) == sorted([read_in_time, forgotten, clicked, typed])

    # A message from the user that quotes a title answers that question only.
    qg.http("/message", {"text": 'Answer to "Answered by click": a', "from": "panel"})
    qg.next_message()
    box = qg.outbox()
    assert box[clicked]["answered_at"] and not box[forgotten]["answered_at"] and not box[typed]["answered_at"]
    # Explicit receipt for the other one.
    assert qg.http("/v1/seen", {"ids": [], "answered": [typed]})[1]["marked"] == [typed]

    time.sleep(5)  # delay 2.4 s, reminder 3.6 s after being read
    box = qg.outbox()
    assert box[high]["ntfy_at"], "high = immediate push"
    assert not box[low]["ntfy_at"], "low = never"
    assert box[unread]["ntfy_at"], "normal, still unread = delayed push"
    assert not box[read_in_time]["ntfy_at"], "normal read before the delay = no push"
    assert box[forgotten]["ntfy_at"], "question read, unanswered = reminder"
    assert not box[clicked]["ntfy_at"] and not box[typed]["ntfy_at"], "answered questions = no reminder"
    assert qg.pushes() == sorted([(high, "immediate"), (unread, "delayed"), (forgotten, "reminder")])


def test_a_reply_never_triggers_a_push(qg):
    threading.Thread(target=hang_up_stream_chat, args=(qg,)).start()
    msg = qg.next_message()
    time.sleep(0.5)
    qg.call("reply", {"chat_id": msg["meta"]["chat_id"], "text": "late"})
    time.sleep(3.5)
    assert qg.pushes() == []
    (ev,) = qg.outbox().values()
    assert ev["type"] == "reply" and not ev["ntfy_at"]


# ---------------------------------------------------------------- persistence
def test_outbox_survives_a_restart_without_new_pushes(qg):
    qg.notify(title="High", text="x", urgency="high")
    qg.notify(title="Normal", text="x")
    qg.notify(title="Low", text="x", urgency="low")
    time.sleep(3.5)
    assert len(qg.pushes()) == 2
    state = qg.state
    qg.stop()
    again = Channel(state=state)
    try:
        assert len(again.outbox()) == 3
        time.sleep(1.5)
        assert len(again.pushes()) == 2, "no new push after a restart"
    finally:
        again.stop()
