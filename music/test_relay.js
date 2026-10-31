// Proof for the band's ear on the relay: casting, consent, and the one thing a
// consumer must never get wrong -- a closed socket is not a person leaving.
// Run: node music/test_relay.js -> "PASS <n> assertions", exit 0. No network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "./conditioner.js";
import {
  createRelay, assignRoles, transposeRel, projectFrame, allowFrom, envAllow,
  admitted, labelOf, playableOf, ROLES, STALE_S, NOT_OPENED,
} from "./relay.js";
import { aggregate } from "./generator.js";

let assertions = 0;
const failures = [];
function check(condition, label) {
  assertions += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = { t: 0 };
const now = () => clock.t;

/** One relay tick, in the shapes api/simulate.py and the real relay send. */
function tickFrames(pseudonym, spec = {}) {
  const { alpha = 0.35, theta = 0.2, beta = 0.25, contact = 1, arousal = 0.5, motion = 0.2 } = spec;
  const rel = { delta: [], theta: [], alpha: [], beta: [], gamma: [] };
  for (let channel = 0; channel < CHANNELS.length; channel += 1) {
    rel.delta.push(0.15 + 0.01 * channel);
    rel.theta.push(typeof theta === "number" ? theta : theta[channel]);
    rel.alpha.push(typeof alpha === "number" ? alpha : alpha[channel]);
    rel.beta.push(typeof beta === "number" ? beta : beta[channel]);
    rel.gamma.push(0.08);
  }
  return [
    { t: "bands", pseudonym, rel, abs: rel },
    { t: "quality", pseudonym, hsi: { TP9: contact, AF7: contact, AF8: contact, TP10: contact } },
    { t: "arousal", pseudonym, index: arousal, label: "alert", confidence: 0.8, quality: { score: 0.8 } },
    { t: "hr", pseudonym, ok: true, bpm: 64, rmssd_ms: 42, sdnn_ms: 55 },
    { t: "imu", pseudonym, gyro: [0, 0, 0], accel: [0, 0, 1 + motion] },
  ];
}

/** A relay with no socket at all: the frames are fed by hand. */
function openRelay(options = {}) {
  const calls = { sharers: [], stale: [], leave: [], status: [] };
  const relay = createRelay({
    url: null,                      // never dial anything in a node test
    clock: now,
    onSharers: (list) => calls.sharers.push(list.map((v) => v.pseudonym)),
    onStale: (pseudonym, age) => calls.stale.push([pseudonym, age]),
    onLeave: (pseudonym, reason) => calls.leave.push([pseudonym, reason]),
    onStatus: (status) => calls.status.push(status.state),
    ...options,
  });
  return { relay, calls };
}

function feed(relay, pseudonym, spec, frames = 1) {
  for (let i = 0; i < frames; i += 1) {
    for (const frame of tickFrames(pseudonym, spec)) relay.ingest(frame);
  }
}

/** Two heads that want different parts: a calm alpha one and a busy beta one. */
const ALPHA_HEAD = { alpha: 0.6, theta: 0.15, beta: 0.1, arousal: 0.3, motion: 0.1 };
const BETA_HEAD = { alpha: 0.1, theta: 0.15, beta: 0.6, arousal: 0.9, motion: 0.8 };

// ------------------------------------------------------- purity of the module
console.log("assignRoles is a pure function");
const source = readFileSync(fileURLToPath(new URL("./relay.js", import.meta.url)), "utf8");
const pure = source.slice(source.indexOf("function ageOf"), source.indexOf("// ------------------------------------------------------------------ the relay"));
check(pure.length > 1000 && !/\bDate\b/.test(pure),
  "the casting code never reads a clock");
check(!/Math\.random/.test(pure), "the casting code never uses randomness");
check(!/Math\.random/.test(source), "nothing in relay.js invents a number from the air");

clock.t = 0;
const { relay: castRelay } = openRelay({ allow: ["alpha-head", "beta-head"] });
feed(castRelay, "alpha-head", ALPHA_HEAD, 12);
feed(castRelay, "beta-head", BETA_HEAD, 12);
const views = castRelay.sharers(now());
check(views.length === 2, `two admitted heads produce two views (got ${views.length})`);

const first = assignRoles(views, { now: now() });
const again = assignRoles(views, { now: now() });
check(JSON.stringify(first) === JSON.stringify(again), "the same cast yields the same roles");
const reversed = assignRoles([...views].reverse(), { now: now() });
check(JSON.stringify(first) === JSON.stringify(reversed), "input order does not change the cast");

// ------------------------------------------------------------- the projection
console.log("the frame projection");
check(transposeRel({ alpha: [0.1, 0.2, 0.3, 0.4] }).AF8.alpha === 0.3,
  "band-keyed arrays transpose to electrode-keyed rows (AF8 is index 2)");
const exact = { t: "bands", rel: { alpha: [0.6, 0.6, 0.6, 0.6], theta: [0.15, 0.15, 0.15, 0.15], beta: [0.1, 0.1, 0.1, 0.1] } };
const { relay: orientRelay } = openRelay({ allow: ["orient"] });
clock.t = 100;
orientRelay.ingest({ t: "quality", pseudonym: "orient", hsi: { TP9: 1, AF7: 1, AF8: 1, TP10: 1 } });
orientRelay.ingest({ ...exact, pseudonym: "orient" });
const orientView = orientRelay.sharers(100)[0];
check(orientView && Math.abs(orientView.alphaShare - 0.6 / 0.85) < 1e-12,
  "alpha lands in alpha: alphaShare is 0.6/(0.6+0.15+0.1), not a transposed mix");
check(projectFrame({ t: "optics" }) === null, "an optics frame carries nothing the conditioner uses");

// The other keying: test_generator.js:30-45 feeds push() electrode-keyed rows,
// so both conventions must reach the conditioner intact -- if they disagreed,
// the two suites would disagree about alpha and neither would error.
const generatorFrame = {
  t: "bands",
  rel: {
    TP9: { delta: 0.40, theta: 0.20, alpha: 0.18, beta: 0.12, gamma: 0.10 },
    AF7: { delta: 0.36, theta: 0.22, alpha: 0.24, beta: 0.10, gamma: 0.08 },
    AF8: { delta: 0.34, theta: 0.18, alpha: 0.30, beta: 0.12, gamma: 0.06 },
    TP10: { delta: 0.42, theta: 0.19, alpha: 0.16, beta: 0.13, gamma: 0.10 },
  },
};
check(transposeRel(generatorFrame.rel) === generatorFrame.rel,
  "an already electrode-keyed frame passes through untouched");
const { relay: keyRelay } = openRelay({ allow: ["keyed"] });
clock.t = 150;
keyRelay.ingest({ t: "quality", pseudonym: "keyed", hsi: { TP9: 1, AF7: 1, AF8: 2, TP10: 2 } });
keyRelay.ingest({ ...generatorFrame, pseudonym: "keyed" });
const keyedView = keyRelay.sharers(150)[0];
check(keyedView && Math.abs(keyedView.alphaShare - 0.22 / 0.535) < 1e-12,
  "the generator suite's own frame yields the same alpha share through the relay");
keyRelay.close();
orientRelay.close();

// ------------------------------------------- the aggregate seam the parent uses
console.log("the aggregate seam");
const controls = aggregate(views, now());
check(controls.heads === 2 && controls.mode === "live",
  `two views aggregate to a live band of two (heads ${controls.heads}, mode ${controls.mode})`);
check(typeof controls.C === "number" && controls.C > 0 && controls.C < 1,
  `the aggregate carries a concentration (${controls.C.toFixed(3)})`);
check(typeof controls.alphaShare === "number" && controls.alphaShare > 0.2,
  `the aggregate carries an alpha share (${controls.alphaShare.toFixed(3)})`);
const solo = aggregate([views[1]], now());
check(solo.heads === 1, "one view aggregates to a band of one");

// ------------------------------------------------------------------ casting
console.log("casting");
check(Object.keys(first).length === 4 && ROLES.every((role) => role in first),
  "every one of the four parts has an entry");
const heldByAlpha = ROLES.filter((role) => first[role] === "alpha-head");
const heldByBeta = ROLES.filter((role) => first[role] === "beta-head");
check(heldByAlpha.length === 2 && heldByBeta.length === 2,
  `two heads hold two parts each (alpha ${heldByAlpha.join("+")}, beta ${heldByBeta.join("+")})`);
check(!heldByAlpha.some((role) => heldByBeta.includes(role)),
  "no two heads hold the same part");

// 40 more frames, with the alpha head turning into a drummer's body: the cast
// has not changed, so the band must not reshuffle under the players.
const stable = [];
for (let i = 0; i < 40; i += 1) {
  clock.t += 0.125;
  const drift = i < 20 ? ALPHA_HEAD : { ...ALPHA_HEAD, motion: 0.95, arousal: 0.95 };
  feed(castRelay, "alpha-head", drift);
  feed(castRelay, "beta-head", BETA_HEAD);
  stable.push(JSON.stringify(castRelay.roles(now())));
}
check(stable.every((key) => key === stable[0]), "40 frames of drift leave the roles alone");
check(stable[0] === JSON.stringify(first),
  "the held roles are the ones the pure function chose for this cast");
check(first.drums === "beta-head" && first.lead === "beta-head",
  "the activated, moving head takes the drums and the lead");
check(first.bass === "alpha-head" && first.harmony === "alpha-head",
  "the settled, alpha-rich head takes the bass and the harmony");
check(castRelay.status().frames > 100, `every frame is counted (${castRelay.status().frames})`);

// a cast that shrinks hands over in one step, and only once
const before = castRelay.roles(now());
clock.t += 0.125;
castRelay.ingest({ t: "leave", pseudonym: "beta-head" });
const handover = castRelay.roles(now());
const after = [];
for (let i = 0; i < 10; i += 1) {
  clock.t += 0.125;
  feed(castRelay, "alpha-head", ALPHA_HEAD);
  after.push(JSON.stringify(castRelay.roles(now())));
}
check(JSON.stringify(handover) === JSON.stringify(castRelay.roles(now())),
  "the handover settles immediately");
check(after.every((key) => key === JSON.stringify(handover)),
  "ten frames after the handover change nothing");
const movedRoles = ROLES.filter((role) => before[role] !== handover[role]);
check(movedRoles.length === 2 && ROLES.every((role) => handover[role] === "alpha-head"),
  `the two parts the gone head held move in one step (${movedRoles.join("+")})`);
check(JSON.stringify(handover) === JSON.stringify(assignRoles(castRelay.sharers(now()), { now: now() })),
  "the settled cast equals a fresh cast of who is left");

// one head, four parts
console.log("one head, four parts");
const single = assignRoles(castRelay.sharers(now()), { now: now() });
check(ROLES.every((role) => single[role] === "alpha-head"),
  "a solo head drives drums, bass, harmony and lead -- no special case");
check(JSON.stringify(single) === JSON.stringify(handover), "the relay agrees with the raw cast");

// ------------------------------------------------------------------ staleness
console.log("staleness");
clock.t += 1;
const stillHeard = castRelay.status().sharers;
check(stillHeard === 1, "one head is still in the cast");
clock.t += STALE_S + 0.5;
castRelay.sweep();
const dead = castRelay.sharers(now());
check(dead.length === 0, "a head silent past 4 s leaves the cast");
check(ROLES.every((role) => castRelay.roles(now())[role] === null),
  "every part is empty when the only head has gone quiet");
check(castRelay.all(now())[0].stale === true, "the record stays, marked stale");
const staleCount = castRelay.status().admitted;
check(staleCount === 1, "the lost head is still listed (a quiet head is not a gone head)");
castRelay.sweep();
check(castRelay.all(now())[0].stale === true, "measuring again does not flip the flag");

// ---------------------------------------------- the socket is not the roster
console.log("a closed socket is not a leave");
function fakeSocket() {
  const made = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      made.push(this);
    }
    close() { if (this.onclose) this.onclose(); }
  }
  FakeSocket.made = made;
  return FakeSocket;
}
clock.t = 0;
const Socket = fakeSocket();
const blipCalls = { leave: [], stale: [], status: [], sharers: [] };
const blip = createRelay({
  url: "ws://127.0.0.1:1/live",
  allow: ["alpha-head", "beta-head"],
  clock: now,
  reconnectMs: 5,
  Socket,
  onLeave: (pseudonym, reason) => blipCalls.leave.push([pseudonym, reason]),
  onStale: (pseudonym, age) => blipCalls.stale.push([pseudonym, age]),
  onStatus: (status) => blipCalls.status.push(status.state),
  onSharers: (list) => blipCalls.sharers.push(list.length),
});
check(Socket.made.length === 1, "the relay dials its own socket once");
const opened = Socket.made[0];
opened.onopen();
feed(blip, "alpha-head", ALPHA_HEAD, 6);
feed(blip, "beta-head", BETA_HEAD, 6);
const beforeBlip = JSON.stringify(blip.roles(now()));
const heardBefore = blip.sharers(now()).length;
check(heardBefore === 2, "both heads are heard while the socket is up");

