// 94 Cyprus Street — Bookings API (Google Apps Script)
//
// Deploy: in a Google Sheet → Extensions → Apps Script → paste this file →
//   Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
//
// Then set Script Properties (Project Settings → Script Properties):
//   GUEST_PASSWORD  (required)  shared password you give to family & friends
//   OWNER_EMAIL     (optional)  where booking notifications go; defaults to you
//   CALENDAR_NAME   (optional)  Google Calendar to write stays into; default "94 Cyprus Street"
//   SITE_URL        (optional)  public URL of the booking site, used in emails
//   MAX_NIGHTS      (optional)  default 14
//   MAX_GUESTS      (optional)  default 6
//
// The calendar is created in your Google account if it doesn't exist. Any event
// you add to that calendar yourself (e.g. "I'm home") also blocks those dates.

const SHEET_NAME = 'Bookings';
const HEADERS = [
  'ID', 'Created', 'Name', 'Email', 'Phone', 'Check-in', 'Check-out',
  'Nights', 'Guests', 'Note', 'Status', 'Cancel Code', 'Calendar Event ID'
];
const COL = {};
HEADERS.forEach((h, i) => (COL[h] = i));

// ---------------------------------------------------------------- helpers

function prop(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function tz() {
  return Session.getScriptTimeZone();
}

// 'YYYY-MM-DD' -> Date at local midnight
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Date | string -> 'YYYY-MM-DD'
function toISO(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function nightsBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function fmtLong(iso) {
  return Utilities.formatDate(parseISO(iso), tz(), 'EEE d MMM yyyy');
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Keep dates and IDs as plain text so nothing gets auto-converted.
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('F:G').setNumberFormat('@');
    sheet.getRange('L:M').setNumberFormat('@');
  }
  return sheet;
}

function getCalendar() {
  const name = prop('CALENDAR_NAME', '94 Cyprus Street');
  const found = CalendarApp.getCalendarsByName(name);
  if (found.length) return found[0];
  return CalendarApp.createCalendar(name, {
    summary: 'Family & friends staying at the house',
    color: CalendarApp.Color.TEAL
  });
}

function readBookings() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[COL['ID']]) continue;
    rows.push({
      row: i + 1,
      id: String(r[COL['ID']]),
      created: toISO(r[COL['Created']]),
      name: String(r[COL['Name']] || ''),
      email: String(r[COL['Email']] || '').trim().toLowerCase(),
      phone: String(r[COL['Phone']] || ''),
      start: toISO(r[COL['Check-in']]),
      end: toISO(r[COL['Check-out']]),
      nights: Number(r[COL['Nights']] || 0),
      guests: Number(r[COL['Guests']] || 1),
      note: String(r[COL['Note']] || ''),
      status: String(r[COL['Status']] || 'Confirmed'),
      cancelCode: String(r[COL['Cancel Code']] || ''),
      eventId: String(r[COL['Calendar Event ID']] || '')
    });
  }
  return rows;
}

function activeBookings() {
  return readBookings().filter(b => b.status === 'Confirmed');
}

// Events on the calendar that weren't created by a booking (owner blocks).
function ownerBlocks(from, to) {
  const known = {};
  readBookings().forEach(b => { if (b.eventId) known[b.eventId] = true; });
  const out = [];
  let events = [];
  try {
    events = getCalendar().getEvents(from, to);
  } catch (err) {
    return out;
  }
  events.forEach(ev => {
    if (known[ev.getId()]) return;
    let start, end;
    if (ev.isAllDayEvent()) {
      start = ev.getAllDayStartDate();
      end = ev.getAllDayEndDate();
    } else {
      const s = ev.getStartTime();
      const e = ev.getEndTime();
      start = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      end = new Date(e.getFullYear(), e.getMonth(), e.getDate());
      if (end <= start) end = addDays(start, 1);
    }
    out.push({
      id: 'cal-' + ev.getId(),
      name: 'Unavailable',
      start: toISO(start),
      end: toISO(end),
      guests: 0,
      external: true
    });
  });
  return out;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // half-open ranges [start, end): checkout day == someone else's check-in is fine
  return aStart < bEnd && bStart < aEnd;
}

