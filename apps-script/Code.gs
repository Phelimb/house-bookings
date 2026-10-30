// House bookings API (Google Apps Script)
//
// Deploy: in a Google Sheet → Extensions → Apps Script → paste this file →
//   Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
//
// Then set Script Properties (Project Settings → Script Properties):
//   GUEST_PASSWORD    (required)  shared password you give to family & friends
//   SITE_URL          (recommended) public URL of the booking site; used for the
//                                 approve/decline link in request emails
//   OWNER_EMAIL       (optional)  where booking notifications go; defaults to you
//   CC_EMAILS         (optional)  comma-separated addresses copied on every email (owner and guest)
//   WASHING_MACHINE_URL (optional) link to washing machine instructions for the confirmation email
//   CALENDAR_NAME     (optional)  Google Calendar to write stays into; default "House guests"
//   PHOTOS_FOLDER_ID  (optional)  Google Drive folder of listing photos, shown after login
//   MAX_NIGHTS        (optional)  default 14
//   AVAILABLE_FROM    (optional)  first check-in day, YYYY-MM-DD; default 2026-11-09
//   AVAILABLE_TO      (optional)  last check-out day, YYYY-MM-DD; default 2027-03-31
//   MAX_GUESTS        (optional)  default 6
//
// Anything identifying (address, photos, key safe code) lives in the Sheet or Drive,
// never in this file or the site, because both are in a public repo:
//   "House" tab    name / location / address / description, shown on the site after login
//   "Arrival" tab  key safe code, wifi etc., for your reference (not emailed; send access details yourself)
//
// Booking statuses:
//   Requested  guest asked; dates are held until you approve or decline
//   Confirmed  you approved; it's on the calendar and the guest has been emailed
//   Declined   you said no; dates are free again
//   Cancelled  the guest withdrew or cancelled
//
// Approve or decline from the link in the request email, or select the row in the
// Bookings tab and use the "Bookings" menu. Editing the Status cell by hand does
// not send any emails.
//
// The calendar is created in your Google account if it doesn't exist. Any event
// you add to that calendar yourself (e.g. "I'm home") also blocks those dates.

const SHEET_NAME = 'Bookings';
const HOUSE_TAB = 'House';
const ARRIVAL_TAB = 'Arrival';
const HEADERS = [
  'ID', 'Created', 'Name', 'Email', 'Phone', 'Check-in', 'Check-out',
  'Nights', 'Guests', 'Note', 'Status', 'Cancel Code', 'Calendar Event ID', 'Admin Token'
];
const COL = {};
HEADERS.forEach((h, i) => (COL[h] = i));
const HOLDING = ['Requested', 'Confirmed'];   // statuses that block the dates

const HOUSE_ROWS = [
  ['Key', 'Value: shown on the site, only after the password'],
  ['name', ''],
  ['location', ''],
  ['address', ''],
  ['facts', ''],
  ['hostMeta', ''],
  ['description', ''],
];
const ARRIVAL_ROWS = [
  ['Label', 'Value: emailed only to guests you approve (blank rows are skipped)'],
  ['Key safe code', ''],
  ['Key safe location', ''],
  ['Wifi network', ''],
  ['Wifi password', ''],
  ['Getting here', ''],
  ['Anything else', ''],
];

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

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// escaped, with newlines kept
function escBr(s) {
  return esc(s).replace(/\n/g, '<br>');
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

function fmtStay(b) {
  return fmtLong(b.start) + ' → ' + fmtLong(b.end) + ' (' + b.nights + (b.nights === 1 ? ' night' : ' nights') + ')';
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
    sheet.setFrozenRows(1);
  }
  // Writes the header on a new sheet, and adds new columns to a sheet made by an older version.
  if (sheet.getRange(1, HEADERS.length).getValue() !== HEADERS[HEADERS.length - 1]) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    // Keep dates and IDs as plain text so nothing gets auto-converted.
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('F:G').setNumberFormat('@');
    sheet.getRange('L:N').setNumberFormat('@');
  }
  return sheet;
}

// A two-column Key | Value tab, created with starter rows if missing.
function kvSheet(name, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, rows.length, 2).setValues(rows);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.getRange('B:B').setNumberFormat('@').setWrap(true);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 520);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// [[key, value], ...] for rows with a value, header skipped
function readKV(name, rows) {
  const data = kvSheet(name, rows).getDataRange().getValues();
  return data.slice(1)
    .map(r => [String(r[0] || '').trim(), String(r[1] || '').trim()])
    .filter(r => r[0] && r[1]);
}

