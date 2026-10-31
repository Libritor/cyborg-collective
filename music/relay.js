// MarGoth's own ear on the Collective relay.
//
// app.js already holds a socket, but the band must not fall silent because the
// page's socket blinked: that socket's onclose wipes every person and retries
// five seconds later (app.js:624), which would restart the piece every time the
// relay server recycles. So this module opens its OWN connection -- never
// importing app.js -- keeps the last known sharers across a reconnect, and
// treats a closed socket as a network fact, not as everyone leaving. Only a
// `leave` frame, a smaller `snapshot`, or a measured silence (seconds since
// that sender's last frame) takes a voice away.
//
// Consent comes first: a sharer reaches the music only with `playable: true`
// from the relay, and until the app side sends that flag a local allowlist
// (MAR_GOTH_ALLOW, or the `allow` option) stands in. Everyone else is labelled
// *not opened to the music* and contributes nothing -- no view, no role.

import {
  createSharer as newSharer, push, view, CHANNELS, BANDS, HOLD_S,
} from "./conditioner.js";

/** A sharer this quiet hands its role over. Seconds since its last frame. */
export const STALE_S = 4.0;
// conditioner.js calls a sharer "stale" at 6 s to decide when it stops voting in
// aggregate(); casting is a different question -- who plays what -- and doing it
// earlier keeps a handover off the bar line. The two numbers are separate on
// purpose; neither one is the socket's idea of alive.
export const RECONNECT_MS = 5000;   // the pause app.js uses between attempts
export const TICK_MS = 500;         // how often silence is measured
export const ROLES = Object.freeze(["drums", "bass", "harmony", "lead"]);
export const NOT_OPENED = "not opened to the music";
export const DEFAULT_RELAY = "wss://cyborg-collective-relay.onrender.com/live";

const NEUTRAL = 0.35;               // an absent feature is not evidence of zero
const CONTACT_WEIGHT = { 1: 1, 2: 0.7, 3: 0.3, 4: 0 };
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Admission: an explicit `playable` from the relay wins both ways, because a
 * person who said no must not be admitted by a leftover allowlist entry. With
 * no flag seen yet the allowlist decides -- that is the state the app side is
 * in today (nothing in app.js or api/ sends `playable`).
 */
export function admitted(record, allow) {
  if (!record) return false;
  if (record.playable === true) return true;
  if (record.playable === false) return false;
  return allow instanceof Set ? allow.has(record.pseudonym) : false;
}

/** The label a page shows: admitted-with-consent, admitted-by-allowlist, or no. */
export function labelOf(record, allow) {
  if (record.playable === true) return "playable";
  if (record.playable === false) return NOT_OPENED;
  return allow.has(record.pseudonym) ? "allowlisted" : NOT_OPENED;
}

