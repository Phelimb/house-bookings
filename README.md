# Friends & family house bookings

A private, password-protected "Airbnb" for the house while you're away. Family and
friends pick dates on a calendar and **request** a stay for free; you approve or decline.

1. A guest sends a request. It's saved as **Requested** in a **Google Sheet** and the dates
   are held. The guest gets a "request received" email, and you get an email with their
   details and a **Review** button.
2. You **approve** (from the email link, or the Sheet's **Bookings** menu). The stay goes onto
   a **Google Calendar** in your account, and the guest gets a confirmation with the address,
   the key safe code and arrival details, plus a calendar file.
3. Or you **decline**, with an optional message. The guest gets a polite email and the dates free up.

Guests can withdraw a request or cancel a stay themselves ("Manage my stay") with the
cancel code from their email. If you add an event to the bookings calendar yourself
(e.g. "we're home"), those dates show as unavailable.

No server to run: the site is a single `index.html` on GitHub Pages and the backend
is a Google Apps Script attached to the Sheet.

```
index.html            the site (edit the CONFIG block at the top of the <script>)
apps-script/Code.gs   backend: Sheet + Calendar + email + Drive photos
dev/mock-server.js    local stand-in for the backend so you can test without Google
private/              gitignored: listing photos to upload to Drive
```

### What's public and what isn't

The repo and `index.html` are public, so they contain nothing that identifies the house.
Identifying details live in your Google account and are only sent once someone enters
the password:

| Where                          | What                                                        | Who sees it                  |
|--------------------------------|-------------------------------------------------------------|------------------------------|
| `index.html`                   | generic description, amenities, house notes                 | anyone                       |
| Sheet → **House** tab          | name, location, address (and map), description              | anyone with the password     |
| Drive photos folder            | listing photos                                              | anyone with the password     |
| Sheet → **Arrival** tab        | key safe code, wifi, directions…                            | only guests you approve, by email |

---

## 1. Set up the backend (Google Sheet + Apps Script), about 15 minutes

1. Go to [sheets.google.com](https://sheets.google.com) and create a blank spreadsheet,
   e.g. **"House bookings"**.
2. **Extensions → Apps Script**. Delete the placeholder code and paste in the whole of
   `apps-script/Code.gs`. Save.
3. **Project Settings (gear icon) → Script Properties → Add script property**:

   | Property           | Value                                                                   |
   |--------------------|-------------------------------------------------------------------------|
   | `GUEST_PASSWORD`   | the shared password you'll give family & friends (required)             |
   | `SITE_URL`         | the public site URL (needed for the Review button in request emails)    |
   | `PHOTOS_FOLDER_ID` | ID of a Drive folder of listing photos (optional, see below)            |
   | `OWNER_EMAIL`      | where request emails go (optional, defaults to you)                     |
   | `CALENDAR_NAME`    | calendar to write stays into (optional, default `House guests`)         |
   | `MAX_NIGHTS`       | longest allowed stay (optional, default 14)                             |
   | `MAX_GUESTS`       | most guests per booking (optional, default 6)                           |

   Also in Project Settings, check the **time zone** is `Europe/London`.
4. Back in the editor, pick the function **`setup`** in the toolbar dropdown and click
   **Run**. Approve the permissions prompt (Sheets, Calendar, Mail, Drive). This creates the
   `Bookings`, `House` and `Arrival` tabs and the bookings calendar.
5. Fill in the **House** tab (column B). Leave a row blank to keep the generic text from `index.html`:
   - `name` – shown as the title, e.g. the street address
   - `location` – e.g. the neighbourhood and city
   - `address` – full address; also drives the map
   - `facts`, `hostMeta`, `description` – optional overrides. Separate description
     paragraphs with a blank line (Ctrl/⌘+Enter for a new line in a cell).
6. Fill in the **Arrival** tab: key safe code, wifi, etc. Blank rows are left out of the email,
   and you can add your own rows.
7. **Photos** (optional): upload the files from `private/photos/` (or your own) to a Drive
   folder. Photos are shown in filename order, and the first is the big one. Copy the folder ID
   from its URL (`drive.google.com/drive/folders/<ID>`) into `PHOTOS_FOLDER_ID`. Keep them
   small (~1600px wide, ≤300 KB each); they're sent to the browser after login.
8. **Deploy → New deployment → gear → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click Deploy and copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
9. Reload the Sheet: a **Bookings** menu appears (that's the `onOpen` function).

> Redeploying after code changes: **Deploy → Manage deployments → edit (pencil) →
> Version: New version → Deploy**. The URL stays the same.

## 2. Wire the site to the backend

Open `index.html` and near the top of the `<script>` set:

```js
const SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXXXXX/exec';
```

While `SCRIPT_URL` is empty the site runs in **demo mode** (password `demo`, pretend bookings)
so you can preview the design.

While you're there, edit the `HOUSE` block: generic description, amenities, house notes,
`showGuestNames` (whether guests see who else is coming). Don't put the address or anything
identifying there. That goes in the House tab.

## 3. Publish on GitHub Pages

The Pages URL is `https://<you>.github.io/<repo-name>/`, so the repo has a **random,
non-obvious name** (`r7x2k`) rather than `house-bookings`. That makes the link unlisted:
only people you send it to will find it.

```bash
gh repo create r7x2k --public --source=. --push
```

Repo → **Settings → Pages** → Deploy from branch `main`, folder `/ (root)`. The site is then at:

**https://phelimb.github.io/r7x2k/**

Set `SITE_URL` in Script Properties to exactly that, including the trailing slash. Guest emails
link to it, and the owner Review button is `SITE_URL#review=…`. The site uses only relative
paths, so it works under `/r7x2k/` without changes. The local mock server serves it from `/`,
which is fine too.

How far the obscure name gets you:

- **It stops guessing, not browsing.** A public repo is listed on your GitHub profile, so anyone
  who looks at your profile can see it and work out the Pages URL. If that matters, create the
  repo under a separate GitHub account or organisation that isn't linked to you.
- **The password is the real protection.** The address, map, photos and guest list only load
  after the password, and the key safe code only goes out by email to guests you approve.
  The public page and repo show nothing that identifies the house.
- **A custom domain undoes it.** Adding a `CNAME` file (e.g. `stay.example.com`) makes GitHub
  redirect the obscure URL to that domain, and the domain is easy to guess. Skip it if the
  point is to stay unlisted.
- The repo has to be public for free GitHub Pages. The `<meta name="robots" content="noindex">`
  keeps the page out of search engines.

## 4. Approving requests

- **From the email:** click **Review** and you'll see the request on the site with Approve/Decline
  buttons. The link has a secret token for that one booking, so don't forward it.
- **From the Sheet:** click any cell in the booking's row on the `Bookings` tab, then
  **Bookings → Approve selected request** or **Decline selected request**.

Changing the Status cell by hand does *not* send emails or touch the calendar, so use one of the above.
Requests hold their dates until you answer, so answer old ones (or decline them) to free the dates up.

## 5. See stays on your own calendar

The bookings calendar is in your Google account, so it shows up in Google Calendar on the web
and in the app (tick it under "My calendars"). Only approved stays are added.

- **Apple Calendar / iPhone**: add your Google account in Settings → Calendar → Accounts,
  and tick the calendar.
- **Anything else**: Google Calendar → Settings → the calendar → *Integrate calendar* →
  copy the **Secret address in iCal format** and subscribe to it.

## Testing locally

```bash
node dev/mock-server.js
```

Then open http://localhost:8787 (password `test`). The mock backend prints emails and owner
review links to the terminal and never touches Google. It shows photos from `private/photos/`.

## How the pieces talk

The site POSTs JSON to the Apps Script URL with `Content-Type: text/plain`, which avoids a
CORS preflight that Apps Script can't answer. Guest requests carry the password; the script
rejects anything that doesn't match `GUEST_PASSWORD`. The owner's `review`/`decide` requests
carry the per-booking token from the review link instead. Bookings are half-open date ranges
(check-out day = next guest's check-in day is fine), and overlaps and approvals run inside a
script lock so two people can't grab the same night at once.
