# 94 Cyprus Street — friends & family bookings

A private, password-protected "Airbnb" for the house while you're away. Family and
friends pick dates on a calendar and book for free. Every booking:

- is written to a **Google Sheet** (the booking record: who, when, email, phone, note)
- appears as an all-day event on a **Google Calendar** in your account (`94 Cyprus Street`),
  which you can overlay on your normal calendar or subscribe to from your phone
- emails **you** and **the guest** a confirmation with a cancel code

Guests can cancel themselves ("Manage my stay"), which removes the calendar event.
If you add an event to the `94 Cyprus Street` calendar yourself (e.g. "we're home"),
those dates show as unavailable on the site.

No server to run: the site is a single `index.html` on GitHub Pages and the backend
is a Google Apps Script attached to the Sheet — the same setup as the Bath trip site.

```
index.html            the site (edit the CONFIG block at the top of the <script>)
photos/               listing photos (from the 2023 sale listing; swap for your own any time)
apps-script/Code.gs   backend: Sheet + Calendar + email
dev/mock-server.js    local stand-in for the backend so you can test without Google
```

---

## 1. Set up the backend (Google Sheet + Apps Script) — ~10 minutes

1. Go to [sheets.google.com](https://sheets.google.com) and create a blank spreadsheet.
   Name it something like **"94 Cyprus Street — Bookings"**.
2. **Extensions → Apps Script**. Delete the placeholder code and paste in the whole of
   `apps-script/Code.gs`. Save.
3. **Project Settings (gear icon) → Script Properties → Add script property**:

   | Property         | Value                                                         |
   |------------------|---------------------------------------------------------------|
   | `GUEST_PASSWORD` | the shared password you'll give family & friends (required)   |
   | `OWNER_EMAIL`    | where "new booking" emails go (optional, defaults to you)     |
   | `CALENDAR_NAME`  | calendar to write stays into (optional, default `94 Cyprus Street`) |
   | `SITE_URL`       | the public site URL, used in guest emails (optional)          |
   | `MAX_NIGHTS`     | longest allowed stay (optional, default 14)                   |
   | `MAX_GUESTS`     | most guests per booking (optional, default 6)                 |

   Also in Project Settings, check the **time zone** is `Europe/London`.
4. Back in the editor, pick the function **`setup`** in the toolbar dropdown and click
   **Run**. Approve the permissions prompt (Sheets, Calendar, Mail). This creates the
   `Bookings` tab and the `94 Cyprus Street` calendar.
5. **Deploy → New deployment → gear → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click Deploy and copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

> Redeploying after code changes: **Deploy → Manage deployments → edit (pencil) →
> Version: New version → Deploy**. The URL stays the same.

## 2. Wire the site to the backend

Open `index.html` and near the top of the `<script>` set:

```js
const SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXXXXX/exec';
```

While `SCRIPT_URL` is empty the site runs in **demo mode** (password `demo`, pretend bookings)
so you can preview the design.

While you're there, edit the `HOUSE` block: description, amenities, house notes,
`showGuestNames` (whether guests see who else is coming), photos.

## 3. Publish on GitHub Pages

```bash
cd house-bookings
git init && git add . && git commit -m "House booking site"
gh repo create house-bookings --public --source=. --push
```

Repo → **Settings → Pages** → Deploy from branch `main`, folder `/ (root)`.
Optionally add a `CNAME` file with a subdomain (e.g. `stay.phel.im`) and a CNAME DNS
record pointing at `phelimb.github.io`.

The repo has to be public for free GitHub Pages, but the page itself is useless without
the password: availability and booking both go through the Apps Script, which checks the
password on every request. The `<meta name="robots" content="noindex">` keeps it out of search.

## 4. See stays on your own calendar

The `94 Cyprus Street` calendar is already in your Google account, so it shows up in
Google Calendar on the web and in the app (tick it under "My calendars").

- **Apple Calendar / iPhone**: add your Google account in Settings → Calendar → Accounts,
  and tick the `94 Cyprus Street` calendar.
- **Anything else**: Google Calendar → Settings → the calendar → *Integrate calendar* →
  copy the **Secret address in iCal format** and subscribe to it.

## Testing locally

```bash
node dev/mock-server.js
```

Then open http://localhost:8787 (password `test`). The mock backend logs bookings to the
terminal and never touches Google.

## How the pieces talk

The site POSTs JSON to the Apps Script URL with `Content-Type: text/plain`, which avoids a
CORS preflight that Apps Script can't answer. Every request carries the password; the script
rejects anything that doesn't match `GUEST_PASSWORD`. Bookings are half-open date ranges
(check-out day = next guest's check-in day is fine), and overlaps are checked inside a
script lock so two people can't grab the same night at once.