function houseInfo() {
  const out = {};
  readKV(HOUSE_TAB, HOUSE_ROWS).forEach(r => (out[r[0]] = r[1]));
  return out;
}

// Sheets and rubbish instructions for the confirmation email. There's no cleaner between guests.
// Set WASHING_MACHINE_URL in Script Properties to link to the washing machine instructions.
function housekeepingHtml() {
  const wm = prop('WASHING_MACHINE_URL', '');
  const li = t => '<li style="margin-bottom:6px">' + t + '</li>';
  return '<p><b>Looking after the house</b><br>We won’t have a cleaner, so please leave the house as you found it.</p>' +
    '<p><b>On arrival</b></p><ul>' +
      li('Please put any dirty sheets from the previous guest in the washing machine. They should be left by the washing machine in the kitchen.') +
      (wm ? li('<a href="' + esc(wm) + '">How to use the washing machine</a>') : '') +
      li('If you’re here on a rubbish collection day (Monday night for black bags, Sunday night for recycling), please check the silver bin outside the kitchen window for any rubbish from previous guests.') +
    '</ul>' +
    '<p><b>During and after your stay</b></p><ul>' +
      li('Any remaining rubbish or recycling can be left in the silver bin outside the kitchen window.') +
    '</ul>' +
    '<p><b>On departure</b></p><ul>' +
      li('Please strip the bed and leave your sheets next to the washing machine in the kitchen.') +
      li('Make the bed with the sheets you washed on arrival.') +
    '</ul>';
}

function houseName() {
  return houseInfo().name || 'the house';
}

// Listing photos as data: URIs, so they never sit at a public URL. Sorted by file name.
function photoDataUris() {
  const id = prop('PHOTOS_FOLDER_ID', '');
  if (!id) return [];
  try {
    const files = [];
    const it = DriveApp.getFolderById(id).getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (/^image\//.test(f.getMimeType())) files.push(f);
    }
    files.sort((a, b) => (a.getName() < b.getName() ? -1 : 1));
    return files.map(f => 'data:' + f.getMimeType() + ';base64,' + Utilities.base64Encode(f.getBlob().getBytes()));
  } catch (err) {
    Logger.log('Photos failed: ' + err);
    return [];
  }
}

function getCalendar() {
  const name = prop('CALENDAR_NAME', 'House guests');
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
      created: r[COL['Created']] instanceof Date ? Utilities.formatDate(r[COL['Created']], tz(), 'yyyy-MM-dd HH:mm') : String(r[COL['Created']] || ''),
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
      eventId: String(r[COL['Calendar Event ID']] || ''),
      adminToken: String(r[COL['Admin Token']] || '')
    });
  }
  return rows;
}

function holdingBookings() {
  return readBookings().filter(b => HOLDING.indexOf(b.status) >= 0);
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
      title: ev.getTitle(),
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
  return { id: b.id, name: b.name, start: b.start, end: b.end, guests: b.guests, nights: b.nights, status: b.status };
}

function sendMail(to, subject, html, attachments) {
  if (!to) return;
  const toList = String(to).toLowerCase().split(',').map(s => s.trim());
  const cc = String(prop('CC_EMAILS', '')).split(',').map(s => s.trim())
    .filter(s => s && toList.indexOf(s.toLowerCase()) === -1).join(',');
  try {
    const msg = { to: to, subject: subject, htmlBody: html, name: 'House bookings', attachments: attachments || [] };
    if (cc) msg.cc = cc;
    MailApp.sendEmail(msg);
  } catch (err) {
    Logger.log('Mail failed: ' + err);
  }
}

function ownerEmail() {
  return prop('OWNER_EMAIL', Session.getEffectiveUser().getEmail());
}

function setStatus(b, status) {
  getSheet().getRange(b.row, COL['Status'] + 1).setValue(status);
}

function icsBlob(b, address) {
  const d = s => s.replace(/-/g, '');
  const text = s => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//house-bookings//EN', 'BEGIN:VEVENT',
    'UID:' + b.id + '@house-bookings',
    'DTSTAMP:' + Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'"),
    'DTSTART;VALUE=DATE:' + d(b.start),
    'DTEND;VALUE=DATE:' + d(b.end),
    'SUMMARY:' + text('Stay at ' + houseName()),
    address ? 'LOCATION:' + text(address) : null,
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  return Utilities.newBlob(ics, 'text/calendar', 'stay.ics');
}