function publicView(b) {
  return { id: b.id, name: b.name, start: b.start, end: b.end, guests: b.guests, nights: b.nights };
}

function sendMail(to, subject, html) {
  if (!to) return;
  try {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: 'House bookings' });
  } catch (err) {
    Logger.log('Mail failed: ' + err);
  }
}

function ownerEmail() {
  return prop('OWNER_EMAIL', Session.getEffectiveUser().getEmail());
}

// ---------------------------------------------------------------- actions

function actionList() {
  const from = addDays(today(), -60);
  const to = addDays(today(), 400);
  const bookings = activeBookings()
    .filter(b => b.end >= toISO(from))
    .map(publicView);
  const blocks = ownerBlocks(from, to);
  return {
    ok: true,
    bookings: bookings.concat(blocks),
    config: {
      maxNights: Number(prop('MAX_NIGHTS', 14)),
      maxGuests: Number(prop('MAX_GUESTS', 6))
    }
  };
}

function actionBook(body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const note = String(body.note || '').trim().slice(0, 1000);
  const guests = Math.max(1, Math.min(Number(body.guests || 1), Number(prop('MAX_GUESTS', 6))));
  const start = parseISO(body.start);
  const end = parseISO(body.end);

  if (!name || name.length > 80) return { ok: false, error: 'Please enter your name.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Please enter a valid email.' };
  if (!start || !end) return { ok: false, error: 'Please pick check-in and check-out dates.' };
  if (start < today()) return { ok: false, error: 'Check-in can’t be in the past.' };
  const nights = nightsBetween(start, end);
  if (nights < 1) return { ok: false, error: 'Check-out must be after check-in.' };
  const maxNights = Number(prop('MAX_NIGHTS', 14));
  if (nights > maxNights) return { ok: false, error: 'Stays are limited to ' + maxNights + ' nights.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sIso = toISO(start), eIso = toISO(end);
    const taken = activeBookings().map(publicView).concat(ownerBlocks(addDays(start, -1), addDays(end, 1)));
    const clash = taken.find(b => overlaps(sIso, eIso, b.start, b.end));
    if (clash) {
      return { ok: false, error: 'Those dates have just been taken (' + fmtLong(clash.start) + ' – ' + fmtLong(clash.end) + '). Please choose different dates.' };
    }

    const id = Utilities.getUuid().slice(0, 8);
    const cancelCode = randomCode();
    let eventId = '';
    try {
      const ev = getCalendar().createAllDayEvent(
        name + ' staying (' + guests + (guests === 1 ? ' guest' : ' guests') + ')',
        start,
        end,
        { description: 'Booked via the house site.\nEmail: ' + email + (phone ? '\nPhone: ' + phone : '') + (note ? '\nNote: ' + note : '') + '\nBooking ID: ' + id }
      );
      eventId = ev.getId();
    } catch (err) {
      Logger.log('Calendar failed: ' + err);
    }

    getSheet().appendRow([
      id, Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm'),
      name, email, phone, sIso, eIso, nights, guests, note, 'Confirmed', cancelCode, eventId
    ]);

    const site = prop('SITE_URL', '');
    const when = fmtLong(sIso) + ' → ' + fmtLong(eIso) + ' (' + nights + (nights === 1 ? ' night' : ' nights') + ')';
    sendMail(
      ownerEmail(),
      'New stay: ' + name + ', ' + fmtLong(sIso),
      '<p><b>' + name + '</b> has booked the house.</p>' +
        '<p>' + when + '<br>Guests: ' + guests + '<br>Email: ' + email + (phone ? '<br>Phone: ' + phone : '') + '</p>' +
        (note ? '<p>Note: ' + note + '</p>' : '') +
        '<p style="color:#888">Booking ID ' + id + ' · it’s on your “' + prop('CALENDAR_NAME', '94 Cyprus Street') + '” calendar.</p>'
    );
    sendMail(
      email,
      'You’re booked: ' + fmtLong(sIso) + ' → ' + fmtLong(eIso),
      '<p>Hi ' + name.split(' ')[0] + ',</p>' +
        '<p>You’re all set to stay at 94 Cyprus Street.</p>' +
        '<p><b>' + when + '</b><br>Guests: ' + guests + '</p>' +
        '<p>Need to cancel? ' + (site ? 'Go to <a href="' + site + '">' + site + '</a>, choose “Manage my stay”' : 'Open the booking site, choose “Manage my stay”') + ' and use cancel code <b>' + cancelCode + '</b>.</p>'
    );

    return { ok: true, id: id, cancelCode: cancelCode, start: sIso, end: eIso, nights: nights };
  } finally {
    lock.releaseLock();
  }
}