/** `"a, b ,,c"` -> ["a","b","c"]; empty text is an empty allowlist. */
export function allowFrom(text, extra = []) {
  const out = [];
  for (const part of `${text || ""}`.split(",")) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  for (const id of extra || []) {
    const clean = `${id || ""}`.trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/** The env-ish allowlist: process.env in node, window.MAR_GOTH_ALLOW in a page. */
export function envAllow() {
  try {
    if (typeof process !== "undefined" && process.env && process.env.MAR_GOTH_ALLOW) {
      return process.env.MAR_GOTH_ALLOW;
    }
  } catch { /* a page has no process */ }
  try {
    if (typeof window !== "undefined" && typeof window.MAR_GOTH_ALLOW === "string") {
      return window.MAR_GOTH_ALLOW;
    }
  } catch { /* nor a node test a window */ }
  return "";
}

/** `playable` may ride on the person, on their `last` block, or on a frame. */
export function playableOf(source) {
  if (!source || typeof source !== "object") return undefined;
  if (typeof source.playable === "boolean") return source.playable;
  const last = source.last;
  if (last && typeof last === "object" && typeof last.playable === "boolean") {
    return last.playable;
  }
  return undefined;
}

/**
 * The relay's bands frame is band -> [one value per electrode]; the conditioner
 * reads electrode -> {band: value}. Left un-transposed, every band lands in the
 * wrong channel and alpha becomes delta, so the transpose is the whole point of
 * this function. A producer that already sends electrode-keyed rows passes
 * through untouched.
 */
export function transposeRel(rel) {
  if (!rel || typeof rel !== "object") return {};
  const probe = rel[CHANNELS[0]];
  if (probe && typeof probe === "object" && !Array.isArray(probe)) return rel;
  const out = {};
  for (let index = 0; index < CHANNELS.length; index += 1) {
    const row = {};
    for (const band of BANDS) {
      const values = rel[band];
      if (!Array.isArray(values)) continue;
      const value = num(values[index]);
      if (value !== null) row[band] = value;
    }
    if (Object.keys(row).length) out[CHANNELS[index]] = row;
  }
  return out;
}

/**
 * One relay frame -> the frame conditioner.push() understands, or null when the
 * frame carries nothing it uses (device, optics, eeg, profile, join). Null is
 * not an error: those frames still say the sharer is present.
 */
export function projectFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  switch (frame.t) {
    case "bands":
      return { t: "bands", rel: transposeRel(frame.rel) };
    case "quality":
      return { t: "quality", hsi: frame.hsi && typeof frame.hsi === "object" ? frame.hsi : {} };
    case "arousal":
      return { t: "arousal", index: frame.index, label: frame.label };
    case "hr":
      return { t: "hr", ok: frame.ok, bpm: frame.bpm, rmssd_ms: frame.rmssd_ms };
    case "imu":
      return { t: "imu", accel: frame.accel };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- casting
function ageOf(v, now) {
  if (v && typeof v.age === "number") return v.age;
  if (v && typeof v.at === "number" && typeof now === "number") return Math.max(0, now - v.at);
  return Infinity;
}

/** How well seated the electrodes are; unknown contact is neutral, not zero. */
function contactOf(v) {
  const hsi = v && v.hsi;
  if (!hsi || typeof hsi !== "object" || !CHANNELS.some((ch) => ch in hsi)) return 0.5;
  let sum = 0;
  for (const ch of CHANNELS) {
    const weight = CONTACT_WEIGHT[hsi[ch]];
    sum += weight === undefined ? 0.5 : weight;
  }
  return sum / CHANNELS.length;
}

function salienceOf(v) {
  const C = num(v.C);
  const steadiness = num(v.steadiness);
  if (C === null && steadiness === null) return NEUTRAL;
  return 0.6 * (C === null ? NEUTRAL : clamp01(C)) + 0.4 * (steadiness === null ? NEUTRAL : clamp01(steadiness));
}

/**
 * How well one head suits one part. Drums follow the body, the bass holds still
 * and low, harmony lives in alpha, the lead in beta and activation -- the same
 * features the generator reads, cast as roles instead of summed into one vote.
 */
function fitOf(role, v) {
  const arousal = num(v.arousal);
  const motion = num(v.motion);
  const alphaShare = num(v.alphaShare);
  const betaShare = num(v.betaShare);
  const steadiness = num(v.steadiness);
  switch (role) {
    case "drums":
      return 0.7 * (motion === null ? NEUTRAL : clamp01(motion))
        + 0.3 * (arousal === null ? NEUTRAL : clamp01(arousal));
    case "bass":
      return 0.5 * (arousal === null ? NEUTRAL : 1 - clamp01(arousal))
        + 0.5 * (steadiness === null ? NEUTRAL : clamp01(steadiness));
    case "harmony":
      return 0.6 * (alphaShare === null ? NEUTRAL : clamp01(alphaShare))
        + 0.4 * (steadiness === null ? NEUTRAL : clamp01(steadiness));
    case "lead":
      return 0.6 * (betaShare === null ? NEUTRAL : clamp01(betaShare))
        + 0.4 * (arousal === null ? NEUTRAL : clamp01(arousal));
    default:
      return 0;
  }
}

function scoreOf(role, v, now) {
  // a head that has been quiet for three of its four seconds keeps half its
  // standing: fresher ears hear the room better, but silence is not guilt
  const fresh = 1 - 0.5 * clamp01(ageOf(v, now) / STALE_S);
  return contactOf(v) * salienceOf(v) * fitOf(role, v) * fresh;
}

/**
 * Who plays what. Pure and deterministic: no clock, no randomness, and the same
 * list in the same order gives the same answer, so a caller can hold the result
 * across a hundred frames. Stale heads (age > STALE_S) and the gone are dropped
 * before anything is scored.
 *
 * Every part goes to the head that suits it best, most-decided part first, and
 * ties break on the pseudonym. That ordering matters: walking the parts in a
 * fixed order instead handed the lead to whoever was left over, which is how a
 * calm alpha head ended up playing the tune. Roles are spread as evenly as the
 * cast allows -- two sharers hold two parts each, and with one sharer that
 * sharer holds all four, which is a normal band of one, not a special case.
 */
export function assignRoles(sharers, { now = null } = {}) {
  const out = { drums: null, bass: null, harmony: null, lead: null };
  const cast = (sharers || [])
    .filter((v) => v && v !== null && !v.gone && ageOf(v, now) <= STALE_S)
    .slice()
    .sort((a, b) => (salienceOf(b) - salienceOf(a))
      || (a.pseudonym < b.pseudonym ? -1 : a.pseudonym > b.pseudonym ? 1 : 0));
  if (!cast.length) return out;

  const capacity = cast.map((_, index) => {
    const base = Math.floor(ROLES.length / cast.length);
    const extra = ROLES.length % cast.length;
    return Math.max(1, base + (index < extra ? 1 : 0));
  });

  const edges = [];
  for (const role of ROLES) {
    for (let index = 0; index < cast.length; index += 1) {
      edges.push({ role, index, score: scoreOf(role, cast[index], now) });
    }
  }
  edges.sort((a, b) => (b.score - a.score)
    || (ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
    || (cast[a.index].pseudonym < cast[b.index].pseudonym ? -1 : 1));

  for (const edge of edges) {
    if (out[edge.role] !== null || capacity[edge.index] <= 0) continue;
    out[edge.role] = cast[edge.index].pseudonym;
    capacity[edge.index] -= 1;
  }
  return out;
}

// ------------------------------------------------------------------ the relay
/**
 * Open the band's own socket and turn relay frames into conditioned sharers.
 *
 * `onSharers` fires when the CAST changes (a join, a leave, a head going quiet
 * or waking up), never per frame: read `sharers(now)` at bar time for the
 * numbers. `onStale(pseudonym, age)` fires once each time a sender crosses
 * STALE_S in silence; `onLeave(pseudonym, reason)` fires only for a sharer who
 * was really admitted, so an unpronounced disconnect fades nothing.
 */
export function createRelay({
  url = DEFAULT_RELAY,
  allow = [],
  onSharers = null,
  onStale = null,
  onLeave = null,
  onStatus = null,
  Socket = null,
  clock = null,
  reconnectMs = RECONNECT_MS,
} = {}) {
  const allowSet = new Set(allowFrom(envAllow(), allow));
  const now = clock || (() => Date.now() / 1000);
  const records = new Map();      // pseudonym -> record, admitted or not
  const cache = { key: null, roles: null };

  let socket = null;
  let state = "idle";             // idle | connecting | open | offline | closed
  let frames = 0;
  let lastFrameAt = null;
  let retry = null;
  let ticker = null;
  let closed = false;
  let castKey = "";
  // Silence is only evidence about a sharer while we could hear the relay. A
  // socket that is down for longer than STALE_S must not empty the band, and
  // neither must the instant it comes back: RECONNECT_MS (5 s) is longer than
  // STALE_S (4 s), so an unguarded age would mark every head stale on every
  // blip and re-cast the whole piece on return. Hence one rule, used by the
  // sweep, the cast and the views alike: a head is silent for the time it has
  // been quiet *since the current connection opened*.
  let offlineSince = null;        // when we stopped being able to hear
  let connectedSince = 0;         // when the current socket opened; 0 when fed by hand

  function setState(next) {
    if (state === next) return;
    state = next;
    if (onStatus) onStatus({ state, url, frames });
  }

  /** The clock the band judges by: frozen while the socket is down. */
  function judgeAt(at) {
    if (state !== "offline" && state !== "connecting") return at;
    return offlineSince === null ? at : Math.min(at, offlineSince);
  }

  /** Seconds of silence we can actually attribute to this sharer. */
  function audibleAge(r, at) {
    return Math.max(0, judgeAt(at) - Math.max(r.sharer.at, connectedSince));
  }

  function record(pseudonym) {
    let r = records.get(pseudonym);
    if (!r) {
      r = {
        pseudonym,
        name: null,
        playable: undefined,
        stale: false,
        sharer: newSharer(pseudonym),
      };
      records.set(pseudonym, r);
    }
    return r;
  }

  function isAdmitted(r) {
    return admitted(r, allowSet);
  }

  /** Admitted, awake, and actually carrying signal -- the only sharers the band hears. */
  function voiceList(at) {
    const out = [];
    const judged = judgeAt(at);
    for (const r of records.values()) {
      if (!isAdmitted(r) || r.stale || r.sharer.at === null) continue;
      const age = audibleAge(r, at);
      if (age > STALE_S) continue;
      const v = view(r.sharer, judged);
      if (v.gone) continue;
      // the view's age is wall-clock silence; ours is audible silence, which is
      // the only kind a band may act on -- so ours wins
      v.age = age;
      v.held = age > HOLD_S;
      // the raw contact codes ride along: casting weighs how well each electrode
      // is seated, and the view keeps only the channel names
      v.hsi = { ...r.sharer.hsi };
      v.name = r.name;
      out.push(v);
    }
    out.sort((a, b) => (a.pseudonym < b.pseudonym ? -1 : a.pseudonym > b.pseudonym ? 1 : 0));
    return out;
  }

  /**
   * Eligibility only -- no views, no scores. Called on every frame, so it must
   * not do the conditioning work: view() appends an alpha sample each time it
   * runs, and doing that per frame would both cost and blur steadiness.
   */
  function castKeyOf(at) {
    const ids = [];
    for (const r of records.values()) {
      if (!isAdmitted(r) || r.stale || r.sharer.at === null) continue;
      if (audibleAge(r, at) > STALE_S) continue;
      ids.push(r.pseudonym);
    }
    return ids.sort().join("|");
  }

  function syncCast(at) {
    const key = castKeyOf(at);
    if (key === castKey) return;
    castKey = key;
    cache.key = null;
    if (onSharers) onSharers(voiceList(at));
  }

  /** Measure silence. Nothing arrives to announce a dead headband, so we ask. */
  function sweep() {
    const at = now();
    let changed = false;
    for (const r of records.values()) {
      if (!isAdmitted(r) || r.sharer.at === null) continue;
      const age = audibleAge(r, at);
      if (age > STALE_S) {
        if (!r.stale) {
          r.stale = true;
          changed = true;
          if (onStale) onStale(r.pseudonym, age);
        }
      } else if (r.stale) {
        r.stale = false;
        changed = true;
      }
    }
    if (changed) syncCast(at);
  }

  function ingest(frame) {
    if (!frame || typeof frame !== "object" || typeof frame.t !== "string") return false;
    frames += 1;
    const at = now();
    lastFrameAt = at;
    const kind = frame.t;

    if (kind === "snapshot") {
      // The relay's snapshot is its full roster: anyone absent has gone. That is
      // relay-authored truth, unlike a socket closing, so it does prune -- the
      // same rule the api's own hub applies (api/relay.py:282-296, "a snapshot
      // is the relay's full roster: anyone absent has gone", documented at
      // api/README.md:430-441). Upserting only would be the wrong way round
      // here: a sharer who left while our socket was down cannot send us a
      // `leave`, so an absent-from-the-roster reachable sharer would have no way
      // to disappear at all. The piece does not restart on a blip -- a reconnect
      // that still lists everyone changes nothing (the cast is compared by
      // pseudonym, not by object identity), and only a roster that really shrank
      // fades a voice.
      const seen = new Set();
      for (const person of frame.people || []) {
        if (!person || typeof person !== "object") continue;
        const pseudonym = typeof person.pseudonym === "string" ? person.pseudonym : "";
        if (!pseudonym) continue;
        seen.add(pseudonym);
        const r = record(pseudonym);
        if (typeof person.name === "string") r.name = person.name;
        const flag = playableOf(person);
        if (typeof flag === "boolean") r.playable = flag;
        // a sharer who was already streaming when we connected has no future
        // frame to explain itself: seed the conditioner from the last blocks
        const last = person.last && typeof person.last === "object" ? person.last : null;
        if (last && isAdmitted(r)) {
          for (const block of ["quality", "bands", "arousal", "hr", "imu"]) {
            if (!last[block] || typeof last[block] !== "object") continue;
            const projected = projectFrame({ t: block, ...last[block] });
            if (projected) push(r.sharer, projected, at);
          }
        }
      }
      for (const [pseudonym, r] of [...records]) {
        if (seen.has(pseudonym)) continue;
        records.delete(pseudonym);
        if (isAdmitted(r) && onLeave) onLeave(pseudonym, "gone from the snapshot");
      }
      syncCast(at);
      return true;
    }

    if (kind === "leave") {
      const pseudonym = typeof frame.pseudonym === "string" ? frame.pseudonym : "";
      const r = records.get(pseudonym);
      if (r) {
        const wasHeard = isAdmitted(r);
        records.delete(pseudonym);
        if (wasHeard && onLeave) onLeave(pseudonym, "left");
      }
      syncCast(at);
      return true;
    }

    if (kind === "aggregate") return true;   // the relay's own tally, not a sharer

    const pseudonym = typeof frame.pseudonym === "string" ? frame.pseudonym : "";
    if (!pseudonym) return true;             // checkins_changed, shares_changed, ...
    const r = record(pseudonym);
    if (typeof frame.name === "string") r.name = frame.name;
    const flag = playableOf(frame);
    if (typeof flag === "boolean") {
      r.playable = flag;
      if (flag === false) {
        // consent withdrawn mid-share: the voice stops now, and the fade is real
        if (onLeave && !r.stale) onLeave(pseudonym, "consent withdrawn");
        r.stale = true;
      } else {
        r.stale = false;   // consent restored: back in the cast on its next frame
      }
    }
    const projected = projectFrame(frame);
    if (projected && isAdmitted(r)) {
      push(r.sharer, projected, at);
      r.stale = false;
    }
    syncCast(at);
    return true;
  }

  function connect() {
    if (closed) return;
    const Ctor = Socket || (typeof WebSocket === "function" ? WebSocket : null);
    if (!Ctor) {
      // no socket here (a node test with no browser): ingest() is the whole API
      setState("inert");
      return;
    }
    setState("connecting");
    let ws = null;
    try {
      ws = new Ctor(url);
    } catch {
      setState("offline");
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      // the ears are back: silence from before this moment cannot be attributed
      // to anyone, so the clock starts here rather than at the old last frame
      connectedSince = now();
      offlineSince = null;
      setState("open");
    };
    ws.onmessage = (event) => {
      try {
        ingest(JSON.parse(event.data));
      } catch { /* one malformed frame is not a reason to stop the band */ }
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* already gone */ }
    };
    ws.onclose = () => {
      // the band keeps playing with the sharers it last had: a lost socket is a
      // network fact, not a leave. Sound only stops when a sender is really gone.
      socket = null;
      if (closed) return;
      // Only the FIRST loss sets the freeze point. Re-stamping it on every failed
      // retry walks the frozen clock forward, so after two attempts the head looks
      // STALE_S seconds silent and the whole cast goes stale -- the band drops to
      // the vamp on a network blip, which is precisely what this clock exists to
      // prevent. Measured: an abrupt kill (no `leave` frames) marked both heads
      // stale within one retry cycle until this line stopped re-stamping.
      if (offlineSince === null) offlineSince = now();
      setState("offline");
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed || retry !== null) return;
    retry = setTimeout(() => { retry = null; connect(); }, reconnectMs);
    if (typeof retry === "object" && typeof retry.unref === "function") retry.unref();
  }

  ticker = setInterval(sweep, TICK_MS);
  if (ticker && typeof ticker.unref === "function") ticker.unref();

  if (url) connect();
  else setState("inert");

  return {
    url,
    allow: [...allowSet],

    /** Decoded relay frames, as the socket or a capture replay hands them over. */
    ingest,

    /**
     * Measure silence now. The interval calls it every TICK_MS, and so can the
     * page: a background tab throttles setInterval to once a minute, and a band
     * that only notices a dead headband once a minute has already lied.
     */
    sweep,

    /** Conditioned views for aggregate(), fresh at the `now` the caller is on. */
    sharers(at = now()) {
      return voiceList(at);
    },

    /** Admitted, awake sharers as plain records, for status and labelling. */
    all(at = now()) {
      const out = [];
      for (const r of records.values()) {
        out.push({
          pseudonym: r.pseudonym,
          name: r.name,
          label: labelOf(r, allowSet),
          admitted: isAdmitted(r),
          playable: r.playable === undefined ? null : r.playable,
          stale: r.stale,
          frames: r.sharer.frames,
          age: r.sharer.at === null ? null : audibleAge(r, at),
        });
      }
      return out.sort((a, b) => (a.pseudonym < b.pseudonym ? -1 : 1));
    },

    /**
     * role -> pseudonym. Recomputed only when the eligible cast changes, so 50
     * frames from the same two heads never reshuffle the band.
     */
    roles(at = now()) {
      const views = voiceList(at);
      const key = views.map((v) => v.pseudonym).join("|");
      if (key !== cache.key || cache.roles === null) {
        cache.key = key;
        cache.roles = assignRoles(views, { now: at });
      }
      return { ...cache.roles };
    },

    status() {
      let heard = 0;
      let refused = 0;
      for (const r of records.values()) {
        if (isAdmitted(r)) heard += 1;
        else refused += 1;
      }
      return {
        state,
        url,
        frames,
        lastFrameAt,
        sharers: voiceList(now()).length,
        admitted: heard,
        refused,
      };
    },

    /** Forget the socket and the roster; the parent calls this on page unload. */
    close() {
      closed = true;
      if (retry !== null) { clearTimeout(retry); retry = null; }
      if (ticker !== null) { clearInterval(ticker); ticker = null; }
      if (socket) {
        const ws = socket;
        socket = null;
        try { ws.onclose = null; ws.close(); } catch { /* already shut */ }
      }
      records.clear();
      cache.key = null;
      cache.roles = null;
      castKey = "";
      setState("closed");
    },
  };
}
