# Ultimate Watch Together — Sync Protocol v2

This is the single wire format shared by all three clients:

| Client | Implementation |
|---|---|
| Web browser / PWA | `browser/js/sync.js` |
| mpvEx (Android) | `mpvEx/app/src/main/java/app/marlboroadvance/mpvex/watchtogether/` |
| Daum PotPlayer (Windows) | `potplayer/potplayer_sync.py` |

Transport is **one** WebSocket relay. WebRTC/PeerJS is used **only** for voice chat and
never carries playback state.

```
                       wss://138-68-159-46.sslip.io/ws
   Browser  ─────────────────┐
   mpvEx    ─────────────────┼──►  relay_server.py  (room = 3-digit code)
   PotPlayer ────────────────┘         │
                                       └─► broadcast to every peer except the sender
```

Room codes are **3 digits** (`100`–`999`) on every client. That is the whole namespace:
1000 rooms, no authentication. This is deliberate — the suite is for a small private
group of friends.

---

## 1. Why v2 exists

v1 had three fatal design flaws:

1. **Dual transport.** Every action was sent over *both* WebRTC and the relay, so each
   receiver applied it twice, and each application re-fired the local `play`/`pause`
   handlers, which re-broadcast. That is the "stuck in a loop" symptom.
2. **No sender identity.** A receiver could not tell its own echo from a peer's action.
3. **Event-based sync.** `play`/`pause`/`seek` were sent as *events*. A dropped or
   reordered event left the room permanently out of state with nothing to repair it.

v2 fixes all three: one transport, every packet carries `sid`/`seq`, and the payload is
**absolute state** (`position` + `paused` + `rate`), never an event.

---

## 2. Envelope

Every v2 packet is wrapped in `type: "action"`. That is the only reason for the outer
`type` field: the deployed v1 relay has a forwarding allowlist that already contains
`"action"`, so v2 clients work against the **already-running** server with no redeploy.

```json
{
  "type":    "action",
  "room":    "582",
  "v":       2,
  "kind":    "state",
  "sid":     "w7f3c1a9b2",
  "sname":   "Likhon",
  "splat":   "web",
  "seq":     41,
  "sent_at": 1770000000123
}
```

| Field | Meaning |
|---|---|
| `type` | Always `"action"`. Relay routing key only. |
| `room` | 3-digit room code, as a string. |
| `v` | Protocol version. Receivers **must** ignore any packet without `v == 2`, except for the server control frames in §5. |
| `kind` | The real message type. See §3. |
| `sid` | Stable sender id, generated once per client session. `w…` web, `a…` android, `p…` potplayer. |
| `sname` | Display name. |
| `splat` | `web` \| `android` \| `potplayer`. |
| `seq` | Per-sender counter, strictly increasing from 1. |
| `sent_at` | Sender's wall clock, ms since epoch. |

> **Never trust `sender_id`, `sender_name` or `platform`.** The relay *overwrites* those
> three keys on every forwarded message with its own connection metadata. `sid`, `sname`
> and `splat` exist precisely because they survive.

### Receiver rules (all clients, in order)

1. Drop if `sid == mySid` — self-echo.
2. Drop if `v != 2` (unless it is a §5 control frame).
3. Drop if `seq <= lastSeq[sid]` — replay / reorder.
4. Store `lastSeq[sid] = seq`.
5. Dispatch on `kind`.

Rules 1–3 are what structurally prevent feedback loops. There is no timing heuristic in
the accept path.

---

## 3. Kinds

### `state` — the only playback message

```json
{ "kind": "state", "position": 812.44, "paused": false, "rate": 1.0,
  "cause": "play", "duration": 5411.2 }
```

| Field | |
|---|---|
| `position` | Playhead in seconds at the instant `sent_at` was stamped. |
| `paused` | `true` = paused, `false` = playing. Absolute, not a toggle. |
| `rate` | Playback speed. **Optional.** Omitted, or `<= 0`, means *"I cannot report my speed"* — receivers must then leave their own speed untouched and extrapolate at 1.0×. It does **not** mean 1.0×. |
| `cause` | `play` \| `pause` \| `seek` \| `rate` \| `start` \| `heartbeat` \| `resync`. Advisory: it drives the on-screen toast and the drift threshold, never the applied value. |
| `duration` | Media length, for the "different file?" warning. Optional. |

