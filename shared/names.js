// Names other people see – player names and room names – kept clean. The
// editor and Create room check them as you type, and whoever is in charge
// cleans what arrives again (the host's Room through sanitizeProfile, the
// dedicated server, the room list's Lobby), so a modified client can't get
// round it.
//
//  * Player names: letters (any alphabet) and digits, single spaces, at most
//    16. Room names: the same plus a little punctuation (Ali's room – 5v5!),
//    at most 28.
//  * No swearing – Turkish, English and a dozen other languages, also spelt
//    with digits (0r0spu), spaced out (f u c k), stretched (fuuuck), with
//    accents or with look-alike letters from other alphabets – and nothing
//    about religion or politics.
//
// Matching: the text is folded (lower case, accents off, ı → i, Cyrillic and
// Greek look-alikes → Latin) and checked as it is and with digits read as
// letters, word by word and with all words run together, also with repeated
// letters squeezed. ROOTS match anywhere (long, unmistakable stems); WORDS
// only as a whole word, for short or ambiguous ones (am, sik, nazi – not
// Nazım; puta – not computadora; putin – not computing). Common given names
// stay allowed even where they are religious in origin (Muhammed, İslam,
// Christian, Jesús); politicians' names are not.

export const NAME_MAX = 16;
export const ROOM_NAME_MAX = 28;

// stems that match anywhere (folded: ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u)
const ROOTS = [
  // Turkish
  'orospu', 'orosbu', 'oruspu', 'orusbu', 'orspu', 'orsbu', 'aminakoy', 'aminako', 'aminasok', 'aminkoy', 'amcik', 'amcig',
  'siktir', 'sikerim', 'sikeyim', 'sikiyim', 'sikis', 'sikik', 'siksok', 'yarrak', 'yarak', 'yarram', 'dalyarak', 'tasak', 'tassak',
  'pezevenk', 'kahpe', 'kaltak', 'surtuk', 'yavsak', 'gavat', 'pust', 'ibne', 'ipne', 'gotveren', 'gotlek', 'gotos', 'ananisik',
  'bacinisik', 'serefsiz', 'gerizekali', 'dangalak', 'salak', 'aptal', 'kodumun', 'pickurusu',
  // English
  'fuck', 'phuck', 'fvck', 'shit', 'bitch', 'biatch', 'cunt', 'asshole', 'bastard', 'whore', 'slut', 'faggot', 'nigger', 'nigga',
  'retard', 'dildo', 'pussy', 'penis', 'vagina', 'porn', 'jizz', 'blowjob', 'handjob', 'motherf', 'molest', 'pedofil', 'pedophil',
  'boob', 'horny', 'milf', 'twat', 'bollock',
  // German, French, Spanish, Italian, Portuguese
  'scheis', 'arschloch', 'fotze', 'wichser', 'hurensohn', 'schlampe', 'ficken', 'missgeburt', 'nutte', 'spasti',
  'putain', 'connard', 'connasse', 'salope', 'encule', 'niquer', 'batard', 'enfoire',
  'mierda', 'cabron', 'gilipollas', 'pendejo', 'culero', 'chingad', 'chingar', 'maricon', 'hijueputa', 'hijodeputa', 'joder',
  'cazzo', 'vaffanculo', 'fanculo', 'stronzo', 'puttana', 'minchia', 'coglion',
  'caralho', 'buceta', 'fodase',
  // Russian, Polish, Dutch (in Latin letters), Hindi, Arabic, Persian
  'blyat', 'blyad', 'pizd', 'mudak', 'pidor', 'pidar', 'gandon', 'eblan', 'yebat', 'yobany',
  'kurwa', 'pierdol', 'spierdal', 'jebac', 'kanker', 'klootzak', 'godverdomme',
  'chutiya', 'chutia', 'bhenchod', 'behenchod', 'madarchod', 'bhosdi',
  'sharmouta', 'sharmuta', 'sharmota', 'kussomak', 'kussommak', 'kusomak', 'metnak', 'khawal', 'zebbi', 'manyok', 'koskesh',
  // religion
  'allah', 'peygamber', 'prophet', 'muslim', 'musluman', 'hristiyan', 'hiristiyan', 'christianity', 'jesuschrist', 'yahudi',
  'kafir', 'gavur', 'ateist', 'atheist', 'satanist', 'seytan', 'kilise', 'sinagog', 'synagogue', 'mosque', 'seriat', 'sharia',
  'jihad', 'mezhep', 'tarikat', 'selefi', 'vahhabi', 'wahhabi', 'hizbullah', 'hezbollah', 'taliban', 'crusade', 'namaz', 'abdest',
  'tekbir', 'budist', 'buddhist', 'vatican', 'vatikan', 'dinsiz', 'islamist', 'islamci', 'islamic',
  // politics
  'erdogan', 'tayyip', 'ataturk', 'kilicdaroglu', 'bahceli', 'imamoglu', 'davutoglu', 'aksener', 'ocalan', 'fethullah', 'fetullah',
  'hitler', 'mussolini', 'stalin', 'lenin', 'netanyahu', 'zelensk', 'kemalist', 'kemalizm', 'ulkucu', 'apocu', 'terorist',
  'fascis', 'fasist', 'fasizm', 'faschis', 'komunist', 'communis', 'kommunist', 'sosyalist', 'socialis', 'anarsist', 'anarchis',
  'zionis', 'siyonis', 'kurdistan', 'marxis', 'bolsevik', 'bolshevik', 'akparti', 'iyiparti',
];

