// Local stand-in for the Apps Script backend so the site can be tested without Google.
//   node dev/mock-server.js   →  http://localhost:8787  (password: test)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PASSWORD = 'test';
const PORT = 8787;
const t = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const d = (n) => iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
let bookings = [
  { id: 'a1', name: 'Mum & Dad', email: 'mum@example.com', start: d(6), end: d(10), guests: 2, nights: 4, status: 'Confirmed', code: 'ABC123' },
  { id: 'a2', name: 'Unavailable', start: d(18), end: d(21), guests: 0, external: true },
];
const overlaps = (a, b, c, e) => a < e && c < b;
const pub = (b) => ({ id: b.id, name: b.name, start: b.start, end: b.end, guests: b.guests, nights: b.nights, external: b.external });

function handle(body) {
  if (body.password !== PASSWORD) return { ok: false, error: 'Wrong password', auth: false };
  switch (body.action) {
    case 'login': return { ok: true };
    case 'list': return { ok: true, bookings: bookings.filter((b) => b.status !== 'Cancelled').map(pub), config: { maxNights: 14, maxGuests: 6 } };
    case 'book': {
      if (!body.name || !body.email) return { ok: false, error: 'Missing name/email' };
      if (bookings.some((b) => b.status !== 'Cancelled' && overlaps(body.start, body.end, b.start, b.end))) return { ok: false, error: 'Those dates have just been taken.' };
      const id = Math.random().toString(36).slice(2, 10);
      const nights = Math.round((new Date(body.end) - new Date(body.start)) / 86400000);
      bookings.push({ id, name: body.name, email: body.email.toLowerCase(), start: body.start, end: body.end, guests: body.guests, nights, status: 'Confirmed', code: 'XYZ789' });
      console.log('BOOK', body);
      return { ok: true, id, cancelCode: 'XYZ789', start: body.start, end: body.end, nights };
    }
    case 'mine': return { ok: true, bookings: bookings.filter((b) => b.email === String(body.email).toLowerCase()).map((b) => ({ ...pub(b), status: b.status })) };
    case 'cancel': {
      const b = bookings.find((x) => x.id === body.id);
      if (!b) return { ok: false, error: 'Booking not found.' };
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
  if (file === 'index.html') html = html.toString().replace("const SCRIPT_URL = '';", `const SCRIPT_URL = 'http://localhost:${PORT}/exec';`);
  const types = { '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  res.end(html);
}).listen(PORT, () => console.log(`mock backend + site on http://localhost:${PORT}  (password: ${PASSWORD})`));
