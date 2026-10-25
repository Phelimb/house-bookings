// Local stand-in for the Apps Script backend so the site can be tested without Google.
//   node dev/mock-server.js   →  http://localhost:8787  (password: test)
// New requests print an owner review link to the terminal; emails are printed, not sent.
// Listing photos are read from private/photos/ (gitignored) if it exists.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PASSWORD = 'test';
const PORT = 8787;
const PHOTOS_DIR = path.join(__dirname, '..', 'private', 'photos');
const t = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const d = (n) => iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
let bookings = [
  { id: 'a1', name: 'Mum & Dad', email: 'mum@example.com', start: d(6), end: d(10), guests: 2, nights: 4, status: 'Confirmed', code: 'ABC123', token: 'tok-a1' },
  { id: 'a3', name: 'Sarah + kids', email: 'sarah@example.com', start: d(33), end: d(37), guests: 4, nights: 4, status: 'Requested', code: 'DEF456', token: 'tok-a3' },
  { id: 'a2', name: 'Unavailable', start: d(18), end: d(21), guests: 0, external: true },
];
const HOLDING = ['Requested', 'Confirmed'];
const holds = (b) => b.external || HOLDING.includes(b.status);
const overlaps = (a, b, c, e) => a < e && c < b;
const pub = (b) => ({ id: b.id, name: b.name, start: b.start, end: b.end, guests: b.guests, nights: b.nights, status: b.status, external: b.external });
const mail = (to, subject) => console.log(`  EMAIL → ${to}: ${subject}`);
const reviewUrl = (b) => `http://localhost:${PORT}/#review=${b.id}.${b.token}`;

function photos() {
  if (!fs.existsSync(PHOTOS_DIR)) return [];
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  return fs.readdirSync(PHOTOS_DIR).filter((f) => types[path.extname(f).toLowerCase()]).sort()
    .map((f) => `data:${types[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(path.join(PHOTOS_DIR, f)).toString('base64')}`);
}

function handle(body) {
  if (body.action === 'review' || body.action === 'decide') {
    const b = bookings.find((x) => x.id === body.id && x.token && x.token === body.token);
    if (!b) return { ok: false, error: 'This review link isn’t valid.' };
    if (body.action === 'review') return { ok: true, booking: { ...pub(b), email: b.email, phone: b.phone || '', note: b.note || '', created: b.created || '' } };
    if (b.status !== 'Requested') return { ok: false, error: `This booking is already ${b.status.toLowerCase()}.` };
    if (body.decision === 'approve') { b.status = 'Confirmed'; mail(b.email, 'You’re booked (with address + arrival details)'); }
    else if (body.decision === 'decline') { b.status = 'Declined'; mail(b.email, `About your stay request${body.message ? ` — “${body.message}”` : ''}`); }
    else return { ok: false, error: 'Unknown decision' };
    console.log('DECIDE', b.id, b.status);
    return { ok: true, status: b.status };
  }
  if (body.password !== PASSWORD) return { ok: false, error: 'Wrong password', auth: false };
  switch (body.action) {
    case 'login': return { ok: true };
    case 'list': return { ok: true, bookings: bookings.filter(holds).map(pub), config: { maxNights: 14, maxGuests: 6 } };
    case 'house': return { ok: true, house: { name: 'Test House', location: 'Testville', address: '1 Example Street, London', photos: photos() } };
    case 'book': {
      if (!body.name || !body.email) return { ok: false, error: 'Missing name/email' };
      if (bookings.some((b) => holds(b) && overlaps(body.start, body.end, b.start, b.end))) return { ok: false, error: 'Those dates have just been taken.' };
      const id = Math.random().toString(36).slice(2, 10);
      const nights = Math.round((new Date(body.end) - new Date(body.start)) / 86400000);
      const b = { id, name: body.name, email: body.email.toLowerCase(), phone: body.phone, note: body.note, start: body.start, end: body.end, guests: body.guests, nights, status: 'Requested', code: 'XYZ789', token: crypto.randomUUID().replace(/-/g, ''), created: new Date().toISOString().slice(0, 16).replace('T', ' ') };
      bookings.push(b);
      console.log('BOOK', body.name, body.start, '→', body.end);
      mail('owner', `Stay request: ${b.name}`); mail(b.email, 'Request received');
      console.log(`  review link: ${reviewUrl(b)}`);
      return { ok: true, id, cancelCode: b.code, start: body.start, end: body.end, nights, status: 'Requested' };
    }
    case 'mine': return { ok: true, bookings: bookings.filter((b) => b.email === String(body.email).toLowerCase()).map(pub) };
    case 'cancel': {
      const b = bookings.find((x) => x.id === body.id);
      if (!b) return { ok: false, error: 'Booking not found.' };
      if (!HOLDING.includes(b.status)) return { ok: false, error: `This booking was ${b.status.toLowerCase()}.` };
      if (b.code !== body.cancelCode) return { ok: false, error: 'That cancel code doesn’t match.' };
      b.status = 'Cancelled'; console.log('CANCEL', b.id);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Unknown action' };
}

http.createServer((req, res) => {
  if (req.url.startsWith('/exec')) {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let out;
      try { out = handle(JSON.parse(data)); } catch { out = { ok: false, error: 'Bad request' }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const file = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  let html = fs.readFileSync(p);
  if (file === 'index.html') html = html.toString().replace(/^const SCRIPT_URL = '[^']*';/m, `const SCRIPT_URL = 'http://localhost:${PORT}/exec';`);
  const types = { '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  res.end(html);
}).listen(PORT, () => {
  console.log(`mock backend + site on http://localhost:${PORT}  (password: ${PASSWORD})`);
  console.log(`  sample review link: ${reviewUrl(bookings[1])}`);
});