> **`rate` is the one field a sender may legitimately not know.** PotPlayer has no
> playback-rate accessor at all, so it omits the key entirely. Every receiver reads a
> missing or non-positive `rate` as "no opinion" and skips the set-speed step. Defaulting
> it to 1.0 on the receiving side — which the web, Android and PotPlayer clients all used
> to do — meant a single PotPlayer peer reset the whole room's speed to normal on every
> packet it sent, several times a second.

`cause` values and who sends them:

- `play` / `pause` / `seek` / `rate` — a local user action.
- `start` — "Start Watching Together" pressed: seek to `position` and play.
- `heartbeat` — periodic, **leader only**, every 3 s.
- `resync` — sent once to answer a `request_state`, or when a new peer appears.

### `chat`

```json
{ "kind": "chat", "text": "this scene is great" }
```

Dedupe key is `sid:seq`. Chat is never echoed back to the sender by the relay, and the
sender appends its own message locally, so a receiver that sees its own `sid` must drop it.

### `hello` — presence and voice discovery

```json
{ "kind": "hello", "isHost": true, "voice": "uwt-voice-582-w7f3c1a9b2", "ver": "2.0" }
```

Sent immediately on join, again whenever a `peer_joined` arrives, and every 10 s as a
keepalive. `voice` is the PeerJS id to place a WebRTC audio call to, or omitted on
clients without voice (Android, PotPlayer).

`hello` is how each client builds its peer list and how leader election gets its
candidate set. A client that has never heard a `hello` from anyone assumes it is alone.

### `bye`

Sent best-effort on clean disconnect. Receivers drop the peer immediately instead of
waiting for the 25 s presence timeout.

### `request_state`

Sent by a joiner that has media loaded but no known playback state. The current leader
answers with a `state` / `cause: "resync"`.

### `tping` / `tpong` — clock offset

Wall clocks differ across a phone, a laptop and a desktop by seconds. Latency
compensation needs the *offset*, not just the RTT.

```json
{ "kind": "tping", "to": "a91bd0", "t0": 1770000000000 }
{ "kind": "tpong", "to": "w7f3c1",  "t0": 1770000000000, "t1": 1770000004311 }
```

`to` is the target `sid`; everyone else ignores the packet. On receiving the `tpong` at
local time `t3`:

```
rtt    = t3 - t0
offset = t1 - (t0 + t3) / 2          // remoteClock - myClock
```

Both are smoothed with an EMA (α = 0.3) and the sample is discarded if
`rtt > 2000 ms`. Sent every 5 s per peer (three fast probes at 700 ms on first contact).

`offset` is **senderClock − myClock**, so a sender's timestamp converts to my clock as
`sent_at − offset`, and my clock converts to theirs as `myNow + offset`. Getting that sign
backwards does not cancel the skew, it *doubles* it — two clients that were 4 s apart
ended up a fixed 5 s apart in playback (the `elapsed` clamp below is all that kept it
from being 8 s). Both the Android and PotPlayer clients shipped that inversion; the
formula in §4 is the correct one.

### `file_info`

```json
{ "kind": "file_info", "name": "movie.mkv", "size": 8123456789, "duration": 5411.2 }
```

Advisory only — warns when two participants clearly loaded different files.

---

## 4. Applying a `state`

```
elapsed  = (myNow - (sent_at - offset[sid])) / 1000     // clamp to [0, 5]
target   = paused ? position : position + elapsed * rate
```

With no offset sample yet, `elapsed` falls back to `rtt/2` if known, else `0`.

Then, with the local echo suppressed (§6):

```
if rate      != mine     -> set rate      (skipped entirely when rate is absent / <= 0)
if |target - mine| > TOL -> seek to target
if paused                -> pause
else                     -> play
```

`TOL` is **0.30 s** for an explicit cause and **0.70 s** for `heartbeat`. A heartbeat is
additionally ignored when any of these hold:

- the local echo mute is active,
- a local user action happened in the last 1.5 s,
- the user is currently scrubbing,
- the media is not ready (`readyState < 2` / `duration <= 0`).

Those four gates are what stop a heartbeat from fighting a user who is mid-seek.

### Per-client deviations