function cancelLine(b) {
  const site = prop('SITE_URL', '');
  return '<p>Plans changed? ' + (site ? 'Go to <a href="' + esc(site) + '">' + esc(site) + '</a>, choose “Manage my stay”' : 'Open the booking site, choose “Manage my stay”') +
    ' and use cancel code <b>' + esc(b.cancelCode) + '</b>.</p>';
}

// ---------------------------------------------------------------- approval

// Shared by the review link and the Sheet menu. Re-reads the row under the lock so
// two clicks can't both act on the same request.
function decide(id, decision, message) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const b = readBookings().find(x => x.id === id);
    if (!b) return { ok: false, error: 'Booking not found.' };
    if (b.status !== 'Requested') return { ok: false, error: 'This booking is already ' + b.status.toLowerCase() + '.', status: b.status };
    if (decision === 'approve') return approve(b);
    if (decision === 'decline') return decline(b, message);
    return { ok: false, error: 'Unknown decision' };
  } finally {
    lock.releaseLock();
  }
}

function approve(b) {
  // Requests hold their dates against other guests, but not against events you add
  // to the calendar afterwards.
  const clash = ownerBlocks(addDays(parseISO(b.start), -1), addDays(parseISO(b.end), 1))
    .find(x => overlaps(b.start, b.end, x.start, x.end));
  if (clash) {
    return { ok: false, error: 'These dates now clash with “' + clash.title + '” on your calendar (' + fmtLong(clash.start) + ' – ' + fmtLong(clash.end) + '). Move that event, or decline.' };
  }

  let eventId = '';
  try {
    const ev = getCalendar().createAllDayEvent(
      b.name + ' staying (' + b.guests + (b.guests === 1 ? ' guest' : ' guests') + ')',
      parseISO(b.start),
      parseISO(b.end),
      { description: 'Booked via the house site.\nEmail: ' + b.email + (b.phone ? '\nPhone: ' + b.phone : '') + (b.note ? '\nNote: ' + b.note : '') + '\nBooking ID: ' + b.id }
    );
    eventId = ev.getId();
  } catch (err) {
    Logger.log('Calendar failed: ' + err);
  }
  setStatus(b, 'Confirmed');
  getSheet().getRange(b.row, COL['Calendar Event ID'] + 1).setValue(eventId);

  const house = houseInfo();
  sendMail(
    b.email,
    'You’re booked: ' + fmtLong(b.start) + ' → ' + fmtLong(b.end),
    '<p>Hi ' + esc(b.name.split(' ')[0]) + ',</p>' +
      '<p>Good news: your stay at ' + esc(house.name || 'the house') + ' is confirmed.</p>' +
      '<p><b>' + fmtStay(b) + '</b><br>Guests: ' + b.guests + '</p>' +
      (house.address ? '<p><b>Address</b><br>' + escBr(house.address) + '</p>' : '') +
      '<p><b>Getting in</b><br>More details on access will follow closer to your stay.</p>' +
      housekeepingHtml() +
      '<p>A calendar file is attached.</p>' +
      cancelLine(b),
    [icsBlob(b, house.address)]
  );
  return { ok: true, status: 'Confirmed' };
}

function decline(b, message) {
  setStatus(b, 'Declined');
  const msg = String(message || '').trim().slice(0, 1000);
  const site = prop('SITE_URL', '');
  sendMail(
    b.email,
    'About your stay request: ' + fmtLong(b.start) + ' → ' + fmtLong(b.end),
    '<p>Hi ' + esc(b.name.split(' ')[0]) + ',</p>' +
      '<p>Thanks so much for asking. Unfortunately the house isn’t available for ' + fmtStay(b) + ', so we can’t confirm this one.</p>' +
      (msg ? '<blockquote style="border-left:3px solid #ddd;margin:0;padding:4px 12px;color:#444">' + escBr(msg) + '</blockquote>' : '') +
      '<p>We’d love to have you another time' + (site ? ': other dates are on <a href="' + esc(site) + '">the booking site</a>.' : '.') + '</p>'
  );
  return { ok: true, status: 'Declined' };
}

