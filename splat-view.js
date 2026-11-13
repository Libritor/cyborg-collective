// A live cloud of splats, drawn in the browser.
//
// A headset gateway sends "splat" chunks through the relay: coloured blobs seeded from the headset's depth sensing
// and its camera's colour, each with a position, a radius and a facing. This file keeps them (one per 2 cm cell of
// space, so a place seen again is refined instead of piling up) and draws them as soft round blobs, far ones first,
// from a camera that circles the scene until the visitor takes hold of it. Nothing is trained here or anywhere:
// these are splats laid down straight from depth, not an optimised Gaussian-splat scene.
//
// A chunk (see collective/relay.py and questbag/quest_splat.py):
//   { n, q, origin: [x, y, z], d: base64 of n x 12 bytes, cam: [x, y, z, qx, qy, qz, qw], total }
//   12 bytes = int16 x, y, z (steps of q metres from origin) | r g b | radius in 2.5 mm | facing (two int8, octahedral)
// Space is the headset's world turned to x forward, y left, z up, in metres.
// A blob whose surface faces away from the visitor's camera is not drawn, so a room can be looked into from outside:
// the wall and ceiling nearest the camera drop away, as in a doll's house.
//
//   const view = SplatView.create(element);   view.add(chunk);   view.count();   view.destroy();
(function () {
  "use strict";
  const MAX = 300000;        // splats held; beyond this the oldest cells are overwritten
  const CELL = 0.02;         // metres
  const VS = `
    attribute vec3 a_pos; attribute vec4 a_col; attribute float a_rad; attribute vec3 a_nrm;
    uniform mat4 u_view, u_proj; uniform float u_px; uniform vec3 u_eye;
    varying vec4 v_col;
    void main() {
      float facing = dot(normalize(a_nrm), normalize(u_eye - a_pos));
      if (facing < -0.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec4(0.0); return; }   // seen from behind: left out
      vec4 v = u_view * vec4(a_pos, 1.0);
      gl_Position = u_proj * v;
      gl_PointSize = clamp(2.8 * a_rad * u_px / max(0.05, -v.z), 1.5, 56.0);
      v_col = vec4(a_col.rgb * (0.72 + 0.28 * clamp(facing, 0.0, 1.0)), a_col.a);       // a little darker edge-on, so shape reads
    }`;
  const FS = `
    precision mediump float;
    varying vec4 v_col;
    void main() {
      vec2 d = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(d, d);
      if (r2 > 1.0) discard;
      float a = exp(-2.6 * r2) * v_col.a;        // a Gaussian falling off from the middle of the blob
      gl_FragColor = vec4(v_col.rgb * a, a);
    }`;

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(eye, target) {          // z is up
    let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let sx = fy * 1 - fz * 0, sy = fz * 0 - fx * 1, sz = 0;          // forward x up(0,0,1)
    const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl;
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    return new Float32Array([sx, ux, -fx, 0, sy, uy, -fy, 0, sz, uz, -fz, 0,
      -(sx * eye[0] + sy * eye[1] + sz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1]);
  }

  function create(host) {
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Live splats from the headset: drag to turn, scroll to zoom after clicking");
    host.appendChild(canvas);
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    const wide = gl && gl.getExtension("OES_element_index_uint");
    const state = { count: 0, total: 0, chunks: 0, last: 0, ok: !!(gl && wide) };
    if (!gl || !wide) {
      host.textContent = "This browser cannot draw the splats (it needs WebGL).";
      return { add() {}, count: () => 0, destroy() {}, state };
    }

    const pos = new Float32Array(MAX * 3), col = new Uint8Array(MAX * 4), rad = new Float32Array(MAX), nrm = new Int8Array(MAX * 3);
    const order = new Uint32Array(MAX), depth = new Float32Array(MAX), keys = new Float64Array(MAX);
    const index = new Map();
    let n = 0, next = 0, dirty = true, sortedFor = "";
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let headset = null;

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog); gl.useProgram(prog);
    const loc = { pos: gl.getAttribLocation(prog, "a_pos"), col: gl.getAttribLocation(prog, "a_col"), rad: gl.getAttribLocation(prog, "a_rad"),
      nrm: gl.getAttribLocation(prog, "a_nrm"), eye: gl.getUniformLocation(prog, "u_eye"),
      view: gl.getUniformLocation(prog, "u_view"), proj: gl.getUniformLocation(prog, "u_proj"), px: gl.getUniformLocation(prog, "u_px") };
    const bufPos = gl.createBuffer(), bufCol = gl.createBuffer(), bufRad = gl.createBuffer(), bufNrm = gl.createBuffer(), bufIdx = gl.createBuffer();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.043, 0.055, 0.078, 1);

    // the visitor's camera: circling by itself until taken hold of
    const cam = { yaw: -2.2, pitch: 0.55, dist: 0, held: false, auto: true, fitted: false };
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; cam.auto = false; canvas.setPointerCapture(e.pointerId); canvas.focus({ preventScroll: true }); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      cam.yaw -= (e.clientX - drag[0]) * 0.008; cam.pitch = Math.min(1.5, Math.max(-0.3, cam.pitch + (e.clientY - drag[1]) * 0.006));
      drag = [e.clientX, e.clientY]; sortedFor = "";
    });
    const drop = () => { drag = null; };
    canvas.addEventListener("pointerup", drop); canvas.addEventListener("pointercancel", drop);
    canvas.addEventListener("wheel", (e) => {          // only once the visitor has clicked into it, so the page still scrolls past
      if (document.activeElement !== canvas) return;
      e.preventDefault(); cam.dist *= Math.exp(e.deltaY * 0.0012); cam.auto = false; sortedFor = "";
    }, { passive: false });
    canvas.addEventListener("mouseleave", () => canvas.blur());

    function resize() {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        canvas.style.width = w + "px"; canvas.style.height = h + "px";
      }
    }

    function add(m) {
      if (!m || typeof m.d !== "string" || !(m.n > 0) || !Array.isArray(m.origin)) return;
      let bytes;
      try { bytes = Uint8Array.from(atob(m.d), (c) => c.charCodeAt(0)); } catch (e) { return; }
      if (bytes.length < m.n * 12) return;
      const dv = new DataView(bytes.buffer), q = m.q || 0.005;
      for (let i = 0; i < m.n; i += 1) {
        const o = i * 12;
        const x = m.origin[0] + dv.getInt16(o, true) * q, y = m.origin[1] + dv.getInt16(o + 2, true) * q, z = m.origin[2] + dv.getInt16(o + 4, true) * q;
        const key = (Math.floor(x / CELL) + 32768) + (Math.floor(y / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768) * 4294967296;
        let j = index.get(key);
        if (j === undefined) {
          if (n < MAX) { j = n; n += 1; } else { j = next; next = (next + 1) % MAX; index.delete(keys[j]); }       // full: reuse the oldest slot
          index.set(key, j); keys[j] = key;
        }
        pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z;
        col[j * 4] = bytes[o + 6]; col[j * 4 + 1] = bytes[o + 7]; col[j * 4 + 2] = bytes[o + 8]; col[j * 4 + 3] = 235;
        rad[j] = Math.max(0.004, bytes[o + 9] * 0.0025);
        // the facing, unfolded from its two bytes (the sender folds a unit vector onto an octahedron)
        let ox = dv.getInt8(o + 10) / 127, oy = dv.getInt8(o + 11) / 127;
        const oz = 1 - Math.abs(ox) - Math.abs(oy);
        if (oz < 0) { const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1), ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1); ox = tx; oy = ty; }
        const ol = Math.hypot(ox, oy, oz) || 1;
        nrm[j * 3] = Math.round(127 * ox / ol); nrm[j * 3 + 1] = Math.round(127 * oy / ol); nrm[j * 3 + 2] = Math.round(127 * oz / ol);
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
      }
      if (Array.isArray(m.cam)) headset = m.cam.slice(0, 3);
      state.count = n; state.total = m.total || n; state.chunks += 1; state.last = Date.now();
      dirty = true; sortedFor = "";
    }

    let raf = 0, alive = true, visible = true, lastT = 0;
    function frame(t) {
      raf = 0;
      if (!alive) return;
      if (visible && n) draw(t);
      raf = requestAnimationFrame(frame);
    }

    function draw(t) {
      resize();
      const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
      const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
      const size = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
      if (cam.auto || !cam.dist) cam.dist = size * 0.95;
      if (cam.auto) cam.yaw += dt * 0.12;
      const eye = [cx + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw), cy + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cz + cam.dist * Math.sin(cam.pitch)];
      const view = lookAt(eye, [cx, cy, cz]);
      const fovy = 0.9, proj = perspective(fovy, canvas.width / canvas.height, 0.05, 200);

      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, n * 3), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufCol); gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, n * 4), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufRad); gl.bufferData(gl.ARRAY_BUFFER, rad.subarray(0, n), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufNrm); gl.bufferData(gl.ARRAY_BUFFER, nrm.subarray(0, n * 3), gl.DYNAMIC_DRAW);
        dirty = false;
      }
      // far blobs first, so near ones lie over them: a counting sort on distance along the line of sight
      const want = `${cam.yaw.toFixed(1)}|${cam.pitch.toFixed(1)}|${n}`;
      if (want !== sortedFor) {
        const fx = cx - eye[0], fy = cy - eye[1], fz = cz - eye[2], fl = Math.hypot(fx, fy, fz) || 1;
        let dmin = Infinity, dmax = -Infinity;
        for (let i = 0; i < n; i += 1) {
          const d = ((pos[i * 3] - eye[0]) * fx + (pos[i * 3 + 1] - eye[1]) * fy + (pos[i * 3 + 2] - eye[2]) * fz) / fl;
          depth[i] = d; if (d < dmin) dmin = d; if (d > dmax) dmax = d;
        }
        const B = 4096, counts = new Uint32Array(B + 1), scale = (B - 1) / Math.max(1e-6, dmax - dmin);
        for (let i = 0; i < n; i += 1) counts[B - 1 - Math.floor((depth[i] - dmin) * scale)] += 1;      // bucket 0 = farthest
        let sum = 0;
        for (let b = 0; b <= B; b += 1) { const c = counts[b]; counts[b] = sum; sum += c; }
        for (let i = 0; i < n; i += 1) { const b = B - 1 - Math.floor((depth[i] - dmin) * scale); order[counts[b]] = i; counts[b] += 1; }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, order.subarray(0, n), gl.DYNAMIC_DRAW);
        sortedFor = want;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniformMatrix4fv(loc.view, false, view); gl.uniformMatrix4fv(loc.proj, false, proj);
      gl.uniform1f(loc.px, (canvas.height / 2) / Math.tan(fovy / 2));
      gl.uniform3f(loc.eye, eye[0], eye[1], eye[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufNrm); gl.enableVertexAttribArray(loc.nrm); gl.vertexAttribPointer(loc.nrm, 3, gl.BYTE, true, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufCol); gl.enableVertexAttribArray(loc.col); gl.vertexAttribPointer(loc.col, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufRad); gl.enableVertexAttribArray(loc.rad); gl.vertexAttribPointer(loc.rad, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
      gl.drawElements(gl.POINTS, n, gl.UNSIGNED_INT, 0);
    }

    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((es) => { visible = es[0].isIntersecting; }) : null;
    if (io) io.observe(canvas);
    raf = requestAnimationFrame(frame);

    return {
      add, state,
      count: () => n,
      headset: () => headset,
      destroy() { alive = false; if (raf) cancelAnimationFrame(raf); if (io) io.disconnect(); canvas.remove(); },
    };
  }

  window.SplatView = { create };
})();