opened.onclose();                       // the network drops; nobody said leave
const duringOutage = blip.sharers(now());
check(duringOutage.length === 2, "both heads survive the socket closing");
check(JSON.stringify(blip.roles(now())) === beforeBlip, "the cast is unchanged by the outage");
check(blipCalls.leave.length === 0, "a closed socket fires no leave");
check(blip.status().state === "offline", "the relay reports itself offline, not empty");

// the outage outlasts STALE_S, which is shorter than the reconnect pause: a
// deaf socket must not be read as two people going silent
clock.t += STALE_S + 3;
blip.sweep();
check(blipCalls.stale.length === 0, "silence during an outage is not attributed to a head");
check(blip.sharers(now()).length === 2, "both heads survive an outage longer than 4 s");
check(JSON.stringify(blip.roles(now())) === beforeBlip, "an outage longer than 4 s keeps the cast");
clock.t += 1;
feed(blip, "alpha-head", ALPHA_HEAD, 2);
check(blip.sharers(now()).length === 2, "frames that arrive anyway still count");
await sleep(30);
check(Socket.made.length === 2, "the relay retries its own connection");
Socket.made[1].onopen();
check(blipCalls.status.includes("offline") && blipCalls.status.includes("open"),
  "status walked open -> offline -> open");
check(blip.sharers(now()).length === 2, "the cast is still intact the moment the socket returns");
check(Array.isArray(blipCalls.sharers) && blipCalls.sharers.length <= 2,
  "the outage re-announced no cast change");