// whole words only (short or ambiguous)
const WORDS = new Set([
  // Turkish
  'am', 'amk', 'amq', 'aq', 'mk', 'sik', 'skm', 'skim', 'sktr', 'skt', 'oc', 'pic', 'got', 'bok', 'dol', 'pezo',
  // English
  'ass', 'dick', 'cock', 'cum', 'sex', 'sexy', 'tit', 'tits', 'fag', 'rape', 'rapist', 'anal', 'anus', 'wank', 'wanker', 'tosser',
  'hoe', 'hoes', 'wtf', 'stfu', 'gtfo', 'fck', 'fuk', 'fuq', 'fk', 'kkk',
  // German, French, Spanish, Italian, Portuguese, Russian, Polish, Dutch, Hindi, Persian
  'fick', 'hure', 'spast', 'nique', 'pute', 'putes', 'fdp', 'ntm', 'puta', 'puto', 'putas', 'putos', 'hdp', 'verga', 'cono', 'pinche',
  'merda', 'troia', 'foda', 'viado', 'porra', 'cu', 'suka', 'huy', 'hui', 'xuy', 'xyi', 'xui', 'chuj', 'hoer', 'kut', 'randi',
  'gaand', 'jende',
  // religion
  'god', 'gott', 'dieu', 'dios', 'tanri', 'tanrim', 'kuran', 'quran', 'koran', 'incil', 'bible', 'tevrat', 'torah', 'zebur', 'cami',
  'church', 'cemaat', 'alevi', 'sunni', 'sii', 'isis', 'isid', 'daesh', 'deas', 'hacli', 'pope', 'din', 'mesih', 'hz', 'satan',
  'jew', 'jews', 'deist',
  // politics
  'rte', 'pkk', 'ypg', 'pyd', 'ypj', 'dhkp', 'dhkpc', 'hdp', 'akp', 'chp', 'mhp', 'feto', 'nazi', 'nazis', 'neonazi', 'putin',
  'trump', 'biden', 'obama', 'hamas', 'marx', 'inonu',
]);

// other alphabets, folded the same way: stems matched anywhere, short ones as words
const NATIVE_ROOTS = ['блят', 'бляд', 'сука', 'пизд', 'хуй', 'хуе', 'ебат', 'ебан', 'мудак', 'пидор', 'пидар', 'гандон', 'шлюх', 'залуп',
  'شرموط', 'منيوك', 'قحبة', 'عرص', 'كسمك'];
const NATIVE_WORDS = ['бля', 'كس', 'نيك', 'زبي'];

const LETTERS = { ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd' };
const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};
const DIGITS = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g' };

// lower case, accents and marks off (İ → i, ş → s, й → и)
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[ıßæœøđłþð]/g, (c) => LETTERS[c]);
// fuuuck → fuck
const squeeze = (s) => s.replace(/(.)\1+/g, '$1');

const ROOT_LIST = [...new Set(ROOTS.flatMap((r) => [r, squeeze(r)]).filter((r) => r.length >= 4))];
// (a squeezed word only counts when it stays long enough: ass → as would be a word)
const WORD_SQUEEZED = new Set([...WORDS].map(squeeze).filter((w) => w.length >= 3));
const NATIVE_ROOT_LIST = NATIVE_ROOTS.map(fold);
const NATIVE_WORD_SET = new Set(NATIVE_WORDS.map(fold));

function latinHits(tokens) {
  if (!tokens.length) return false;
  const run = tokens.join('');
  for (const t of [...tokens, run]) {
    const q = squeeze(t);
    if (WORDS.has(t) || WORDS.has(q) || WORD_SQUEEZED.has(q)) return true;
  }
  const q = squeeze(run);
  return ROOT_LIST.some((r) => run.includes(r) || q.includes(r));
}

// Swearing, religion or politics anywhere in the text?
export function isBlocked(text) {
  const f = fold(String(text || ''));
  if (NATIVE_ROOT_LIST.some((r) => f.includes(r))) return true;
  if (f.split(/\s+/).some((t) => NATIVE_WORD_SET.has(t))) return true;
  const latin = f.replace(/./gu, (c) => LOOKALIKE[c] || c);
  const tokens = (s) => s.split(/[^a-z0-9]+/).filter(Boolean);
  return latinHits(tokens(latin)) || latinHits(tokens(latin.replace(/[0-9]/g, (d) => DIGITS[d])));
}

const PLAYER_CHARS = /[^\p{L}\p{N} ]/gu;
const ROOM_CHARS = /[^\p{L}\p{N} '’.,!?&#+:|()\-_/]/gu;
const tidy = (s, chars, max) => Array.from(String(s || '').replace(chars, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();

// A player name as it may be shown: '' when nothing usable is left.
export function cleanPlayerName(raw) {
  const s = tidy(raw, PLAYER_CHARS, NAME_MAX);
  return s && !isBlocked(s) ? s : '';
}

// A room name as it may be listed: '' when nothing usable is left.
export function cleanRoomName(raw) {
  const s = tidy(raw, ROOM_CHARS, ROOM_NAME_MAX);
  return s && !isBlocked(s) ? s : '';
}

// What's wrong with a name typed in the editor or Create room ('' nothing):
// kind 'player' or 'room'.
export function nameProblem(raw, kind = 'player') {
  const s = String(raw || '').trim();
  const room = kind === 'room', max = room ? ROOM_NAME_MAX : NAME_MAX;
  if (!s) return room ? '' : 'Pick a name';
  if (s.replace(room ? ROOM_CHARS : PLAYER_CHARS, '') !== s) return room ? 'Letters, numbers and simple punctuation only' : 'Letters and numbers only';
  if (Array.from(s).length > max) return `At most ${max} characters`;
  if (isBlocked(s)) return 'Not allowed – no swearing, religion or politics';
  return '';
}
