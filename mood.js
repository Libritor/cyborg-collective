// The room-mood wall: polls the relay's GET /mood every 5 s and draws the
// counts. Nothing here identifies anyone; the relay publishes counts only
// once MOOD_K people are in the room (or a cell).
(() => {
  const $ = id => document.getElementById(id);
  const DEFAULT_RELAY = "https://cyborg-collective-relay.onrender.com";

  // ?relay=https://host[:port] (remembered), else the origin that served
  // this page when it is the relay, else the Collective's own relay.
  function relayBase() {
    const q = new URLSearchParams(location.search).get("relay");
    try {
      if (q) { localStorage.setItem("collective.relay.http", q); return q; }
      const saved = localStorage.getItem("collective.relay.http") || "";
      if (saved && location.protocol === "https:" && /^http:/.test(saved)) { localStorage.removeItem("collective.relay.http"); return ""; }
      return saved;
    } catch { return q || ""; }
  }
  let base = (relayBase() || "").replace(/\/+$/, "");
  let sameOriginTried = false;

  async function resolveBase() {
    if (base) return base;
    if (!sameOriginTried && /^https?:$/.test(location.protocol)) {
      sameOriginTried = true;
      try {
        const r = await fetch("stats", { cache: "no-store" });
        if (r.ok && typeof (await r.json()).people === "number") {
          base = location.origin + location.pathname.replace(/[^/]*$/, "").replace(/\/$/, "");
          return base;
        }
      } catch {}
    }
    base = DEFAULT_RELAY;
    return base;
  }

  const WORDS = { calm: "calm", activated: "activated", strained: "strained", unknown: "unknown" };
  function dominant(room) {
    const n = room.calm + room.activated + room.strained;
    if (!n) return "unknown";
    let best = "calm";
    for (const k of ["activated", "strained"]) if (room[k] > room[best]) best = k;
    return best;
  }

  function pct(a, n) { return n ? Math.round(100 * a / n) : 0; }

  function render(d) {
    const room = d.room || {};
    const n = room.n || 0;
    $("k").textContent = d.k || "a few";
    $("n").textContent = n;
    $("located").textContent = d.located || 0;
    for (const k of ["calm", "activated", "strained", "good"]) {
      $(k).textContent = room[k] || 0;
      $(k + "-i").style.setProperty("--w", pct(room[k] || 0, n) + "%");
    }
    $("company").textContent = room.company || 0;
    const word = $("word");
    if (room.hidden) {
      word.className = "word hidden";
      word.textContent = n ? `${n} counted` : "—";
      $("shift").textContent = n ? `the room shows once ${d.k} people are counted` : "waiting for the first votes";
    } else {
      const dom = dominant(room);
      word.className = "word " + dom;
      word.textContent = n ? `mostly ${WORDS[dom]}` : "—";
      $("shift").textContent = shiftText(d.history || [], room);
    }
    drawChart(d.history || []);
    const cells = $("cells");
    cells.innerHTML = "";
    for (const c of d.cells || []) {
      const el = document.createElement("div");
      el.className = "cell";
      el.textContent = `near ${c.cell}: ${c.n} counted, ${pct(c.strained, c.n)}% strained, ${pct(c.calm, c.n)}% calm`;
      cells.appendChild(el);
    }
  }

  // "calmer than 15 min ago": compare the strained share now with the
  // minute 15 back, over rows that were shown
  function shiftText(hist, room) {
    const shown = hist.filter(h => !h.hidden && h.n > 0);
    if (shown.length < 2) return "just started counting";
    const now = shown[shown.length - 1];
    const back = shown.find(h => h.ts >= now.ts - 15 * 60000) || shown[0];
    if (back === now) return "steady";
    const s0 = back.strained / back.n, s1 = now.strained / now.n;
    const c0 = back.calm / back.n, c1 = now.calm / now.n;
    const mins = Math.max(1, Math.round((now.ts - back.ts) / 60000));
    if (s1 - s0 > 0.1) return `more strained than ${mins} min ago`;
    if (c1 - c0 > 0.1) return `calmer than ${mins} min ago`;
    if ((now.good / now.n) - (back.good / back.n) > 0.1) return `more people feeling good than ${mins} min ago`;
    return `about the same as ${mins} min ago`;
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawChart(hist) {
    const cv = $("chart");
    const W = cv.clientWidth || 800, H = cv.height;
    if (cv.width !== W) cv.width = W;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    const rows = hist.slice(-240);
    if (!rows.length) return;
    const t1 = rows[rows.length - 1].ts, t0 = t1 - 240 * 60000;
    const x = ts => (ts - t0) / (t1 - t0 + 60000) * W;
    const colW = Math.max(2, W / 241);
    const colors = { calm: cssVar("--calm"), activated: cssVar("--activated"), strained: cssVar("--strained"), unknown: cssVar("--unknown") };
    const pad = 20;
    for (const r of rows) {
      if (r.hidden || !r.n) continue;
      let y = H - pad;
      for (const k of ["calm", "activated", "strained", "unknown"]) {
        const h = (r[k] / r.n) * (H - 2 * pad);
        ctx.fillStyle = colors[k];
        ctx.fillRect(x(r.ts), y - h, colW, h);
        y -= h;
      }
    }
    // the share feeling good, as a line
    ctx.strokeStyle = cssVar("--goodc"); ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    for (const r of rows) {
      if (r.hidden || !r.n) { started = false; continue; }
      const y = H - pad - (r.good / r.n) * (H - 2 * pad);
      if (!started) { ctx.moveTo(x(r.ts) + colW / 2, y); started = true; } else ctx.lineTo(x(r.ts) + colW / 2, y);
    }
    ctx.stroke();
    // time marks every hour
    ctx.fillStyle = cssVar("--muted"); ctx.font = "12px system-ui, sans-serif";
    for (let t = Math.ceil(t0 / 3600000) * 3600000; t <= t1; t += 3600000) {
      const d = new Date(t);
      ctx.fillText(d.toTimeString().slice(0, 5), x(t), H - 4);
    }
  }

  async function poll() {
    const b = await resolveBase();
    try {
      const r = await fetch(b + "/mood", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      render(await r.json());
      $("link").textContent = "live";
    } catch (e) {
      $("link").textContent = "relay unreachable; retrying";
      if (b === base && base !== DEFAULT_RELAY && !relayBase()) base = "";
    }
    setTimeout(poll, 5000);
  }
  window.addEventListener("resize", () => poll());
  poll();
})();