| Client | Explicit `TOL` | Heartbeat `TOL` | Notes |
|---|---|---|---|
| Web browser | 0.30 s | 0.70 s | Reference implementation. |
| Android (mpvEx) | 0.30 s | 0.70 s | Same as web. |
| Daum PotPlayer | 0.80 s | 1.50 s | PotPlayer is driven over `SendMessage` and seeks by keyframe; it thrashes at 0.30 s. Never sends `rate`. |

**PotPlayer cannot set or read playback rate** — the documented remote-control message
set has no accessor for it. That client therefore **omits `rate` from every packet it
sends** and **skips the rate step on every packet it receives**. It holds whatever speed
the user set in PotPlayer, and tells the user in the chat pane once, when it sees the room
move off 1.0×, that they need to change PotPlayer's speed by hand. A room containing a
PotPlayer client should still stay at 1.0× if you want it aligned.

Earlier revisions had it assert `rate: 1.0`, then mirror back the last rate it had heard.
Both were wrong: the first reset the room's speed several times a second, and the second
made PotPlayer parrot a speed it was not actually playing at, so its `position` and the
speed it advertised described two different playbacks. Omission is the only honest answer.

### PotPlayer: keyframe snap

`POT_SET_CURRENT_TIME` seeks to the nearest keyframe, so the playhead can arrive
seconds away from the requested target. The poller must not read that arrival as a user
scrub — rebroadcasting it drags the entire room onto PotPlayer's keyframe. So while a
requested seek is landing, the client holds a **settle window**: it re-baselines its
change detector on every poll and broadcasts nothing. The window closes as soon as the
playhead reaches the target (within 700 ms of where natural playback predicts) or after
`MUTE_SEEK` (2.5 s), whichever comes first.

Its local seek-detection threshold also depends on the transport state: **1200 ms while
playing** (the poll interval jitters, so natural motion has to be allowed for) but only
**400 ms while paused**, where any change at all is unambiguously a user scrub. With a
single 1200 ms threshold, scrubbing a paused PotPlayer by under a second reached nobody.
The detector's only "no baseline yet" gate is the status being unknown — it must not also
require a non-zero previous position, or a seek made from the very start of a freshly
opened file is silently swallowed.

### PotPlayer: stopped is not paused-at-zero

`POT_GET_PLAY_STATUS` returns `0` when playback is stopped — end of file, or the user hit
stop — and PotPlayer zeroes the playhead at the same time. That must never be published:
`{position: 0, paused: true}` rewinds the whole room to the beginning. A stopped PotPlayer
has no playback state, so `_local_state()` returns `None` and the client emits nothing at
all (not even the pause) until something is playing again. If it happened to be the
leader, its heartbeats simply stop — no correction is much better than a wrong one.

### PotPlayer: never block the socket

Every PotPlayer read/write is a `SendMessageTimeoutW` capped at 400 ms with
`SMTO_ABORTIFHUNG`, never a bare `SendMessageW`. PotPlayer stops pumping messages while
it decodes a heavy seek, and a blocking call there stalls the asyncio loop — which is
also the socket reader and the outbound send queue, so sync freezes in both directions
at exactly the worst moment. The poll thread additionally caches each reading, and
everything running on the event loop reads that cache (with the playhead extrapolated to
now) instead of touching Win32 at all.

---

## 5. Server control frames

Sent by the relay itself, not by a peer. They have **no** `v` field and must still be
processed:

| `type` | Payload | Use |
|---|---|---|
| `room_joined` | `room_id`, `client_id`, `peer_count`, *(v2: `your_sid`, `peers[]`)* | Join succeeded. `client_id` is our relay-side id. |
| `peer_joined` | `client_id`, `username`, `peer_count` | Someone joined → re-send `hello`, and if leader send a `resync`. |
| `peer_left` | `client_id`, `peer_count`, *(v2: `sid`)* | Someone left. |
| `pong` | `timestamp` | Answer to `{"type":"ping"}` keepalive (every 15 s). |

The relay's `client_id` for a peer is learnable: it is the `sender_id` it stamps onto
that peer's forwarded packets. Clients record `relayId` alongside each `sid` from the
peer's `hello`, so `peer_left` can be resolved to a concrete peer.

The v2 relay makes that indirection unnecessary — it puts the departing `sid` straight
into `peer_left`, and lists the room's existing members in `room_joined.peers[]`
(`client_id`, `sid`, `username`, `platform`). Both are **optional**: every client prefers
the direct `sid` when present and falls back to the `relayId` map, so nothing breaks on
the v1 server.