// the reconnect roster still lists both heads: that must be a no-op, not a re-cast
const castsBeforeRoster = blipCalls.sharers.length;
blip.ingest({ t: "snapshot", people: [{ pseudonym: "alpha-head", last: {} }, { pseudonym: "beta-head", last: {} }] });
check(JSON.stringify(blip.roles(now())) === beforeBlip && blipCalls.sharers.length === castsBeforeRoster,
  "a reconnect snapshot that still lists everyone changes nothing");
check(blip.sharers(now()).length === 2 && blipCalls.leave.length === 0,
  "a snapshot without a playable flag does not revoke the allowlist");
// and now that we can hear again, real silence does drop a head
clock.t += STALE_S + 1;
blip.sweep();
check(blipCalls.stale.length === 2, `both heads are stale once the silence is ours to hear (${blipCalls.stale.length})`);
check(blip.sharers(now()).length === 0, "a head that stays quiet while we listen leaves the cast");
blip.close();
const socketsAfterClose = Socket.made.length;
await sleep(30);
check(Socket.made.length === socketsAfterClose, "a closed relay stops retrying");

// ------------------------------------------------- an outage does not re-cast
// A killed server sends no leave frames, and a real outage spans several retry
// attempts while the wall clock keeps moving. The frozen clock must be stamped
// once, at the first loss: re-stamping it on every failed retry walks it forward
// until the whole cast looks stale and the band drops to the vamp on a blip.
console.log("a blip does not re-cast");
clock.t = 900;
const killedSocket = fakeSocket();
const blip2Calls = { stale: [], leave: [], sharers: [] };
const blip2 = createRelay({
  url: "ws://127.0.0.1:1/live",
  allow: ["alpha-head", "beta-head"],
  clock: now,
  reconnectMs: 2,
  Socket: killedSocket,
  onStale: (pseudonym) => blip2Calls.stale.push(pseudonym),
  onLeave: (pseudonym, reason) => blip2Calls.leave.push([pseudonym, reason]),
  onSharers: (list) => blip2Calls.sharers.push(list.length),
});
killedSocket.made[0].onopen();
feed(blip2, "alpha-head", ALPHA_HEAD, 6);
feed(blip2, "beta-head", BETA_HEAD, 6);
const outageCast = blip2.status().admitted;
const outageRoles = JSON.stringify(blip2.roles(now()));
check(outageCast === 2, "two heads are heard before the outage");