function reviewLink(b) {
  const site = prop('SITE_URL', '');
  return site ? site.replace(/#.*$/, '') + '#review=' + b.id + '.' + b.adminToken : '';
}

// ---------------------------------------------------------------- actions

// The window the house can be booked in: check-in on or after `from`, check-out on or before `to`.
function availability() {
  return {
    from: prop('AVAILABLE_FROM', '2026-11-09'),
    to: prop('AVAILABLE_TO', '2027-03-31')
  };
}

function actionList() {
  const from = addDays(today(), -60);
  const to = addDays(today(), 400);
  const bookings = holdingBookings()
    .filter(b => b.end >= toISO(from))
    .map(publicView);
  const blocks = ownerBlocks(from, to).map(x => ({ id: x.id, name: x.name, start: x.start, end: x.end, guests: 0, external: true }));
  return {
    ok: true,
    bookings: bookings.concat(blocks),
    config: {
      maxNights: Number(prop('MAX_NIGHTS', 14)),
      maxGuests: Number(prop('MAX_GUESTS', 6)),
      availableFrom: availability().from,
      availableTo: availability().to
    }
  };
}

function actionHouse() {
  const house = houseInfo();
  house.photos = photoDataUris();
  return { ok: true, house: house };
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
  const win = availability();
  if (toISO(start) < win.from || toISO(end) > win.to) {
    return { ok: false, error: 'The house is only available from ' + fmtLong(win.from) + ' to ' + fmtLong(win.to) + '.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sIso = toISO(start), eIso = toISO(end);
    const taken = holdingBookings().map(publicView).concat(ownerBlocks(addDays(start, -1), addDays(end, 1)));
    const clash = taken.find(b => overlaps(sIso, eIso, b.start, b.end));
    if (clash) {
      return { ok: false, error: 'Those dates have just been taken (' + fmtLong(clash.start) + ' – ' + fmtLong(clash.end) + '). Please choose different dates.' };
    }

    const b = {
      id: Utilities.getUuid().slice(0, 8),
      name: name, email: email, phone: phone, note: note, guests: guests,
      start: sIso, end: eIso, nights: nights,
      cancelCode: randomCode(),
      adminToken: Utilities.getUuid().replace(/-/g, '')
    };
    // The calendar event is only created once you approve.
    getSheet().appendRow([
      b.id, Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm'),
      name, email, phone, sIso, eIso, nights, guests, note, 'Requested', b.cancelCode, '', b.adminToken
    ]);

    const link = reviewLink(b);
    sendMail(
      ownerEmail(),
      'Stay request: ' + name + ', ' + fmtLong(sIso),
      '<p><b>' + esc(name) + '</b> would like to stay.</p>' +
        '<p>' + fmtStay(b) + '<br>Guests: ' + guests + '<br>Email: ' + esc(email) + (phone ? '<br>Phone: ' + esc(phone) : '') + '</p>' +
        (note ? '<p>Note: ' + escBr(note) + '</p>' : '') +
        (link ? '<p><a href="' + esc(link) + '" style="display:inline-block;background:#222;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Review: approve or decline</a></p>' : '') +
        '<p style="color:#888">' + (link ? 'Or in' : 'To answer, open') + ' the bookings Sheet, select the row, then <b>Bookings → Approve / Decline selected request</b>. ' +
        'The dates are held until you answer. Booking ID ' + b.id + '.</p>'
    );
    sendMail(
      email,
      'Request received: ' + fmtLong(sIso) + ' → ' + fmtLong(eIso),
      '<p>Hi ' + esc(name.split(' ')[0]) + ',</p>' +
        '<p>Thanks! We’ve got your request to stay:</p>' +
        '<p><b>' + fmtStay(b) + '</b><br>Guests: ' + guests + '</p>' +
        '<p>The dates are held for you. You’ll get another email once it’s confirmed, with the address.</p>' +
        cancelLine(b)
    );

    return { ok: true, id: b.id, cancelCode: b.cancelCode, start: sIso, end: eIso, nights: nights, status: 'Requested' };
  } finally {
    lock.releaseLock();
  }
}

function actionMine(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Enter the email you booked with.' };
  const mine = readBookings()
    .filter(b => b.email === email)
    .map(publicView)
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  return { ok: true, bookings: mine };
}

function actionCancel(body) {
  const id = String(body.id || '');
  const code = String(body.cancelCode || '').trim().toUpperCase();
  const b = readBookings().find(x => x.id === id);
  if (!b) return { ok: false, error: 'Booking not found.' };
  if (b.status === 'Cancelled') return { ok: true, alreadyCancelled: true };
  if (HOLDING.indexOf(b.status) < 0) return { ok: false, error: 'This booking was ' + b.status.toLowerCase() + '.' };
  if (!code || code !== b.cancelCode) return { ok: false, error: 'That cancel code doesn’t match.' };

  const wasRequest = b.status === 'Requested';
  setStatus(b, 'Cancelled');
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
    (wasRequest ? 'Request withdrawn: ' : 'Cancelled: ') + b.name + ', ' + fmtLong(b.start),
    '<p><b>' + esc(b.name) + '</b> ' + (wasRequest ? 'withdrew their request for ' : 'cancelled their stay ') + fmtLong(b.start) + ' → ' + fmtLong(b.end) + '.</p>'
  );
  sendMail(
    b.email,
    (wasRequest ? 'Request withdrawn: ' : 'Your stay is cancelled: ') + fmtLong(b.start) + ' → ' + fmtLong(b.end),
    '<p>Hi ' + esc(b.name.split(' ')[0]) + ', your ' + (wasRequest ? 'request to stay' : 'stay') + ' (' + fmtLong(b.start) + ' → ' + fmtLong(b.end) + ') has been cancelled. Book again any time.</p>'
  );
  return { ok: true };
}

// The owner's review link carries a per-booking token instead of the guest password.
function bookingForToken(body) {
  const b = readBookings().find(x => x.id === String(body.id || ''));
  if (!b || !b.adminToken || String(body.token || '') !== b.adminToken) return null;
  return b;
}

function actionReview(body) {
  const b = bookingForToken(body);
  if (!b) return { ok: false, error: 'This review link isn’t valid.' };
  return {
    ok: true,
    booking: Object.assign(publicView(b), { email: b.email, phone: b.phone, note: b.note, created: b.created })
  };
}

function actionDecide(body) {
  const b = bookingForToken(body);
  if (!b) return { ok: false, error: 'This review link isn’t valid.' };
  return decide(b.id, body.decision, body.message);
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

  try {
    if (body.action === 'review') return json(actionReview(body));
    if (body.action === 'decide') return json(actionDecide(body));

    const expected = prop('GUEST_PASSWORD', '');
    if (!expected) return json({ ok: false, error: 'GUEST_PASSWORD is not set in Script Properties.' });
    if (String(body.password || '') !== expected) return json({ ok: false, error: 'Wrong password', auth: false });

    switch (body.action) {
      case 'login':  return json({ ok: true });
      case 'list':   return json(actionList());
      case 'house':  return json(actionHouse());
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

// ---------------------------------------------------------------- Sheet menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bookings')
    .addItem('Approve selected request', 'approveSelected')
    .addItem('Decline selected request', 'declineSelected')
    .addToUi();
}

function selectedBooking(ui) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveRange().getRow();
  const b = sheet.getName() === SHEET_NAME ? readBookings().find(x => x.row === row) : null;
  if (!b) ui.alert('Select a booking row on the ' + SHEET_NAME + ' tab first.');
  return b;
}

function approveSelected() {
  const ui = SpreadsheetApp.getUi();
  const b = selectedBooking(ui);
  if (!b) return;
  if (ui.alert('Approve ' + b.name + ', ' + fmtStay(b) + '?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const r = decide(b.id, 'approve');
  ui.alert(r.ok ? 'Approved. ' + b.name + ' has been emailed the confirmation. Send them access details separately.' : r.error);
}

function declineSelected() {
  const ui = SpreadsheetApp.getUi();
  const b = selectedBooking(ui);
  if (!b) return;
  const res = ui.prompt('Decline ' + b.name + ', ' + fmtStay(b) + '?', 'Optional message to include in the email:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const r = decide(b.id, 'decline', res.getResponseText());
  ui.alert(r.ok ? 'Declined. ' + b.name + ' has been emailed.' : r.error);
}

// Run once from the editor to grant Calendar/Mail/Sheets/Drive permissions and
// create the tabs + calendar up front.
function setup() {
  getSheet();
  kvSheet(HOUSE_TAB, HOUSE_ROWS);
  kvSheet(ARRIVAL_TAB, ARRIVAL_ROWS);
  getCalendar();
  photoDataUris();
  Logger.log('Ready. Calendar: ' + getCalendar().getName() + ' · owner email: ' + ownerEmail() +
    ' · review links: ' + (prop('SITE_URL', '') ? 'on' : 'off (set SITE_URL)'));
}
