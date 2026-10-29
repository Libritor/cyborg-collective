(() => {
  "use strict";
  const CH = ["TP9", "AF7", "AF8", "TP10"];
  const BANDS = ["delta", "theta", "alpha", "beta", "gamma"];
  // the app's palettes: EEG channels blue/red/green/orange, bands
  // red/orange/green/blue/purple, axes X red / Y green / Z blue
  const EEG_COLORS = ["#2196f3", "#f44336", "#4caf50", "#ff9800"];
  const BAND_COLORS = ["#f44336", "#ff9800", "#4caf50", "#2196f3", "#9c27b0"];
  const XYZ_COLORS = ["#f44336", "#4caf50", "#2196f3"];
  const cssVar = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  function prepCanvas(cv, cssHeight) {
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth || 300;
    cv.width = Math.round(W * dpr); cv.height = Math.round(cssHeight * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, cssHeight);
    return { ctx, W, H: cssHeight };
  }
  // grid + axis labels the way the app's charts draw them
  function axes(ctx, W, H, { left, bottom, yMin, yMax, yUnit, seconds, yTicks = 4, xTicks = 5 }) {
    const grid = "rgba(128,128,128,0.2)", muted = cssVar("--muted") || "#888";
    ctx.font = "9px system-ui, sans-serif"; ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    const pw = W - left - 4, ph = H - bottom - 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = 4 + ph - ph * i / yTicks;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - 4, y); ctx.stroke();
      const v = yMin + (yMax - yMin) * i / yTicks;
      ctx.textAlign = "right"; ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2), left - 3, y + 3);
    }
    for (let i = 0; i <= xTicks; i++) {
      const x = left + pw * i / xTicks;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 4 + ph); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(`${(-seconds + seconds * i / xTicks).toFixed(0)}`, x, H - 1);
    }
    ctx.textAlign = "left"; ctx.fillText(yUnit, 2, 10);
    ctx.textAlign = "right"; ctx.fillText("s", W - 4, H - 1);
    return { x0: left, y0: 4, pw, ph };
  }
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
      <div class="mood" hidden><canvas class="moodgrid" width="54" height="54"></canvas><div class="moodside"><span class="moodchip"></span><span class="moodtext"></span></div></div>
      <div class="moodlog" hidden></div>
      <div class="facts"><span class="fact model"></span><span class="fact batt"></span><span class="fact since"></span><span class="fact auxq"></span></div>
      <svg class="horseshoe" viewBox="0 0 156 86" role="img" aria-label="contact quality per electrode">
        <path d="M 12 70 A 48 58 0 0 1 108 70" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="2"/>
        ${[["TP9", 12, 66], ["AF7", 38, 18], ["AF8", 82, 18], ["TP10", 108, 66]].map(([c, x, y]) =>
          `<g class="el" data-ch="${c}"><title>${c}: no data</title><circle cx="${x}" cy="${y}" r="8" fill="#9ca3af"/><text x="${x}" y="${y + 20}" text-anchor="middle">${c}</text></g>`).join("")}
        <g class="el aux" data-ch="AUX" hidden><title>aux electrode (derived)</title><circle cx="140" cy="42" r="8" fill="#9ca3af"/><text x="140" y="62" text-anchor="middle">AUX</text></g>
      </svg>
      <div class="est"><b>—</b><small></small></div>
      <div class="reason"></div>
      <div class="hr"></div>
      <div class="checkin" hidden></div>
      <div class="chart-title raw-title" hidden>EEG raw · last 10 s · µV
        <span class="legend">${CH.map((c, i) => `<i style="background:${EEG_COLORS[i]}"></i>${c}`).join("")}</span></div>
      <canvas class="raw" height="150" hidden></canvas>
      <div class="chart-title bands-title" hidden>Band powers · relative · mean of channels in contact</div>
      <canvas class="bands" height="96" hidden></canvas>
      <table class="bandtable" hidden><thead><tr><th>rel. power</th>${CH.map(c => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>${BANDS.map(b => `<tr data-band="${b}"><td>${b}</td>${CH.map(() => "<td>—</td>").join("")}</tr>`).join("")}</tbody></table>
      <div class="chart-title imu-title" hidden>Motion</div>
      <div class="imu" hidden></div>
      <div class="chart-title optics-title" hidden>Optics · last 20 s
        <span class="legend"><i style="background:#ef5350"></i>730 nm<i style="background:#42a5f5"></i>850 nm</span></div>
      <canvas class="optics-chart" height="90" hidden></canvas>
      <div class="optics" hidden></div>`;
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
      const col = moodColor(m.mood.arousal, m.mood.valence);
      drawMood(mood.querySelector("canvas"), m.mood.arousal, m.mood.valence, col);
      const chip = mood.querySelector(".moodchip");
      chip.textContent = m.mood.phrase || moodPhrase(m.mood.arousal, m.mood.valence);
      chip.style.background = col; chip.style.color = moodInk(m.mood.arousal);
      mood.querySelector(".moodtext").textContent =
        `self-rated · ${m.mood.valence}/9 pleasant · ${m.mood.arousal}/9 awake${m.mood.word ? ` · “${m.mood.word}”` : ""}`;
    } else mood.hidden = true;
    if (Array.isArray(m.mood_history)) setMoodLog(p, m.mood_history);
  }
  // words and colour for a grid position: valence (how pleasant) sets the hue
  // red → green, arousal (how awake) sets the brightness dim → bright
  const valenceWord = v => v <= 2 ? "rough" : v <= 4 ? "low" : v === 5 ? "okay" : v <= 7 ? "good" : "great";
  const arousalWord = a => a <= 2 ? "sleepy" : a <= 4 ? "foggy" : a === 5 ? "steady" : a <= 7 ? "alert" : "wired";
  const moodPhrase = (a, v) => `feeling ${valenceWord(v)} and ${arousalWord(a)}`;
  const moodColor = (a, v) => `hsl(${Math.round((v - 1) / 8 * 130)} 65% ${Math.round(30 + (a - 1) / 8 * 25)}%)`;
  const moodInk = a => (a >= 6 ? "#111" : "#fff");
  function drawMood(cv, arousal, valence, col) {
    const s = cv.width, ctx = cv.getContext("2d"), cell = s / 9;
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--line") || "#ccc";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 9; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell + 0.5, 0); ctx.lineTo(i * cell + 0.5, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell + 0.5); ctx.lineTo(s, i * cell + 0.5); ctx.stroke();
    }
    ctx.fillStyle = col || "#4f46e5";
    ctx.fillRect((valence - 1) * cell + 1, (9 - arousal) * cell + 1, cell - 1, cell - 1);
  }
  // every mood the person stated during this share, as coloured chips with the time
  function setMoodLog(p, history) {
    const el = p.el.querySelector(".moodlog");
    if (!history || history.length < 2) { el.hidden = true; return; }
    el.hidden = false; el.innerHTML = "";
    const lab = document.createElement("span"); lab.className = "moodlog-label"; lab.textContent = "mood log:"; el.appendChild(lab);
    for (const h of history.slice(-12)) {
      const c = document.createElement("span");
      c.className = "moodlog-chip";
      c.style.background = moodColor(h.arousal, h.valence); c.style.color = moodInk(h.arousal);
      const t = h.ts ? new Date(h.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      c.textContent = `${t} ${h.phrase || moodPhrase(h.arousal, h.valence)}${h.word ? ` “${h.word}”` : ""}`;
      el.appendChild(c);
    }
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
  // the horseshoe: the app's contact indicator, same colours (good / ok / poor)
  const hsiColor = v => (v === 1 ? "#16a34a" : v === 2 ? "#d97706" : v == null ? "#9ca3af" : "#dc2626");
  const hsiWord = v => (v === 1 ? "good" : v === 2 ? "ok" : v == null ? "no data" : "poor");
  function setQuality(p, q) {
    for (const c of CH) {
      const g = p.el.querySelector(`.horseshoe .el[data-ch="${c}"]`);
      const v = q.hsi ? q.hsi[c] : undefined;
      g.querySelector("circle").setAttribute("fill", hsiColor(v));
      g.querySelector("title").textContent = `${c}: ${hsiWord(v)}`;
    }
  }
  function setAux(p, aux) {
    const g = p.el.querySelector(".horseshoe .el.aux");
    const a = (aux || [])[0];
    // SVG elements have no `hidden` property; toggle the attribute itself
    if (!a) { g.setAttribute("hidden", ""); return; }
    g.removeAttribute("hidden");
    g.querySelector("circle").setAttribute("fill", hsiColor(a.hsi));
    g.querySelector("text").textContent = a.channel === "AUX_L" ? "AUX L" : "AUX R";
    g.querySelector("title").textContent = `${a.channel}: ${hsiWord(a.hsi)} (derived from the signal, ${Math.round(a.std_uv)} µV)`;
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
      ? `♥ ${Math.round(h.bpm)} bpm · RMSSD ${Math.round(h.rmssd_ms)} ms · SDNN ${Math.round(h.sdnn_ms)} ms · ${h.beats} beats/10 s · from ${h.source}`
      : `♥ detecting beats (${h.beats} found in 10 s, need 6) · from ${h.source}`;
  }
  function fmtSince(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  }
  // facts about the kit: model, battery, how long the window has been open,
  // and the aux electrode's signal-derived quality when one is plugged in
  function setDevice(p, d) {
    p.device = d;
    const el = p.el;
    el.querySelector(".fact.model").textContent = d.model ? d.model : "";
    el.querySelector(".fact.batt").textContent = d.battery == null ? "" : `battery ${d.battery}%`;
    el.querySelector(".fact.since").textContent = d.since ? `sharing for ${fmtSince(d.since)}` : "";
    const aux = (d.aux || []).map(a => `${a.channel === "AUX_L" ? "AUX L" : "AUX R"} ${a.hsi === 1 ? "good" : a.hsi === 2 ? "ok" : "poor"} (derived, ${Math.round(a.std_uv)} µV)`);
    el.querySelector(".fact.auxq").textContent = aux.join(" · ");
    setAux(p, d.aux);
  }
  setInterval(() => { for (const p of people.values()) if (p.device?.since) p.el.querySelector(".fact.since").textContent = `sharing for ${fmtSince(p.device.since)}`; }, 15000);
  // motion as the app shows it: a tile per axis, X red / Y green / Z blue
  function setImu(p, m) {
    const el = p.el.querySelector(".imu"); el.hidden = false;
    p.el.querySelector(".imu-title").hidden = false;
    if (!el.firstChild) {
      el.innerHTML = ["gyro", "accel"].map(k => `<div class="imu-row"><span class="imu-label">${k === "gyro" ? "gyroscope °/s" : "accelerometer g"}</span>${["X", "Y", "Z"].map((ax, i) =>
        `<span class="tile-v" data-k="${k}${i}" style="border-color:${XYZ_COLORS[i]};color:${XYZ_COLORS[i]}"><b>${ax}</b> <span>—</span></span>`).join("")}</div>`).join("");
    }
    const f = v => (v == null ? "—" : ((v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2)));
    (m.gyro || []).forEach((v, i) => { el.querySelector(`[data-k="gyro${i}"] span`).textContent = f(v); });
    (m.accel || []).forEach((v, i) => { el.querySelector(`[data-k="accel${i}"] span`).textContent = f(v); });
  }
  // optics as the app's fNIRS chart: 730 nm red and 850 nm blue over 20 s
  // (mean of the sites that report), plus the per-site 850/730 ratios
  function setOptics(p, o) {
    const el = p.el.querySelector(".optics"); el.hidden = false;
    p.el.querySelector(".optics-title").hidden = false;
    const parts = [];
    const r730 = [], r850 = [];
    if (o.sites) {
      const names = { left_outer: "L out", left_inner: "L in", right_inner: "R in", right_outer: "R out" };
      for (const [k, v] of Object.entries(o.sites)) {
        if (!v) continue;
        if (v.ratio != null) parts.push(`${names[k] || k} 850/730 ${v.ratio.toFixed(3)}`);
        if (Number.isFinite(v.r730)) r730.push(v.r730);
        if (Number.isFinite(v.r850)) r850.push(v.r850);
      }
    }
    if (o.ppg) {
      const pp = Object.entries(o.ppg).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Math.round(v)}`);
      if (pp.length) parts.push(`PPG ${pp.join(" · ")}`);
    }
    el.textContent = parts.length ? parts.join(" · ") : "no optical data on this model";
    if (!r730.length && !r850.length) return;
    p.opt = p.opt || [];
    const t = o.ts || Date.now();
    p.opt.push({ t, a: r730.length ? r730.reduce((x, y) => x + y, 0) / r730.length : null,
                 b: r850.length ? r850.reduce((x, y) => x + y, 0) / r850.length : null });
    p.opt = p.opt.filter(s => t - s.t <= 20000);
    const cv = p.el.querySelector("canvas.optics-chart"); cv.hidden = false;
    const { ctx, W, H } = prepCanvas(cv, 90);
    const vals = p.opt.flatMap(s => [s.a, s.b]).filter(Number.isFinite);
    if (vals.length < 2) return;
    let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1) { hi = lo + 1; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const ax = axes(ctx, W, H, { left: 44, bottom: 12, yMin: lo, yMax: hi, yUnit: "µA", seconds: 20, yTicks: 3, xTicks: 4 });
    for (const [key, col] of [["a", "#ef5350"], ["b", "#42a5f5"]]) {
      ctx.beginPath(); ctx.strokeStyle = col; ctx.lineWidth = 1.5; let started = false;
      for (const s of p.opt) {
        if (!Number.isFinite(s[key])) continue;
        const x = ax.x0 + ax.pw * (1 - (t - s.t) / 20000), y = ax.y0 + ax.ph * (1 - (s[key] - lo) / (hi - lo));
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
      }
      ctx.stroke();
    }
  }
  // band powers as the app's bar chart: one bar per band in the app's
  // colours, mean over the channels in contact, with the per-channel table
  function drawBands(p, b) {
    const cv = p.el.querySelector("canvas.bands"); cv.hidden = false;
    p.el.querySelector(".bands-title").hidden = false;
    const { ctx, W, H } = prepCanvas(cv, 96);
    const table = p.el.querySelector("table.bandtable"); table.hidden = false;
    const left = 30, bottom = 14, pw = W - left - 4, ph = H - bottom - 6;
    const yMax = 0.6;
    ctx.font = "9px system-ui, sans-serif"; ctx.strokeStyle = "rgba(128,128,128,0.2)"; ctx.fillStyle = cssVar("--muted") || "#888";
    for (let i = 0; i <= 3; i++) {
      const y = 6 + ph - ph * i / 3;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - 4, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(`${Math.round(yMax * 100 * i / 3)}%`, left - 3, y + 3);
    }
    const gw = pw / BANDS.length;
    BANDS.forEach((name, i) => {
      const vals = b.rel[name] || [];
      const nums = vals.filter(Number.isFinite); // null = channel without contact
      const mean = nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : 0;
      const row = table.querySelector(`tr[data-band="${name}"]`);
      if (row) {
        const abs = (b.abs && b.abs[name]) || [];
        CH.forEach((_, k) => {
          const td = row.children[k + 1];
          td.textContent = Number.isFinite(vals[k]) ? `${Math.round(vals[k] * 100)}%` : "—";
          td.title = Number.isFinite(abs[k]) ? `absolute ${abs[k].toFixed(3)} (log10 µV²)` : "no contact";
        });
      }
      const h = Math.max(2, Math.min(1, mean / yMax) * ph);
      const x = left + i * gw + gw * 0.2;
      ctx.fillStyle = BAND_COLORS[i];
      ctx.beginPath(); ctx.roundRect(x, 6 + ph - h, gw * 0.6, h, 3); ctx.fill();
      ctx.fillStyle = cssVar("--ink") || "#333"; ctx.textAlign = "center";
      ctx.fillText(`${(mean * 100).toFixed(0)}%`, x + gw * 0.3, 6 + ph - h - 3);
      ctx.fillStyle = cssVar("--muted") || "#888";
      ctx.fillText(name, x + gw * 0.3, H - 2);
    });
  }
  // raw EEG as the app's chart: the four channels overlaid in their colours
  // on one autoscaled µV axis, last 10 s
  function drawRaw(p, e) {
    const cv = p.el.querySelector("canvas.raw"); cv.hidden = false;
    p.el.querySelector(".raw-title").hidden = false;
    const maxLen = 256 * 10;
    e.x.forEach((arr, i) => { p.raw[i].push(...arr); if (p.raw[i].length > maxLen) p.raw[i].splice(0, p.raw[i].length - maxLen); });
    const { ctx, W, H } = prepCanvas(cv, 150);
    const all = p.raw.flat().filter(Number.isFinite);
    if (all.length < 2) return;
    // scale on the middle 98 % so one blink does not flatten everything
    const sorted = all.slice().sort((a, b) => a - b);
    let lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.ceil(sorted.length * 0.99) - 1];
    if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = mid - 10; hi = mid + 10; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const ax = axes(ctx, W, H, { left: 36, bottom: 12, yMin: lo, yMax: hi, yUnit: "µV", seconds: 10, yTicks: 4, xTicks: 5 });
    p.raw.forEach((arr, i) => {
      if (arr.length < 2) return;
      ctx.beginPath(); ctx.strokeStyle = EEG_COLORS[i]; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
      const n = arr.length, offset = maxLen - n;
      for (let k = 0; k < n; k++) {
        const v = arr[k]; if (!Number.isFinite(v)) continue;
        const x = ax.x0 + ax.pw * (offset + k) / maxLen, y = ax.y0 + ax.ph * (1 - (v - lo) / (hi - lo));
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    });
  }
  function aggregate(a) {
    // the relay served this page with a stamp of its script and stylesheet;
    // when the relay reports a different one, the page has changed: reload
    if (window.ASSET_V && a.asset_v && a.asset_v !== window.ASSET_V) { location.reload(); return; }
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
          if (p.last?.device) setDevice(q, p.last.device);
          if (p.last?.quality) setQuality(q, p.last.quality);
          if (p.last?.arousal) setArousal(q, p.last.arousal);
          if (p.last?.hr) setHr(q, p.last.hr);
          if (p.last?.bands) drawBands(q, p.last.bands);
          if (p.last?.imu) setImu(q, p.last.imu);
          if (p.last?.optics) setOptics(q, p.last.optics);
          if (p.last?.checkin) setCheckin(q, p.last.checkin);
        }
        break;
      case "join": case "presence": ensure(msg); break;
      case "profile": setProfile(ensure(msg), msg); break;
      case "device": setDevice(ensure(msg), msg); break;
      case "imu": setImu(ensure(msg), msg); break;
      case "optics": setOptics(ensure(msg), msg); break;
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
