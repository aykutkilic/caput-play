// Learned from real matches: SkillCorner's open broadcast tracking data
// (github.com/SkillCorner/opendata, MIT licence – every player and the ball
// taken from the TV pictures by computer vision), 20 A-League matches.
// Written by scripts/learn/learn-positioning.mjs – rerun it, don't edit.

// The shape a side keeps, with the ball (ip) and without it (op), by the
// ball's depth (8 equal bins from the side's own goal line to the other's):
// where its middle is along the pitch (cx, of the half length), its spread
// along (sx, of the half length) and across (sy, of the half width); cyk: how
// far across it follows the ball (a share of the ball's y).
export const SHAPE = {
  ip: { cx: [-0.51,-0.352,-0.202,-0.041,0.119,0.269,0.418,0.547], sx: [0.242,0.23,0.216,0.206,0.203,0.209,0.227,0.242], sy: [0.39,0.431,0.438,0.431,0.413,0.384,0.354,0.325], cyk: 0.378 },
  op: { cx: [-0.677,-0.542,-0.388,-0.232,-0.071,0.09,0.241,0.39], sx: [0.182,0.176,0.172,0.172,0.18,0.194,0.224,0.258], sy: [0.267,0.294,0.315,0.333,0.341,0.345,0.344,0.332], cyk: 0.413 },
};

// A man without the ball: how far off him the nearest opponent stands
// (r, m, the median) and in which direction (a, radians off the line from him
// to the goal he attacks, + to the ball's side), by his distance to that goal
// (rows, at g m) and to the ball (columns, at b m).
export const MARK = {
  g: [4,11,17,24,33,44,60,85], b: [4,11,17,25,45],
  r: [
    [2.38,2.13,2.13,1.88,2.13],
    [2.38,2.13,2.13,2.13,2.13],
    [2.38,2.63,2.63,2.38,3.13],
    [2.88,3.13,3.38,3.13,4.13],
    [3.38,3.88,4.13,4.13,5.38],
    [3.88,4.63,5.13,5.63,6.63],
    [4.13,5.13,6.38,7.13,9.13],
    [3.63,5.38,7.38,8.38,11.38],
  ],
  a: [
    [0.45,0.43,0.43,0.13,0.25],
    [0.45,0.43,0.43,0.13,0.25],
    [0.45,0.43,0.43,0.26,0.49],
    [0.45,0.43,0.43,0.42,0.68],
    [0.35,0.43,0.43,0.42,0.75],
    [0.21,0.4,0.43,0.42,0.67],
    [0.31,0.38,0.39,0.45,0.61],
    [0.25,0.31,0.36,0.43,0.59],
  ],
};
