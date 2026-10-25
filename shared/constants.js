// Shared constants. Everything here is used identically by server and client so
// the client-side prediction runs the exact same rules as the authoritative server.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SNAP_EVERY = 2; // server sends a snapshot every 2 ticks (30 Hz)

export const G = 9.81;
export const BALL_R = 0.11;
export const PLAYER_R = 0.34;
export const MAX_PLAYERS = 16;

// Input byte: a kick is a TARGET (bits 0-2) and a HEIGHT (bits 3-4); holding
// it sets the power. Plus sprint, precision dribble and "call for pass".
//   targets:  MATE (to a team-mate's feet / head), RUN (into a team-mate's
//             running path), GOAL (shot), SELF (pass to self / lift / skills)
//   heights:  GROUND (to feet / low shot), MID (chest / mid-height), HIGH (head /
//             top corner)
// On defence the same keys mean: MATE held = press, GOAL = slide tackle (keeper:
// dive), RUN = send the keeper out.
export const KT = { NONE: 0, MATE: 1, RUN: 2, GOAL: 3, SELF: 4 };
export const KH = { GROUND: 0, MID: 1, HIGH: 2 };
export const KICK_MASK = 7;
export const BTN = {
  SPRINT: 32,  // R1 sprint / knock-on dribble
  R2: 64,      // R2 precision dribble / shielding / finesse shot
  CALL: 128,   // call for a pass
};
export const packKick = (target, height) => target | (height << 3);
export const kickTarget = (b) => b & KICK_MASK;
export const kickHeight = (b) => (b >> 3) & 3;

export const PHASE = { WARMUP: 0, KICKOFF: 1, PLAY: 2, GOAL: 3, SETPIECE: 4, HALFTIME: 5, FULLTIME: 6 };
export const PHASE_NAME = ['Warm-up', 'Kick-off', 'Play', 'Goal', 'Set piece', 'Half time', 'Full time'];

// Player states
export const ST = {
  IDLE: 0, KICK: 1, SLIDE: 2, TACKLE: 3, HEADER: 4, VOLLEY: 5, OVERHEAD: 6,
  DIVE: 7, FALLEN: 8, DIVEHEAD: 9, THROW: 10, STUMBLE: 11, SKILL: 13, BLOCK: 14, CONTROL: 15, // (12: retired)
  PUNCH: 16, TIP: 17, // keeper: punching a high ball clear / tipping one over the bar (contact point in kx, ky, stB)
};

// A keeper's blocks (ST.DIVE with p.spr set): spread on his side across the
// shot, the star jump (an X in the air), the K-barrier (down on one knee, the
// shin across the near post side) and the splits save (a leg slid out sideways
// along the grass at a low shot just wide of him, too quick to dive for)
export const GKB = { SPREAD: 1, STAR: 2, KNEE: 3, SPLITS: 4 };

// Controlling a ball out of the air (ST.CONTROL, part in the player's stB)
export const PART = { FOOT: 0, THIGH: 1, CHEST: 2, HEAD: 3 };
// How a player meets the ball (p.tm): running at it, or running with it
export const MEET = { NONE: 0, AT: 1, WITH: 2 };

// Technique moves (ST.SKILL, kind stored in the player's stA)
export const SKILL = { LIFT: 1, KNOCK: 2, FEINT_L: 3, FEINT_R: 4, DRAGBACK: 5 };

export const ROLE = { OUT: 0, GK: 1 };

// Set pieces
export const SP = { NONE: 0, THROWIN: 1, CORNER: 2, GOALKICK: 3, FREEKICK: 4, PENALTY: 5, KICKOFF: 6 };
export const SP_NAME = ['', 'Throw-in', 'Corner', 'Goal kick', 'Free kick', 'Penalty', 'Kick-off'];

// Kick kinds
export const KICK = { PASS: 1, LONG: 2, SHOT: 3, THROUGH: 4, CHIP: 5, CLEAR: 6, THROW: 7, PUNT: 8, FINESSE: 9, SELF: 10, DROP: 11 };
// How a shot off the ground is struck (p.kq): facing the goal, plainly; with
// the back to it, a back-heel or a turn with the ball first
export const KQ = { PLAIN: 0, HEEL: 1, TURN: 2 };

// Pitch presets (metres). Small-sided games play on smaller pitches.
export const PITCHES = [
  { name: 'Small', L: 46, W: 30, goalW: 5.0, goalH: 2.1, boxD: 9, boxW: 18, areaD: 3.5, areaW: 9, centerR: 5, penSpot: 7.5 },
  { name: 'Medium', L: 64, W: 40, goalW: 6.0, goalH: 2.3, boxD: 12.5, boxW: 26, areaD: 4.5, areaW: 12, centerR: 6.5, penSpot: 9.5 },
  { name: 'Large', L: 90, W: 58, goalW: 7.32, goalH: 2.44, boxD: 16.5, boxW: 40.3, areaD: 5.5, areaW: 18.3, centerR: 9.15, penSpot: 11 },
];
export const GOAL_DEPTH = 1.6;
// room settings: bigger goals make scoring easier against a good keeper / AI
// (all 10% bigger than they started, wide and high – Huge a little less high)
export const GOAL_SIZES = [{ name: 'Small', w: 1.1, h: 1.1 }, { name: 'Large', w: 1.43, h: 1.265 }, { name: 'Huge', w: 1.76, h: 1.32 }];
export const GOAL_SIZE_DEFAULT = 1; // rooms start with large goals
export const AI_LEVELS = ['Casual', 'Normal', 'Pro'];
export const POST_R = 0.06;

export function autoPitch(maxTeamSize) {
  if (maxTeamSize <= 2) return 0;
  if (maxTeamSize <= 4) return 1;
  return 2;
}

export const TEAM_NAMES = ['TEAM A', 'TEAM B'];
// kits the host can give each team (room setting; never the same for both)
export const KIT_NAMES = ['Red', 'Blue', 'Dark blue', 'Yellow', 'White', 'Black'];
export const KITS_DEFAULT = [0, 1];

// The only things players can say: quick-chat lines, sent by number (keys 1-5).
export const QUICK_CHAT = ['Pass!', 'Shoot!', 'Nice one!', 'Sorry!', 'Good game!'];
