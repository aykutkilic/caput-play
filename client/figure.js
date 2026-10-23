// Player figure: skeleton from a pose, then a stylised "Sims-like" body drawn
// from simple volumes – shaded torso with the shirt number, pelvis and shorts,
// sleeves, bare knees, banded socks, boots, a neck, and a head with a real face
// (eyes, brows, nose, mouth, ears) and hair, all placed in 3D so they turn and
// foreshorten with the body. Small details are dropped when the figure is tiny.

const TAU = Math.PI * 2;
const OUTLINE = 'rgba(10,20,15,0.5)';

// ---------------------------------------------------------------- colours

const shadeCache = new Map();
// amt > 0 lightens towards white, amt < 0 darkens towards black
export function shade(hex, amt) {
  const key = hex + amt;
  let v = shadeCache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (amt > 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; } else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  v = `rgb(${r | 0},${g | 0},${b | 0})`;
  shadeCache.set(key, v);
  return v;
}

// ---------------------------------------------------------------- skeleton

function legFK(out, hip, th, kn, abd, side, thigh, shin, foot) {
  const ca = Math.cos(abd), sa = Math.sin(abd) * side;
  const kx = hip[0] + Math.sin(th) * thigh * ca;
  const ky = hip[1] + sa * thigh;
  const kz = hip[2] - Math.cos(th) * thigh * ca;
  const a2 = th - kn;
  const ax = kx + Math.sin(a2) * shin * ca, ay = ky + sa * shin * 0.6, az = kz - Math.cos(a2) * shin * ca;
  // the foot points forward, roughly square to the shin (ankle flex limited)
  const fa = Math.max(-0.5, Math.min(0.9, a2 * 0.7));
  out[0] = [kx, ky, kz];
  out[1] = [ax, ay, az];
  out[2] = [ax + Math.cos(fa) * foot, ay, az + Math.sin(fa) * foot - 0.012];
}

function armFK(out, sh, th, abd, el, side, upper, fore) {
  const ca = Math.cos(abd), sa = Math.sin(abd) * side;
  const ex = sh[0] + Math.sin(th) * upper * ca;
  const ey = sh[1] + sa * upper;
  const ez = sh[2] - Math.cos(th) * upper * ca;
  const t2 = th + el;
  out[0] = [ex, ey, ez];
  out[1] = [ex + Math.sin(t2) * fore * ca, ey + sa * fore * 0.85, ez - Math.cos(t2) * fore * ca];
}

// Joints in world space for pose P (see poseFor in render.js).
export function skeleton(p, P, H, wd, x, y, z, face) {
  const hipH = 0.53 * H, thigh = 0.262 * H, shin = 0.262 * H, foot = 0.13 * H;
  const torso = 0.285 * H, upper = 0.165 * H, fore = 0.165 * H;
  const shW = 0.118 * H * (0.86 + 0.25 * (wd - 0.8)), hipW = 0.062 * H * wd;
  const hz = hipH - P.drop;
  const hc = [0, 0, hz];
  const sl = Math.sin(P.lean), cl = Math.cos(P.lean);
  const neck = [torso * sl, 0, hz + torso * cl];
  const ct = Math.cos(P.tw), st = Math.sin(P.tw);
  const shR = [neck[0] - st * shW, ct * shW, neck[2] - 0.025 * H];
  const shL = [neck[0] + st * shW, -ct * shW, neck[2] - 0.025 * H];
  // hips counter-rotate a little against the shoulders
  const ht = -P.tw * 0.45, hct = Math.cos(ht), hst = Math.sin(ht);
  const hipR = [-hst * hipW, hct * hipW, hz], hipL = [hst * hipW, -hct * hipW, hz];
  const hl = 0.1 * H, ha = P.lean + P.head;
  const sha = Math.sin(ha), cha = Math.cos(ha);
  const head = [neck[0] + sha * hl, 0, neck[2] + cha * hl];
  // head frame markers (forward / up / right), transformed with the body below
  const nose = [head[0] + cha * 0.1, 0, head[2] - sha * 0.1];
  const headUp = [head[0] + sha * 0.1, 0, head[2] + cha * 0.1];
  const headR = [head[0], 0.1, head[2]];
  const L = [], R = [], AL = [], AR = [];
  legFK(L, hipL, P.lh, P.lk, P.la, -1, thigh, shin, foot);
  legFK(R, hipR, P.rh, P.rk, P.ra, 1, thigh, shin, foot);
  armFK(AL, shL, P.lsh + P.lean * 0.6, P.lab, P.lel, -1, upper, fore);
  armFK(AR, shR, P.rsh + P.lean * 0.6, P.rab, P.rel, 1, upper, fore);
  const J = {
    hc, neck, head, nose, headUp, headR, shL, shR, hipL, hipR,
    kneeL: L[0], footL: L[1], toeL: L[2], kneeR: R[0], footR: R[1], toeR: R[2],
    elL: AL[0], handL: AL[1], elR: AR[0], handR: AR[1],
  };
  // whole-body rotations about the hips (pitch around the side axis, roll around forward)
  const pivot = hz;
  const cp = Math.cos(P.pitch), sp = Math.sin(P.pitch), cr = Math.cos(P.roll), sr = Math.sin(P.roll);
  const cf = Math.cos(face), sf = Math.sin(face);
  const zb = z + P.bob;
  for (const k in J) {
    const j = J[k];
    let f = j[0], r = j[1], u = j[2] - pivot;
    if (P.pitch) { const f2 = f * cp + u * sp; u = -f * sp + u * cp; f = f2; }
    if (P.roll) { const r2 = r * cr + u * sr; u = -r * sr + u * cr; r = r2; }
    u += pivot;
    J[k] = [x + f * cf - r * sf, y + f * sf + r * cf, Math.max(0.02, zb + u)];
  }
  return J;
}