killedSocket.made[0].onclose();            // the server dies: no leave frames
for (let attempt = 1; attempt <= 3; attempt += 1) {
  clock.t += STALE_S;                      // real time passes between attempts
  await sleep(10);                         // the retry fires and fails on its own
  if (killedSocket.made[attempt]) killedSocket.made[attempt].onclose();
}
blip2.sweep();
check(blip2Calls.stale.length === 0,
  `nobody goes stale across ${3} failed retries spanning ${3 * STALE_S}s offline`);
check(blip2Calls.leave.length === 0, "a dead socket announces no leave");
check(blip2.status().admitted === outageCast, "the cast survives the outage intact");
check(JSON.stringify(blip2.roles(now())) === outageRoles, "the roles do not reshuffle during the outage");
blip2.close();

// --------------------------------------------------------------------- consent
console.log("consent");
process.env.MAR_GOTH_ALLOW = "env-head, opt-head";
check(envAllow() === "env-head, opt-head", "the allowlist is read from the environment");
check(JSON.stringify(allowFrom(envAllow(), ["extra-head"])) === JSON.stringify(["env-head", "opt-head", "extra-head"]),
  "the option adds to the environment list");
check(JSON.stringify(allowFrom(" a ,, a , b ")) === JSON.stringify(["a", "b"]),
  "the allowlist is trimmed and deduplicated");