Presence is also timed out: a peer whose last packet is older than 25 s is dropped.

---

## 6. Echo suppression — deadline, not flag

v1 used `isRemoteUpdate = true; setTimeout(() => isRemoteUpdate = false, 350)`. Two
overlapping remote applies meant the first timer cleared the flag while the second was
still running, and the resulting local `play` event was re-broadcast.

v2 uses a monotonic deadline:

```js
_mute(ms) { this.remoteUntil = Math.max(this.remoteUntil, Date.now() + ms); }
get isRemoteUpdate() { return Date.now() < this.remoteUntil; }
```

Nested applies extend the deadline; they can never shorten it. Budgets:

| Situation | Mute |
|---|---|
| play / pause / rate apply | 400 ms |
| seek apply | 2500 ms, shortened to `now + 250 ms` by a one-shot `seeked` handler |
| heartbeat correction | 700 ms |

The long seek budget matters because a seek on a large local file can take over a second
to settle, and the `seeking`/`seeked`/`play` events it emits must not be mistaken for
user input.

Android uses the same idea (`WatchTogetherManager.remoteUntil`), plus a second window
`localOnlyUntil` for **lifecycle** pauses. Screen-off, backgrounding, an incoming call
and audio-focus loss all pause mpv — none of those may pause the whole room, so those
call sites use `pauseLocalOnly()` which pauses mpv with broadcasting suppressed.

PotPlayer uses the same deadline (`PotPlayerController.mute` / `mute_settled`) with
slightly larger budgets — 600 ms simple, 2500 ms seek shortened to 450 ms once settled,
900 ms heartbeat — because its 250 ms poll loop needs more than one tick to see the
result of a `SendMessage` land.

While muted, its poller re-baselines the **position** only, so the settle after a seek is
never mistaken for a user scrub. It deliberately does **not** re-baseline the play/pause
status: `_apply_remote_state` already set that baseline to the state it commanded, and
overwriting it with whatever PotPlayer currently reports *destroys* a pause the user
pressed inside the mute window — the next poll sees `status == last_status`, concludes
nothing changed, and the pause reaches nobody. Since a peer heartbeat mutes for 900 ms
every 3 s, roughly a third of all user pauses vanished this way, which is exactly the
"sometimes pausing PotPlayer doesn't pause the others" symptom. Leaving the status
baseline alone means the transition is simply reported as soon as the mute lifts.

---

## 7. Leader election

One participant emits heartbeats; everyone else only reacts to them.

```
score(p) = (p.isHost ? "0" : "1") + ":" + p.sid
leader   = the participant with the lowest score among { self } ∪ peersMap
```

Deterministic, needs no negotiation, converges as soon as `hello` packets have been
exchanged, and self-heals: if the leader leaves, it drops out of everyone's `peersMap`
and the next-lowest score takes over on the following tick.

- The leader sends `cause: "heartbeat"` every 3 s (only when media is loaded).
- A receiver accepts a heartbeat **only** from its computed leader.
- The leader ignores all incoming heartbeats.

Any client may still send explicit `play`/`pause`/`seek`/`rate` at any time. Leadership
governs *correction*, not *control* — the room is symmetric for user actions.

---

## 8. Legacy v1 clients

There is no compatibility shim. A v1 client in a v2 room is ignored: its packets have no
`v: 2` and are dropped by receiver rule 2. Update all three clients together.

---

## 9. Relay server notes

`potplayer/relay_server.py` in this repo is the v2 server. Differences from the deployed
v1:

- Forwards by **blocklist** instead of allowlist, so future kinds need no server change.
  The only frames it consumes itself are `ping`, `pong`, `join_room`/`join`, and the three
  control frames — which it also refuses to *forward*, so a client cannot inject a fake
  `peer_left` at its peers.
- `room_joined` also carries `your_sid` and a `peers` array.
- Records each peer's `sid` — from the join frame or from the first packet that declares
  one — so `peer_left` names the peer that actually left.
- Admits a client that starts sending before it joined, using the `room` in the packet.
  Without this, a peer whose join frame was lost to a relay restart goes permanently mute.

None of this is required. Every v2 client is written to work against the v1 server that
is currently running, and to use the extra fields only when present.

Run it with:

```bash
python3 relay_server.py 8765
```

behind nginx TLS at `/ws`.