// ---------------------------------------------------------------- body

const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
// how much a world vector points towards the viewer
const toward = (cam, v) => (v[0] * cam.s + v[1] * cam.c) * cam.ce + v[2] * cam.se;

export function drawFigure(g, cam, J, look, H, wd, alpha = 1) {
  const S = cam.scale;
  const P = {};
  for (const k in J) { const j = J[k]; P[k] = [cam.px(j[0], j[1], j[2]), cam.py(j[0], j[1], j[2]), cam.depth(j[0], j[1]) + j[2] * 0.02]; }
  const headR = 0.094 * H * S;
  const detail = headR > 3.6;
  const items = [];
  const seg = (a, b, wm, col, d = (a[2] + b[2]) / 2) => items.push({ k: 0, a, b, w: Math.max(1, wm * H * S), col, d });
  const dot = (a, rm, col, d = a[2]) => items.push({ k: 1, a, r: Math.max(1, rm * H * S), col, d });
  const P3 = (k) => P[k];

  for (const s of ['L', 'R']) {
    const hip = P3('hip' + s), knee = P3('knee' + s), ankle = P3('foot' + s), toe = P3('toe' + s);
    seg(hip, lerp3(hip, knee, 0.52), 0.104 * wd, look.shorts);
    seg(lerp3(hip, knee, 0.42), knee, 0.074 * wd, look.skin);
    seg(lerp3(knee, ankle, 0.1), ankle, 0.062 * wd, look.socks);
    if (detail) seg(lerp3(knee, ankle, 0.1), lerp3(knee, ankle, 0.2), 0.066 * wd, look.trim);
    seg(ankle, toe, 0.058, look.boots, Math.max(ankle[2], toe[2]) + 0.01);
  }
  for (const s of ['L', 'R']) {
    const sh = P3('sh' + s), el = P3('el' + s), hand = P3('hand' + s);
    if (look.longSleeves) {
      seg(sh, el, 0.064 * wd, look.shirt);
      seg(el, hand, 0.054 * wd, look.shirt);
    } else {
      seg(sh, lerp3(sh, el, 0.56), 0.07 * wd, look.shirt);
      seg(lerp3(sh, el, 0.5), el, 0.05 * wd, look.skin);
      seg(el, hand, 0.044 * wd, look.skin);
    }
    // the hand, along the line of the forearm: a keeper's big padded glove
    // with a dark cuff, otherwise a small bare hand
    const tip = lerp3(hand, lerp3(el, hand, 1.42), 1), d = Math.max(hand[2], tip[2]) + 0.006;
    if (look.gloves) {
      seg(lerp3(el, hand, 0.9), hand, 0.052 * wd, shade(look.gloves, -0.45), d);
      seg(hand, tip, 0.06, look.gloves, d + 0.001);
      if (detail) seg(lerp3(hand, tip, 0.55), lerp3(hand, tip, 0.95), 0.03, shade(look.gloves, -0.12), d + 0.002); // palm
    } else {
      seg(hand, lerp3(hand, tip, 0.75), 0.034, look.skin, d);
    }
  }
  // pelvis / shorts block and torso
  seg(P.hipL, P.hipR, 0.12 * wd, look.shorts, P.hc[2] - 0.01);
  items.push({ k: 2, d: (P.hc[2] + P.neck[2]) / 2, w: 0.085 * H * wd * S });
  seg(P.neck, lerp3(P.neck, P.head, 0.55), 0.058, look.skin, P.neck[2] + 0.004);
  items.push({ k: 3, d: P.head[2] + 0.01 });
  items.sort((a, b) => a.d - b.d);

  // shirt: shoulders tapering to the waist, which sits just over the shorts
  const waistR = lerp3(lerp3(P.hipR, P.shR, 0.16), P.hc, -0.05), waistL = lerp3(lerp3(P.hipL, P.shL, 0.16), P.hc, -0.05);
  const torsoPts = [lerp3(P.shL, P.shR, -0.06), lerp3(P.shR, P.shL, -0.06), waistR, waistL];
  const torsoPath = () => {
    g.beginPath();
    g.moveTo(torsoPts[0][0], torsoPts[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(torsoPts[i][0], torsoPts[i][1]);
    g.closePath();
  };

  g.globalAlpha = alpha;
  g.lineCap = 'round'; g.lineJoin = 'round';
  // 1) dark outline under everything: limbs read clearly on grass, no seams inside
  g.strokeStyle = OUTLINE; g.fillStyle = OUTLINE;
  for (const it of items) {
    if (it.k === 0) { g.lineWidth = it.w + 2; g.beginPath(); g.moveTo(it.a[0], it.a[1]); g.lineTo(it.b[0], it.b[1]); g.stroke(); }
    else if (it.k === 1) { g.beginPath(); g.arc(it.a[0], it.a[1], it.r + 1, 0, TAU); g.fill(); }
    else if (it.k === 2) { g.lineWidth = it.w + 2; torsoPath(); g.stroke(); g.fill(); }
  }
  // 2) colours, back to front, with a soft highlight from the top-left
  for (const it of items) {
    if (it.k === 0) {
      g.strokeStyle = it.col; g.lineWidth = it.w;
      g.beginPath(); g.moveTo(it.a[0], it.a[1]); g.lineTo(it.b[0], it.b[1]); g.stroke();
      if (detail && it.w > 2.5) {
        const o = it.w * 0.2;
        g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = it.w * 0.32;
        g.beginPath(); g.moveTo(it.a[0] - o, it.a[1] - o); g.lineTo(it.b[0] - o, it.b[1] - o); g.stroke();
      }
    } else if (it.k === 1) {
      g.fillStyle = it.col;
      g.beginPath(); g.arc(it.a[0], it.a[1], it.r, 0, TAU); g.fill();
    } else if (it.k === 2) {
      drawTorso(g, cam, J, P, torsoPts, torsoPath, it.w, look, H, S, detail);
    } else {
      drawHead(g, cam, J, P, look, headR, detail);
    }
  }
  g.globalAlpha = 1;
}

function drawTorso(g, cam, J, P, pts, path, w, look, H, S, detail) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const grad = g.createLinearGradient(x0 - w / 2, y0 - w / 2, x1 + w / 2, y1 + w / 2);
  grad.addColorStop(0, shade(look.shirt, 0.24));
  grad.addColorStop(0.55, look.shirt);
  grad.addColorStop(1, shade(look.shirt, -0.28));
  g.fillStyle = grad; g.strokeStyle = grad; g.lineWidth = w;
  path(); g.stroke(); g.fill();
  if (!detail) return;
  const fwd = [J.nose[0] - J.head[0], J.nose[1] - J.head[1], J.nose[2] - J.head[2]];
  const facing = toward(cam, fwd) / 0.1;
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4, cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  if (facing < -0.25 && look.number) {
    // shirt number on the back
    const size = Math.max(7, 0.1 * H * S);
    g.font = `800 ${size}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = Math.max(1.5, size * 0.16); g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.strokeText(String(look.number), cx, cy - size * 0.15);
    g.fillStyle = look.trim;
    g.fillText(String(look.number), cx, cy - size * 0.15);
    g.textBaseline = 'alphabetic';
  } else if (facing > 0.1) {
    // collar
    const n = P.neck;
    g.strokeStyle = look.trim; g.lineWidth = Math.max(1, w * 0.12);
    g.beginPath(); g.ellipse(n[0], n[1] + w * 0.22, w * 0.22, w * 0.12, 0, 0.1, Math.PI - 0.1); g.stroke();
  }
}

// ---------------------------------------------------------------- head & face

function drawHead(g, cam, J, P, look, r, detail) {
  const [hx, hy] = P.head;
  const n = (k) => { const v = [J[k][0] - J.head[0], J[k][1] - J.head[1], J[k][2] - J.head[2]]; const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const f = n('nose'), up = n('headUp'), side = n('headR');
  // screen position of head + a*f + b*up + c*side (in head radii)
  const pt = (a, b, c) => {
    const vx = f[0] * a + up[0] * b + side[0] * c, vy = f[1] * a + up[1] * b + side[1] * c, vz = f[2] * a + up[2] * b + side[2] * c;
    return [hx + (vx * cam.c - vy * cam.s) * r, hy + ((vx * cam.s + vy * cam.c) * cam.se - vz * cam.ce) * r, toward(cam, [vx, vy, vz])];
  };
  const facing = toward(cam, f);
  const style = look.hair | 0, hc = look.hairColor;
  const circle = (p, rad, col) => { g.fillStyle = col; g.beginPath(); g.arc(p[0], p[1], Math.max(0.6, rad), 0, TAU); g.fill(); };

  // hair that sits behind the head
  if (style === 4) circle(pt(-0.15, 0.4, 0), r * 1.42, hc);                       // afro
  if (style === 3) { g.fillStyle = hc; const c = pt(-0.3, -0.45, 0); g.beginPath(); g.ellipse(c[0], c[1], r * 1.1, r * 1.35, 0, 0, TAU); g.fill(); } // long
  if (style === 6) { const c = pt(-1.05, -0.05, 0); if (c[2] < 0) { circle(c, r * 0.36, hc); circle(pt(-1.15, -0.65, 0), r * 0.26, hc); } } // ponytail
  if (style === 7) { const c = pt(-0.45, 1.0, 0); if (c[2] < 0.2) circle(c, r * 0.4, hc); } // bun (behind)
  // ears behind the head
  for (const e of [-1, 1]) { const c = pt(0, 0.02, e * 0.97); if (c[2] < 0) circle(c, r * 0.22, shade(look.skin, -0.12)); }

  // head
  circle([hx, hy], r + 1, OUTLINE);
  const grad = g.createRadialGradient(hx - r * 0.35, hy - r * 0.4, r * 0.15, hx, hy, r * 1.05);
  grad.addColorStop(0, shade(look.skin, 0.18));
  grad.addColorStop(1, shade(look.skin, -0.12));
  g.fillStyle = grad;
  g.beginPath(); g.arc(hx, hy, r, 0, TAU); g.fill();

  // hair cap: a disc shifted back and up, clipped to the head – gives a hairline that turns with the head
  if (style !== 0) {
    g.save();
    g.beginPath(); g.arc(hx, hy, r * 1.04, 0, TAU); g.clip();
    const buzz = style === 2 || style === 5;
    g.globalAlpha *= buzz ? (style === 5 ? 0.35 : 0.6) : 1;
    const c = pt(-0.42, 0.5, 0);
    circle(c, r * 1.02, hc);
    g.restore();
  }
  if (style === 8) { // curly: bumpy top
    for (let i = 0; i < 7; i++) {
      const a = -1.3 + i * 0.43;
      const c = pt(-0.2, Math.cos(a) * 0.86, Math.sin(a) * 0.86);
      if (c[2] > -0.6 || facing < 0) circle(c, r * 0.3, hc);
    }
  }
  if (style === 9 && facing > -0.3) { // side part: fringe swept over the forehead
    const c = pt(0.62, 0.62, 0.32);
    g.fillStyle = hc; g.beginPath(); g.ellipse(c[0], c[1], r * 0.5, r * 0.24, -0.35, 0, TAU); g.fill();
  }
  if (style === 5) { // mohawk ridge front to back
    const a = pt(0.7, 0.72, 0), b = pt(-0.85, 0.55, 0), m = pt(0, 1.02, 0);
    g.strokeStyle = hc; g.lineWidth = r * 0.42; g.lineCap = 'round';
    g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(m[0], m[1], b[0], b[1]); g.stroke();
  }
  if (style === 7) { const c = pt(-0.45, 1.0, 0); if (c[2] >= 0.2) circle(c, r * 0.4, hc); } // bun (in front)

  // ears in front
  for (const e of [-1, 1]) { const c = pt(0, 0.02, e * 0.97); if (c[2] >= 0) circle(c, r * 0.21, shade(look.skin, -0.06)); }

  if (!detail || facing < -0.2) return;
  // face – each feature drawn only if its side of the head faces the viewer
  const vis = (c) => c[2] > 0.05;
  // facial hair
  const beard = look.beard | 0;
  if (beard) {
    const chin = pt(0.8, -0.62, 0);
    if (vis(chin)) {
      g.fillStyle = hc;
      if (beard === 1) { g.globalAlpha *= 0.3; g.beginPath(); g.ellipse(chin[0], chin[1] - r * 0.05, r * 0.62, r * 0.4, 0, 0, TAU); g.fill(); g.globalAlpha /= 0.3; }
      else if (beard === 2) { g.beginPath(); g.ellipse(chin[0], chin[1] - r * 0.02, r * 0.6, r * 0.42, 0, 0, TAU); g.fill(); }
      else if (beard === 4) { g.beginPath(); g.ellipse(chin[0], chin[1] + r * 0.06, r * 0.2, r * 0.22, 0, 0, TAU); g.fill(); }
    }
  }
  for (const e of [-1, 1]) {
    const c = pt(0.84, 0.12, e * 0.36);
    if (!vis(c)) continue;
    const big = r > 7;
    if (big) { g.fillStyle = '#fbfaf6'; g.beginPath(); g.ellipse(c[0], c[1], r * 0.15, r * 0.12, 0, 0, TAU); g.fill(); }
    circle(c, r * (big ? 0.085 : 0.1), '#2a1a12');
    if (big) circle([c[0] - r * 0.03, c[1] - r * 0.035], r * 0.03, '#ffffff');
    const b = pt(0.86, 0.36, e * 0.36);
    g.strokeStyle = shade(hc, -0.1); g.lineWidth = Math.max(0.8, r * 0.07); g.lineCap = 'round';
    g.beginPath(); g.moveTo(b[0] - r * 0.12, b[1] + e * 0 - r * 0.01); g.lineTo(b[0] + r * 0.12, b[1] - r * 0.03); g.stroke();
  }
  const nose = pt(1.0, -0.08, 0);
  if (vis(nose)) circle(nose, r * 0.1, shade(look.skin, -0.18));
  const mouth = pt(0.9, -0.42, 0);
  if (vis(mouth)) {
    if (beard === 3) { // moustache
      const m = pt(0.94, -0.28, 0);
      g.strokeStyle = hc; g.lineWidth = Math.max(1, r * 0.13);
      g.beginPath(); g.moveTo(m[0] - r * 0.2, m[1] + r * 0.03); g.quadraticCurveTo(m[0], m[1] - r * 0.06, m[0] + r * 0.2, m[1] + r * 0.03); g.stroke();
    }
    g.strokeStyle = '#7a2e26'; g.lineWidth = Math.max(0.8, r * 0.07);
    g.beginPath(); g.arc(mouth[0], mouth[1] - r * 0.08, r * 0.17, 0.25 * Math.PI, 0.75 * Math.PI); g.stroke();
  }
}
