// Developer mode: people online over time and where (the Worker's stats,
// cloud/src/lobby.js). Sampled every 10 minutes, counted where each room's
// host is; only counts. The chart is one series – people online, an hour a
// bar (a day a bar over 30 days) – with the hour's peak in its tooltip; the
// tables are its table view.

const CONTINENT_NAMES = { AF: 'Africa', AN: 'Antarctica', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const H = 3.6e6;

// the hours (or days) from the first sample to now, gaps left empty
function buckets(hours, days) {
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const now = Date.now(), daily = days > 7;
  const step = daily ? 24 * H : H;
  const start = Math.floor((now - days * 24 * H) / step) * step;
  const out = [];
  for (let t = start; t <= now; t += step) {
    if (!daily) { out.push({ t, ...(byHour.get(new Date(t).toISOString().slice(0, 13)) || {}) }); continue; }
    // a day: its hours' average and the highest peak
    const hs = [];
    for (let u = t; u < t + step; u += H) { const h = byHour.get(new Date(u).toISOString().slice(0, 13)); if (h) hs.push(h); }
    out.push(hs.length ? { t, avg: Math.round((hs.reduce((a, h) => a + h.avg, 0) / hs.length) * 10) / 10, peak: Math.max(...hs.map((h) => h.peak)), rooms: Math.round((hs.reduce((a, h) => a + h.rooms, 0) / hs.length) * 10) / 10 } : { t });
  }
  return { list: out, daily };
}

function chart(hours, days) {
  const { list, daily } = buckets(hours, days);
  const W = 720, Hh = 180, padL = 34, padB = 22, padT = 8;
  const top = Math.max(4, ...list.map((b) => b.avg || 0));
  const nice = top <= 5 ? 5 : top <= 10 ? 10 : Math.ceil(top / 10) * 10;
  const bw = (W - padL) / list.length, gap = bw >= 6 ? 2 : bw >= 3 ? 1 : 0;
  const y = (v) => padT + (Hh - padT - padB) * (1 - v / nice);
  const grid = [0, nice / 2, nice].map((v) => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="sgrid"/><text x="${padL - 6}" y="${y(v) + 4}" class="saxis" text-anchor="end">${v}</text>`).join('');
  const fmt = (t) => new Date(t).toLocaleString(undefined, daily ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const bars = list.map((b, i) => {
    const x = padL + i * bw + gap / 2, w = Math.max(1, bw - gap);
    const tip = b.avg === undefined ? `${fmt(b.t)} · no samples` : `${fmt(b.t)} · ${b.avg} online on average, peak ${b.peak} · ${b.rooms} rooms`;
    const bar = b.avg ? `<path d="M${x},${y(0)} V${y(b.avg) + Math.min(4, w / 2)} q0,-${Math.min(4, w / 2)} ${Math.min(4, w / 2)},-${Math.min(4, w / 2)} H${x + w - Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, w / 2)} V${y(0)} Z" class="sbar"/>` : '';
    // (the hit target is the whole column, bigger than the bar)
    return `<g class="scol" data-tip="${esc(tip)}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${Hh - padT - padB}" class="shit"/>${bar}</g>`;
  }).join('');
  // a few time labels along the bottom
  const every = Math.ceil(list.length / 6);
  const labels = list.map((b, i) => (i % every ? '' : `<text x="${padL + i * bw + bw / 2}" y="${Hh - 6}" class="saxis" text-anchor="middle">${esc(new Date(b.t).toLocaleString(undefined, daily ? { day: 'numeric', month: 'short' } : days > 1 ? { weekday: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' }))}</text>`)).join('');
  return `<svg viewBox="0 0 ${W} ${Hh}" class="schart" role="img" aria-label="People online ${daily ? 'per day' : 'per hour'}">${grid}${bars}${labels}</svg>`;
}

function table(title, rows, label) {
  const body = rows.length ? rows.slice(0, 15).map(([p, n]) => `<tr><td>${label(p)}</td><td class="n">${n}</td></tr>`).join('') : '<tr><td class="muted">–</td><td></td></tr>';
  return `<div class="stab"><h4>${title}</h4><table><thead><tr><th></th><th class="n">online</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderStats(el, data, days) {
  const avg = data.hours.length ? Math.round((data.hours.reduce((a, h) => a + h.avg, 0) / data.hours.length) * 10) / 10 : 0;
  const peak = data.hours.reduce((a, h) => Math.max(a, h.peak), 0);
  el.innerHTML = !data.samples
    ? '<p class="muted">No samples yet – the Worker counts who\'s online every 10 minutes.</p>'
    : `<div class="stiles"><div><b>${avg}</b><span>online on average</span></div><div><b>${peak}</b><span>at the busiest</span></div><div><b>${data.samples}</b><span>samples</span></div></div>
      ${chart(data.hours, days)}
      <div class="stabs">
        ${table('Continents', data.places.continent, (p) => esc(CONTINENT_NAMES[p] || 'Unknown'))}
        ${table('Countries', data.places.country, (p) => (p === '?' ? 'Unknown' : `${flag(p)} ${esc(p)}`))}
        ${table('Cities', data.places.city, (p) => { const [cc, city] = p.split(' · '); return `${flag(cc)} ${esc(city === '?' ? 'Unknown' : city)}`; })}
      </div>`;
}
