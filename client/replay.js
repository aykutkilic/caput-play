// Goal replays, built from the authoritative snapshots the client already
// receives (30 Hz, exact server state – no mispredictions), interpolated for
// smooth playback. The run-up plays at normal speed, the finish in slow motion.

const BEFORE = 240;     // ticks of build-up shown before the goal
const AFTER = 50;       // ticks after the ball crossed the line
const SLOWMO = 80;      // the last ticks before the goal play in slow motion
const SLOW_SPEED = 0.45;

const TAU = Math.PI * 2;
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

export class Replay {
  constructor() { this.active = false; }

  // history: [{ tick, pitchId, m, ball, players }] oldest first
  start(history, goalTick) {
    const frames = history.filter((f) => f.tick >= goalTick - BEFORE && f.tick <= goalTick + AFTER);
    if (frames.length < 8) return false;
    this.frames = frames;
    this.goalTick = goalTick;
    this.t = frames[0].tick;
    this.end = frames[frames.length - 1].tick;
    this.i = 0;
    this.active = true;
    return true;
  }

  stop() { this.active = false; }

  // Advances by dt real seconds; returns { world, speed } or null when done.
  next(dt) {
    if (!this.active) return null;
    const speed = this.t > this.goalTick - SLOWMO ? SLOW_SPEED : 1;
    this.t += dt * 60 * speed;
    if (this.t >= this.end) { this.active = false; return null; }
    const f = this.frames;
    while (this.i < f.length - 2 && f[this.i + 1].tick <= this.t) this.i++;
    const a = f[this.i], b = f[this.i + 1];
    const u = Math.min(1, Math.max(0, (this.t - a.tick) / Math.max(1, b.tick - a.tick)));
    return { world: lerpWorld(a, b, u), speed };
  }
}

function lerpWorld(a, b, u) {
  const L = (x, y) => x + (y - x) * u;
  const next = new Map(b.players.map((p) => [p.id, p]));
  const players = a.players.map((p) => {
    const q = next.get(p.id) || p;
    const x = L(p.x, q.x), y = L(p.y, q.y), z = L(p.z, q.z);
    return {
      ...p, x, y, z, px: x, py: y, pz: z, vx: L(p.vx, q.vx), vy: L(p.vy, q.vy),
      face: p.face + angDiff(p.face, q.face) * u,
      stT: q.st === p.st ? L(p.stT, q.stT) : p.stT,
    };
  });
  const ba = a.ball, bb = b.ball;
  // a big jump means the ball was reset (e.g. kick-off): don't smear across it
  const jump = Math.hypot(bb.x - ba.x, bb.y - ba.y) > 4;
  const bx = jump ? ba.x : L(ba.x, bb.x), by = jump ? ba.y : L(ba.y, bb.y), bz = jump ? ba.z : L(ba.z, bb.z);
  const ball = { ...ba, x: bx, y: by, z: bz, px: bx, py: by, pz: bz, vx: L(ba.vx, bb.vx), vy: L(ba.vy, bb.vy), vz: L(ba.vz, bb.vz) };
  return { tick: a.tick, pitchId: a.pitchId, m: a.m, ball, players };
}