delete process.env.MAR_GOTH_ALLOW;
check(envAllow() === "", "no environment variable means no allowlist");

check(admitted({ pseudonym: "x", playable: true }, new Set()) === true,
  "playable true admits without any allowlist");
check(admitted({ pseudonym: "x", playable: false }, new Set(["x"])) === false,
  "playable false keeps an allowlisted head out");
check(admitted({ pseudonym: "x" }, new Set(["x"])) === true, "no flag falls back to the allowlist");
check(labelOf({ pseudonym: "x" }, new Set()) === NOT_OPENED,
  `a stranger is labelled "${NOT_OPENED}"`);
check(playableOf({ last: { playable: true } }) === true, "the flag may ride on the last block");

clock.t = 200;
const consent = openRelay({ allow: ["allowed"] });
consent.relay.ingest({
  t: "snapshot",
  people: [
    { pseudonym: "allowed", tier: "raw", last: {} },
    { pseudonym: "stranger", tier: "raw", last: {} },
    { pseudonym: "asked", tier: "raw", playable: false, last: {} },
    { pseudonym: "offered", tier: "raw", playable: true, last: {} },
  ],
});
feed(consent.relay, "allowed", ALPHA_HEAD);
feed(consent.relay, "stranger", BETA_HEAD);
feed(consent.relay, "asked", ALPHA_HEAD);
feed(consent.relay, "offered", BETA_HEAD);
const heard = consent.relay.sharers(now()).map((v) => v.pseudonym).sort();
check(JSON.stringify(heard) === JSON.stringify(["allowed", "offered"]),
  `only the allowlisted and the willing are heard (${heard.join(", ")})`);
