// Physical build -> gameplay attributes.
//
// Two inputs: height (160..200 cm) and build (0 = lean .. 100 = heavy). Every gain
// is paid for somewhere else, so there is no strictly dominant body:
//   tall   -> aerial reach, longer stride, keeper reach   | slower to accelerate/turn, tires faster
//   heavy  -> strength (tackles, shielding, shoulder duels), shot power | slower, less agile, less stamina, lower jump
//   small/lean -> acceleration, agility, stamina          | loses physical duels and aerial balls

export const HEIGHT_MIN = 160;
export const HEIGHT_MAX = 200;

const cache = new Map();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function stats(heightCm, build) {
  const key = heightCm * 256 + build;
  let s = cache.get(key);
  if (s) return s;
  const H = clamp(heightCm, HEIGHT_MIN, HEIGHT_MAX) / 100;
  const h = (H * 100 - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN);
  const b = clamp(build, 0, 100) / 100;
  const hc = h - 0.5;
  const bc = b - 0.5;
  const bmi = 19 + 10 * b;
  const jump = 0.55 - 0.25 * bc - 0.1 * hc;
  s = {
    H, h, b,
    mass: bmi * H * H,
    sprint: 10.26 + 0.35 * hc - 1.17 * bc,      // m/s (9.6 .. 11.0 – 35-40 km/h, a little arcade-quick)
    jog: 5.6 + 0.15 * hc - 0.6 * bc,            // m/s
    accel: 13 - 4.0 * hc - 3.5 * bc,            // m/s^2
    turn: 11 - 4.5 * hc - 2.0 * bc,             // rad/s
    control: 1 - 0.22 * hc - 0.12 * bc,         // dribble tightness
    strength: 0.5 + 0.55 * bc + 0.25 * hc,      // 0..1 duels
    jump,
    reach: H * 0.94 + jump,                     // max header contact height
    shot: 1 + 0.12 * bc + 0.05 * hc,            // shot power multiplier
    stamina: 1 - 0.35 * bc - 0.3 * hc,          // sprint endurance multiplier
    diveSpeed: 4.9 + 0.5 * hc - 0.9 * bc,       // keeper lateral dive speed
    diveReach: 0.9 + 0.9 * H * 0.5 + 0.3 * hc,  // extra reach of arms while diving
    width: 0.8 + 0.4 * b,                       // visual thickness multiplier
  };
  cache.set(key, s);
  return s;
}

// 0..99 ratings for the avatar editor. Ranges are the extremes of the formulas above.
export function ratings(heightCm, build) {
  const s = stats(heightCm, build);
  const r = (v, lo, hi) => Math.round(clamp((v - lo) / (hi - lo), 0, 1) * 60 + 35);
  return [
    ['Top speed', r(s.sprint, 7.3, 8.7)],
    ['Acceleration', r(s.accel, 9.2, 16.8)],
    ['Agility', r(s.turn, 7.8, 14.3)],
    ['Strength', r(s.strength, 0.12, 0.88)],
    ['Aerial', r(s.reach, 1.95, 2.52)],
    ['Shot power', r(s.shot, 0.915, 1.085)],
    ['Stamina', r(s.stamina, 0.68, 1.33)],
  ];
}
