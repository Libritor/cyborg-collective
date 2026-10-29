(() => {
  "use strict";
  const CH = ["TP9", "AF7", "AF8", "TP10"];
  const BANDS = ["delta", "theta", "alpha", "beta", "gamma"];
  const $ = id => document.getElementById(id);

  // ---------------- live: the Cyborg Collective relay ----------------
  const people = new Map();
  const grid = $("grid"), empty = $("empty"), linkEl = $("link");
  function tierLabel(t) {
    return { presence: "presence only", quality: "contact quality", bands: "band powers",
             arousal: "estimate + heart", raw: "raw EEG" }[t] || t;
  }
  function card(p) {
    const el = document.createElement("section");
    el.className = "card";
    el.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:16px"><span class="name"></span><span class="badge tier"></span><span class="badge dev"></span></h3>
      <div class="said"><span class="pseud" hidden></span><span class="chip activity" hidden></span></div>
      <div class="mood" hidden><canvas class="moodgrid" width="54" height="54"></canvas><span class="moodtext"></span></div>
      <div class="dots">${CH.map(c => `<div class="dot" data-ch="${c}"><i></i>${c}</div>`).join("")}</div>
      <div class="est"><b>—</b><small></small></div>
      <div class="reason"></div>
      <div class="hr"></div>
      <div class="checkin" hidden></div>
      <canvas class="bands" height="70" hidden></canvas>
      <canvas class="raw" height="70" hidden></canvas>`;
    el.querySelector(".name").textContent = p.pseudonym;
    el.querySelector(".tier").textContent = tierLabel(p.tier);
    el.querySelector(".dev").textContent = p.device || "";
    return el;
  }
  function ensure(msg) {
    let p = people.get(msg.pseudonym);
    if (!p) {
      p = { pseudonym: msg.pseudonym, tier: msg.tier, device: msg.device, raw: CH.map(() => []) };
      p.el = card(p); grid.appendChild(p.el); people.set(msg.pseudonym, p); empty.hidden = true;
      if (msg.name || msg.activity || msg.mood) setProfile(p, msg);
    }
    return p;
  }
  // what the person typed: name (else the pseudonym), what they are doing,
  // and their own mood rating. Labelled self-rated; never from the signal.
  function setProfile(p, m) {
    const name = p.el.querySelector(".name"), pseud = p.el.querySelector(".pseud");
    const act = p.el.querySelector(".chip.activity"), mood = p.el.querySelector(".mood");
    if (m.name) { name.textContent = m.name; pseud.textContent = p.pseudonym; pseud.hidden = false; }
    else { name.textContent = p.pseudonym; pseud.hidden = true; }
    if (m.activity) { act.textContent = m.activity; act.hidden = false; } else act.hidden = true;
    if (m.mood && m.mood.arousal) {
      mood.hidden = false;
      drawMood(mood.querySelector("canvas"), m.mood.arousal, m.mood.valence);
      mood.querySelector(".moodtext").textContent =
        `self-rated mood · arousal ${m.mood.arousal}/9 · valence ${m.mood.valence}/9${m.mood.word ? ` · “${m.mood.word}”` : ""}`;
    } else mood.hidden = true;
  }
  function drawMood(cv, arousal, valence) {
    const s = cv.width, ctx = cv.getContext("2d"), cell = s / 9;
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--line") || "#ccc";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 9; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell + 0.5, 0); ctx.lineTo(i * cell + 0.5, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell + 0.5); ctx.lineTo(s, i * cell + 0.5); ctx.stroke();
    }
    ctx.fillStyle = "#4f46e5";
    ctx.fillRect((valence - 1) * cell + 1, (9 - arousal) * cell + 1, cell - 1, cell - 1);
  }
  function fmtCheckin(c) {
    const r = c.self_rating, parts = [];
    if (c.date) parts.push(c.date);
    if (r && r.arousal) parts.push(`self-rated ${r.arousal}/9 · ${r.valence}/9${r.word ? ` “${r.word}”` : ""}`);
    if (c.estimate_median != null) parts.push(`resting estimate ${Math.round(c.estimate_median * 100)}%`);
    else parts.push("resting estimate: no claim");
    if (c.usable_fraction != null) parts.push(`${Math.round(c.usable_fraction * 100)}% usable`);
    if (c.sleep_hours != null) parts.push(`sleep ${c.sleep_hours} h`);
    if (c.caffeine) parts.push(c.caffeine);
    if (c.hr_bpm_mean != null) parts.push(`♥ ${Math.round(c.hr_bpm_mean)}`);
    return parts.join(" · ");
  }
  function setCheckin(p, c) {
    const el = p.el.querySelector(".checkin");
    el.hidden = false;
    el.textContent = `today's check-in: ${fmtCheckin(c)}${c.publish ? " · published" : ""}`;
  }
  function remove(pseudonym) {
    const p = people.get(pseudonym);
    if (!p) return;
    p.el.remove(); people.delete(pseudonym);
    if (people.size === 0) empty.hidden = false;
  }
  function setQuality(p, q) {
    for (const c of CH) {
      const d = p.el.querySelector(`.dot[data-ch="${c}"]`);
      const v = q.hsi ? q.hsi[c] : undefined;
      d.className = "dot " + (v === 1 ? "g" : v === 2 ? "o" : v === undefined ? "" : "b");
    }
  }
  function setArousal(p, a) {
    const est = p.el.querySelector(".est"), reason = p.el.querySelector(".reason");
    if (a.index === null || a.index === undefined || a.label === "no_claim") {
      est.className = "est noclaim"; est.querySelector("b").textContent = "no claim";
      est.querySelector("small").textContent = `contact ${Math.round((a.quality?.score ?? 0) * 100)}%`;
      reason.textContent = a.reason || "signal unusable";
    } else {
      est.className = "est"; est.querySelector("b").textContent = Math.round(a.index * 100) + "%";
      est.querySelector("small").textContent =
        `activation estimate · ${a.label} · confidence ${Math.round(a.confidence * 100)}% · contact ${Math.round((a.quality?.score ?? 0) * 100)}%`;
      reason.textContent = "";
    }
  }
  function setHr(p, h) {
    p.el.querySelector(".hr").textContent = h.ok
      ? `♥ ${Math.round(h.bpm)} bpm · RMSSD ${Math.round(h.rmssd_ms)} ms · ${h.source}`
      : `♥ detecting beats (${h.beats} found, ${h.source})`;
  }
  function drawBands(p, b) {
    const cv = p.el.querySelector("canvas.bands"); cv.hidden = false;
    const ctx = cv.getContext("2d");
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = 70 * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    const colors = ["#6366f1", "#0ea5e9", "#16a34a", "#d97706", "#dc2626"];
    const gw = W / BANDS.length;
    BANDS.forEach((name, i) => {
      const vals = b.rel[name] || [];
      const nums = vals.filter(Number.isFinite); // null = channel without contact
      const mean = nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : 0;
      const h = Math.max(2, mean * (H - 18 * devicePixelRatio));
      ctx.fillStyle = colors[i];
      ctx.fillRect(i * gw + gw * 0.2, H - 14 * devicePixelRatio - h, gw * 0.6, h);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
      ctx.font = `${10 * devicePixelRatio}px system-ui`; ctx.textAlign = "center";
      ctx.fillText(`${name} ${(mean * 100).toFixed(0)}%`, i * gw + gw / 2, H - 3 * devicePixelRatio);
    });
  }
  function drawRaw(p, e) {
    const cv = p.el.querySelector("canvas.raw"); cv.hidden = false;
    const maxLen = 256 * 4;
    e.x.forEach((arr, i) => { p.raw[i].push(...arr); if (p.raw[i].length > maxLen) p.raw[i].splice(0, p.raw[i].length - maxLen); });
    const ctx = cv.getContext("2d");
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = 70 * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    const laneH = H / 4;
    p.raw.forEach((arr, i) => {
      if (arr.length < 2) return;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length) || 1;
      ctx.beginPath(); ctx.strokeStyle = "#4f46e5"; ctx.lineWidth = devicePixelRatio;
      arr.forEach((v, k) => { const x = k / maxLen * W, y = laneH * i + laneH / 2 - ((v - mean) / (4 * sd)) * laneH / 2; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    });
  }
  function aggregate(a) {
    $("n").textContent = a.n;
    $("usable").textContent = a.n ? `${a.usable_n} / ${a.n}` : "—";
    $("alpha").textContent = a.rel_alpha_mean == null ? "—" : (a.rel_alpha_mean * 100).toFixed(0) + "%";
    $("arousal").textContent = a.arousal_mean == null ? "—" : (a.arousal_mean * 100).toFixed(0) + "%";
  }
  function handle(msg) {
    switch (msg.t) {
      case "snapshot":
        for (const p of msg.people) {
          const q = ensure(p);
          setProfile(q, p);
          if (p.last?.quality) setQuality(q, p.last.quality);
          if (p.last?.arousal) setArousal(q, p.last.arousal);
          if (p.last?.hr) setHr(q, p.last.hr);
          if (p.last?.bands) drawBands(q, p.last.bands);
          if (p.last?.checkin) setCheckin(q, p.last.checkin);
        }
        break;
      case "join": case "presence": ensure(msg); break;
      case "profile": setProfile(ensure(msg), msg); break;
      case "checkin": setCheckin(ensure(msg), msg); if (msg.publish) loadCheckins(); break;
      case "checkins_changed": loadCheckins(); break;
      case "leave": remove(msg.pseudonym); break;
      case "aggregate": aggregate(msg); break;
      case "quality": setQuality(ensure(msg), msg); break;
      case "arousal": setArousal(ensure(msg), msg); break;
      case "hr": setHr(ensure(msg), msg); break;
      case "bands": drawBands(ensure(msg), msg); break;
      case "eeg": drawRaw(ensure(msg), msg); break;
    }
  }
  function relayUrl() {
    const q = new URLSearchParams(location.search).get("relay");
    try {
      if (q) { localStorage.setItem("collective.relay", q); return q; }
      return localStorage.getItem("collective.relay") || "";
    } catch { return q || ""; }
  }
  // when the relay itself serves this page, its sockets live on the same origin
  async function sameOriginRelay() {
    if (!/^https?:$/.test(location.protocol)) return "";
    try {
      const r = await fetch("stats", { cache: "no-store" });
      if (!r.ok) return "";
      const j = await r.json();
      if (typeof j.people !== "number") return "";
      return location.origin.replace(/^http/, "ws") + location.pathname.replace(/[^/]*$/, "") + "live";
    } catch { return ""; }
  }
  async function connect() {
    let url = relayUrl();
    if (!url) url = await sameOriginRelay();
    if (!url) { linkEl.textContent = "no relay configured on this page yet."; return; }
    let ws;
    try { ws = new WebSocket(url); } catch { linkEl.textContent = "relay address invalid."; return; }
    linkEl.textContent = "connecting to the relay…";
    ws.onopen = () => { linkEl.textContent = "live"; };
    ws.onmessage = ev => { try { handle(JSON.parse(ev.data)); } catch {} };
    ws.onclose = () => { linkEl.textContent = "relay offline; retrying…"; for (const k of [...people.keys()]) remove(k); setTimeout(connect, 5000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connect();

  // ---------------- check-ins people chose to publish ----------------
  // From the relay when it serves this page (or is configured), else from
  // data/checkins.json exported at deploy time.
  async function loadCheckins() {
    const rows = $("checkin-rows"), note = $("checkin-note");
    if (!rows) return;
    let list = null, source = "";
    const relay = relayUrl();
    const bases = [];
    if (/^https?:$/.test(location.protocol)) bases.push("checkins");
    if (relay) bases.push(relay.replace(/^ws/, "http").replace(/\/live\/?$/, "/checkins"));
    for (const b of bases) {
      try {
        const r = await fetch(b, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j.checkins)) { list = j.checkins; source = j.storage ? "relay" : "relay (no store)"; break; }
      } catch {}
    }
    if (!list) {
      try {
        const r = await fetch("data/checkins.json", { cache: "no-store" });
        if (r.ok) { const j = await r.json(); list = Array.isArray(j) ? j : (j.checkins || []); source = "last export"; }
      } catch {}
    }
    if (!list) { note.textContent = "no check-ins available on this page yet."; return; }
    rows.innerHTML = "";
    for (const c of list) {
      const tr = document.createElement("tr");
      const r = c.self_rating || {};
      const when = c.date || (c.ts ? new Date(c.ts).toISOString().slice(0, 10) : "");
      const cells = [
        when,
        c.name || c.pseudonym || "",
        c.activity || "",
        r.arousal ? `${r.arousal}/9 · ${r.valence}/9${r.word ? ` “${r.word}”` : ""}` : "—",
        c.sleep_hours != null ? `${c.sleep_hours} h` : "—",
        c.caffeine || "—",
        c.estimate_median != null ? `${Math.round(c.estimate_median * 100)}%` : "no claim",
        c.usable_fraction != null ? `${Math.round(c.usable_fraction * 100)}%` : "—",
        c.hr_bpm_mean != null ? `${Math.round(c.hr_bpm_mean)} bpm` : "—",
      ];
      for (const v of cells) { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); }
      rows.appendChild(tr);
    }
    note.textContent = list.length
      ? `${list.length} published check-in${list.length === 1 ? "" : "s"} · ${source}. A check-in is the person's own rating and numbers; the resting estimate is the median over usable windows of a 3-minute eyes-open baseline.`
      : "Nobody has published a check-in yet.";
  }
  loadCheckins();

  // ---------------- the record: past recordings ----------------
  const fmtDate = s => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
  const monthKey = s => s.slice(0, 7);
  let projects = [], sessions = [];
  function projectOf(dateIso) {
    const d = (dateIso || "").slice(0, 10);
    for (const p of projects) { if (p.stamps && p.stamps.includes(d)) return p; }
    for (const p of projects) { if (d >= p.from && d <= p.to) return p; }
    return null;
  }
  // a session from the lab's shared folders is tagged by its folder; the phone's by date
  function projectFor(s) {
    if (s.project_folder) {
      let p = projects.find(x => x.id === "folder:" + s.project_folder);
      if (!p) { p = { id: "folder:" + s.project_folder, name: s.project_folder, folder: true, from: "", to: "", summary: "A shared folder of the lab's recordings, catalogued as found; participant names replaced by pseudonyms.", links: [] }; projects.push(p); }
      return p;
    }
    return projectOf(s.date);
  }
  function cleanFrac(dev) {
    const v = Object.values(dev.clean_epoch_frac || {});
    return v.length ? Math.max(...v) : null;
  }
  function render() {
    const fp = $("f-project").value, fm = $("f-month").value, fu = $("f-usable").checked;
    const rows = $("rows"); rows.innerHTML = "";
    let shown = 0;
    for (const s of sessions.slice().reverse()) {
      const devs = s.devices.filter(d => d.kind !== "events");
      const usable = devs.some(d => d.usable);
      if (fu && !usable) continue;
      const p = projectFor(s);
      if (fp && (!p || p.id !== fp)) continue;
      if (fm && monthKey(s.date) !== fm) continue;
      shown++;
      const best = devs.filter(d => d.usable).sort((a, b) => (cleanFrac(b) ?? -1) - (cleanFrac(a) ?? -1))[0];
      const cf = best ? cleanFrac(best) : null;
      const pulse = devs.map(d => d.pulse).find(x => x && x.valid >= 2);
      const tr = document.createElement("tr"); tr.className = "row";
      tr.innerHTML = `<td>${fmtDate(s.date)}</td><td>${p ? p.name : "<span class='status'>untagged</span>"}</td>
        <td>${s.minutes}</td><td>${devs.map(d => d.tag).join(", ")}${best && !best.hsi_streamed ? "<span class='badge'>no contact field</span>" : ""}</td>
        <td>${cf == null ? "—" : `<span class="q"><i style="width:${Math.round(cf * 100)}%"></i></span> ${Math.round(cf * 100)}%`}</td>
        <td>${pulse ? `${Math.round(pulse.bpm_mean)} bpm` : "—"}</td>`;
      tr.onclick = () => toggleDetail(tr, s, devs);
      rows.appendChild(tr);
    }
    $("count").textContent = `${shown} sessions shown`;
  }
  function toggleDetail(tr, s, devs) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("detail")) { next.remove(); return; }
    const d = document.createElement("tr"); d.className = "detail";
    const td = document.createElement("td"); td.colSpan = 6;
    td.innerHTML = devs.map(dev => {
      if (!dev.usable) return `<div><b>${dev.tag}</b>: ${dev.error ? "could not be read" : "too short to summarise"} (${(dev.size / 1e6).toFixed(1)} MB)</div>`;
      const kv = [];
      kv.push(["duration", `${(dev.duration_s / 60).toFixed(1)} min at ${dev.fs_est ? dev.fs_est.toFixed(0) : "?"} Hz`]);
      kv.push(["raw rms (µV)", CH.map(c => dev.raw_rms_uv?.[c] != null ? `${c} ${Math.round(dev.raw_rms_uv[c])}` : "").filter(Boolean).join(" · ")]);
      kv.push(["clean epochs", CH.map(c => dev.clean_epoch_frac?.[c] != null ? `${c} ${Math.round(dev.clean_epoch_frac[c] * 100)}%` : "").filter(Boolean).join(" · ")]);
      if (dev.hsi_streamed) kv.push(["contact (good share)", CH.map(c => dev.hsi?.[c]?.["1"] != null ? `${c} ${Math.round(dev.hsi[c]["1"] * 100)}%` : "").filter(Boolean).join(" · ")]);
      else kv.push(["contact field", "not streamed by this app version; amplitude gate only"]);
      if (dev.bands_median) kv.push(["band medians (log10, best channel)", BANDS.map(b => { const o = dev.bands_median[b]; if (!o) return ""; const v = Math.max(...Object.values(o)); return `${b} ${v.toFixed(2)}`; }).filter(Boolean).join(" · ")]);
      if (dev.pulse) kv.push(["pulse", `${dev.pulse.bpm_mean.toFixed(0)} ± ${(dev.pulse.bpm_sd ?? 0).toFixed(0)} bpm on ${dev.pulse.valid}/${dev.pulse.windows} windows (${dev.pulse.channel})`]);
      if (dev.gyro_rms != null) kv.push(["head rotation (gyro rms)", dev.gyro_rms.toFixed(0)]);
      if (dev.battery) kv.push(["battery", `${dev.battery[0]}% → ${dev.battery[1]}%`]);
      const prev = dev.preview ? `<img class="preview" src="data/previews/${dev.preview}" alt="band powers and clean-epoch mask over time">` : "";
      return `<div style="margin:6px 0 12px"><b>${dev.tag}</b> <span class="status">${dev.file}</span><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-top:6px">${prev}<div class="kv">${kv.map(([k, v]) => `<div><b>${k}</b><br>${v}</div>`).join("")}</div></div></div>`;
    }).join("") + (s.manifest ? `<div class="status">manifest: participant ${s.manifest.participant ?? "—"}, consent ${s.manifest.consent ?? "—"}${s.events != null ? `, ${s.events} events` : ""}</div>` : "");
    d.appendChild(td);
    tr.after(d);
  }
  function months(list) {
    const counts = new Map();
    for (const s of list) { const k = monthKey(s.date); counts.set(k, (counts.get(k) || 0) + s.minutes); }
    const keys = [...counts.keys()].sort();
    const max = Math.max(...counts.values(), 1);
    $("months").innerHTML = keys.map(k => `<div style="height:${Math.max(3, counts.get(k) / max * 100)}%" data-label="${k}: ${(counts.get(k) / 60).toFixed(1)} h"></div>`).join("");
    $("months-x").innerHTML = `<span>${keys[0] || ""}</span><span>recording hours per month</span><span>${keys[keys.length - 1] || ""}</span>`;
    const fm = $("f-month");
    for (const k of keys) { const o = document.createElement("option"); o.value = k; o.textContent = k; fm.appendChild(o); }
  }
  function totals(list) {
    const devFiles = list.reduce((n, s) => n + s.devices.filter(d => d.kind !== "events").length, 0);
    const minutes = list.reduce((n, s) => n + s.minutes, 0);
    const usable = list.filter(s => s.devices.some(d => d.usable)).length;
    const withPulse = list.filter(s => s.devices.some(d => d.pulse && d.pulse.valid >= 2)).length;
    const first = list[0]?.date?.slice(0, 10) || "—", last = list[list.length - 1]?.date?.slice(0, 10) || "—";
    $("totals").innerHTML = [
      [list.length, "recording sessions"], [devFiles, "headband files"], [(minutes / 60).toFixed(1), "hours recorded"],
      [usable, "sessions with usable EEG"], [withPulse, "sessions with a pulse"], [`${first} → ${last}`, "first to last"]
    ].map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join("");
  }
  function renderProjects(list) {
    const fp = $("f-project");
    for (const s of list) projectFor(s);          // registers the folder projects
    $("projects-list").innerHTML = projects.map(p => {
      const n = list.filter(s => projectFor(s)?.id === p.id);
      const mins = n.reduce((a, s) => a + s.minutes, 0);
      const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; fp.appendChild(o);
      const links = (p.links || []).filter(l => l[1]).map(l => `<a href="${l[1]}">${l[0]}</a>`).join(" · ");
      const when = p.folder ? (n.length ? `${n.map(s => s.date.slice(0, 10)).sort()[0]} to ${n.map(s => s.date.slice(0, 10)).sort().slice(-1)[0]}` : "") : `${p.from} to ${p.to}`;
      return `<div class="card project"><h3>${p.name}</h3><div class="when">${when}</div><p>${p.summary}</p><div class="n">${n.length} sessions, ${(mins / 60).toFixed(1)} h${links ? " · " + links : ""}</div></div>`;
    }).join("");
  }
  async function load() {
    try {
      const [idx, pj] = await Promise.all([fetch("data/index.json").then(r => r.json()), fetch("projects.json").then(r => r.json())]);
      projects = pj.projects || []; sessions = idx.sessions || [];
      totals(sessions); months(sessions); renderProjects(sessions); render();
      $("built").textContent = `Catalogue built ${idx.built}. Sessions whose contact field was not streamed are judged by amplitude alone.`;
      for (const id of ["f-project", "f-month", "f-usable"]) $(id).onchange = render;
    } catch (e) {
      $("rows").innerHTML = `<tr><td colspan="6" class="status">The record is not loaded yet (${e.message}).</td></tr>`;
    }
  }
  load();
})();