const labels = consent.relay.all(now());
check(labels.find((r) => r.pseudonym === "stranger").label === NOT_OPENED
  && labels.find((r) => r.pseudonym === "allowed").label === "allowlisted"
  && labels.find((r) => r.pseudonym === "offered").label === "playable",
  "each head is labelled by how it was admitted");
check(consent.relay.status().refused === 2, "the refused heads are counted, not silently dropped");
const consentRoles = consent.relay.roles(now());
check(ROLES.every((role) => consentRoles[role] === "allowed" || consentRoles[role] === "offered"),
  "a refused head holds no part");
check(aggregate(consent.relay.sharers(now()), now()).heads === 2,
  "a refused head contributes nothing to the aggregate");

// a snapshot that is only the allowlist admits mid-share on the last blocks
clock.t = 300;
const cold = openRelay({ allow: ["seed"] });
cold.relay.ingest({
  t: "snapshot",
  people: [{
    pseudonym: "seed", tier: "raw", last: {
      quality: { hsi: { TP9: 1, AF7: 1, AF8: 1, TP10: 1 } },
      bands: { rel: { alpha: [0.6, 0.6, 0.6, 0.6], theta: [0.15, 0.15, 0.15, 0.15], beta: [0.1, 0.1, 0.1, 0.1] } },
      arousal: { index: 0.4, label: "alert" },
      hr: { ok: true, bpm: 60 },
    }, playable: true,
  }],
});
const coldView = cold.relay.sharers(now())[0];
check(coldView && Math.abs(coldView.alphaShare - 0.6 / 0.85) < 1e-12,
  "a snapshot's last blocks cold-start a head it never saw stream");
check(ROLES.every((role) => cold.relay.roles(now())[role] === "seed"),
  "the cold-started head takes the band");

// consent withdrawn mid-share stops the voice once
clock.t = 400;
feed(cold.relay, "seed", ALPHA_HEAD);
cold.relay.ingest({ t: "profile", pseudonym: "seed", playable: false });
check(cold.relay.sharers(now()).length === 0, "withdrawing consent removes the voice now");
check(cold.calls.leave.filter(([, reason]) => reason === "consent withdrawn").length === 1,
  "the fade is announced exactly once");
cold.relay.ingest({ t: "profile", pseudonym: "seed", playable: false });
check(cold.relay.sharers(now()).length === 0, "a repeated withdrawal announces nothing further");

// a snapshot is the relay's roster: absent means gone, and the fade is real
clock.t = 500;
const roster = openRelay({ allow: ["a", "b"] });
roster.relay.ingest({ t: "snapshot", people: [{ pseudonym: "a", last: {} }, { pseudonym: "b", last: {} }] });
feed(roster.relay, "a", ALPHA_HEAD, 3);
feed(roster.relay, "b", BETA_HEAD, 3);
check(roster.relay.sharers(now()).length === 2, "two heads from the roster are heard");
roster.relay.ingest({ t: "snapshot", people: [{ pseudonym: "a", last: {} }] });
check(roster.relay.sharers(now()).length === 1, "a smaller snapshot drops the head that left");
check(roster.calls.leave.length === 1 && roster.calls.leave[0][0] === "b",
  "the dropped head is announced as a leave, once");

// a refused head leaving is no event at all: nothing was ever playing
roster.relay.ingest({ t: "leave", pseudonym: "stranger" });
check(roster.calls.leave.length === 1, "a leave from a refused head announces nothing");

// onSharers is the cast changing, not the signal moving
const joinCalls = roster.calls.sharers.length;
feed(roster.relay, "a", ALPHA_HEAD, 30);
check(roster.calls.sharers.length === joinCalls,
  "thirty frames of one head change the cast zero times");

roster.relay.close();
consent.relay.close();
cold.relay.close();
castRelay.close();

console.log(failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions`
  : `\nPASS ${assertions} assertions`);
for (const label of failures) console.log(`  - ${label}`);
process.exit(failures.length ? 1 : 0);