function actionMine(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Enter the email you booked with.' };
  const mine = readBookings()
    .filter(b => b.email === email)
    .map(b => Object.assign(publicView(b), { status: b.status }))
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  return { ok: true, bookings: mine };
}

function actionCancel(body) {
  const id = String(body.id || '');
  const code = String(body.cancelCode || '').trim().toUpperCase();
  const b = readBookings().find(x => x.id === id);
  if (!b) return { ok: false, error: 'Booking not found.' };
  if (b.status !== 'Confirmed') return { ok: true, alreadyCancelled: true };
  if (!code || code !== b.cancelCode) return { ok: false, error: 'That cancel code doesn’t match.' };

  const sheet = getSheet();
  sheet.getRange(b.row, COL['Status'] + 1).setValue('Cancelled');
  if (b.eventId) {
    try {
      const ev = getCalendar().getEventById(b.eventId);
      if (ev) ev.deleteEvent();
    } catch (err) {
      Logger.log('Calendar delete failed: ' + err);
    }
  }
  sendMail(
    ownerEmail(),
    'Cancelled: ' + b.name + ', ' + fmtLong(b.start),
    '<p><b>' + b.name + '</b> cancelled their stay ' + fmtLong(b.start) + ' → ' + fmtLong(b.end) + '.</p>'
  );
  sendMail(
    b.email,
    'Your stay is cancelled: ' + fmtLong(b.start) + ' → ' + fmtLong(b.end),
    '<p>Hi ' + b.name.split(' ')[0] + ', your stay at 94 Cyprus Street (' + fmtLong(b.start) + ' → ' + fmtLong(b.end) + ') has been cancelled. Book again any time.</p>'
  );
  return { ok: true };
}

// ---------------------------------------------------------------- entry points

function doGet() {
  return json({ ok: true, service: 'house-bookings', hint: 'POST JSON {password, action, ...}' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Bad request' });
  }

  const expected = prop('GUEST_PASSWORD', '');
  if (!expected) return json({ ok: false, error: 'GUEST_PASSWORD is not set in Script Properties.' });
  if (String(body.password || '') !== expected) return json({ ok: false, error: 'Wrong password', auth: false });

  try {
    switch (body.action) {
      case 'login':  return json({ ok: true });
      case 'list':   return json(actionList());
      case 'book':   return json(actionBook(body));
      case 'mine':   return json(actionMine(body));
      case 'cancel': return json(actionCancel(body));
      default:       return json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    Logger.log(err);
    return json({ ok: false, error: 'Something went wrong: ' + err.message });
  }
}

// Run once from the editor to grant Calendar/Mail/Sheets permissions and
// create the sheet + calendar up front.
function setup() {
  getSheet();
  getCalendar();
  Logger.log('Ready. Calendar: ' + getCalendar().getName() + ' · owner email: ' + ownerEmail());
}
