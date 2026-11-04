# Scanner (to Google Drive)

A phone app for scanning receipts, letters and documents and saving them
straight into Google Drive. It's a web app you install from Chrome on Android,
so it gets its own home-screen icon and opens full screen like any other app.
It needs no app store and no Android build tools.

Planned address: **scan.thewishingstream.com** (GitHub Pages, same as the other apps).

## What it does

1. Pick a folder (**Receipts**, **Documents**, **Other**; you can change the list in Settings).
2. Tap **Scan**. The phone's own camera opens. Take the photo.
3. The app finds the edges of the page. Drag the corners to adjust if needed;
   a magnifier shows the corner under your finger.
4. **Use** flattens the page (straightens tilt and perspective). Add more pages if you need them.
5. Choose a look: **Colour**, **Enhanced** (the default: whiter paper, sharper ink) or
   **Black & white** (also removes shadows).
6. Give it a name (e.g. "Tesco") and an optional note (e.g. "£23.40 lunch"). The note
   becomes the file's Drive description, so you can search for it.
7. **Save to Drive**: a PDF (all pages in one file) or JPEGs goes to
   `My Drive › Scans › Receipts › 2026-11-04 Tesco.pdf`.

**Offline:** every scan is saved on the phone first. With no signal, it waits under
"Waiting to upload" and goes up by itself when the phone is back online.

**Privacy:** the app asks Google only for `drive.file` access. That means it can see
**only the files and folders it created itself**: nothing else in your Drive.
Nothing passes through any server of ours. The phone talks to Google directly.

## One-off setup: a Google sign-in key (about 10 minutes)

Google needs to know the app before it will let it save to your Drive. You do this
once, in Google Cloud Console, signed in with the Google account whose Drive you want to use.

1. Go to <https://console.cloud.google.com/projectcreate>. Name the project
   `Scanner` and click **Create**.
2. Turn on the Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com>, then click **Enable**.
3. Set up the consent screen: <https://console.cloud.google.com/auth/overview>, then click **Get started**.
   - App name `Scanner`, support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail, then **Create**.
   - Under **Audience › Test users**, **Add users**: your Gmail. (While the app is in
     "Testing", only listed test users can sign in. That suits a personal app.)
   - Under **Data access › Add or remove scopes**, tick `.../auth/drive.file`, then **Update**, then **Save**.
4. Make the key: <https://console.cloud.google.com/auth/clients>, then **Create client**.
   - Application type: **Web application**, name `Scanner web`.
   - **Authorised JavaScript origins**: `https://scan.thewishingstream.com`
   - **Authorised redirect URIs**: `https://scan.thewishingstream.com/`
     (with the trailing slash; Settings in the app shows the exact address it uses).
   - **Create**, then copy the **Client ID** (ends `.apps.googleusercontent.com`).
     You don't need the client secret.
5. Put the Client ID in `config.js` (it's public by design: it names the app,
   it grants nothing), or paste it in the app under **Settings**.

## Install on the phone

1. Open **https://scan.thewishingstream.com** in Chrome on Android.
2. Chrome menu (⋮), then **Add to Home screen**, then **Install**.
3. Open **Scanner** from the home screen and tap **Sign in** once.
   Google may warn "Google hasn't verified this app". That's expected for your own
   test app: **Continue**.

Sign-in lasts an hour at a time. After that, saving bounces briefly to Google and
straight back; there's nothing to type.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The screens, with a strict Content-Security-Policy (own files + Google APIs only) |
| `app.js` | Screens, crop handles and magnifier, saving, the outbox |
| `scan.js` | Pure image arithmetic: page detection, perspective flattening, filters, file names |
| `pdf.js` | A small PDF writer (one JPEG per page). No library. |
| `drive.js` | Google sign-in by redirect, Scans folders, uploads |
| `store.js` | The on-phone outbox (IndexedDB) and the recent list |
| `sw.js` | Keeps the app's files on the phone so it opens offline |
| `config.js` | The Google OAuth client ID |
| `tests/scan_test.js` | `deno run --no-config tests/scan_test.js` |

## Trying it on the Mac

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765. To sign in from there too, add `http://127.0.0.1:8765` to the
client's JavaScript origins and `http://127.0.0.1:8765/` to its redirect URIs.

## Choices

- **A web app, not a native APK.** The Mac has no Java or Android SDK. The web app
  matches how the other apps are built and hosted, and it updates by pushing to GitHub.
  The trade-off is page detection. A native app could use Google's ML Kit scanner;
  this one uses a simpler finder (the largest light patch in the photo). That works well for
  paper on a darker surface, and the corners can always be dragged.
- **Sign-in by redirect, not Google's sign-in script.** No third-party code runs on
  the page, and it works in an installed app where pop-ups are unreliable. Scans are
  in the outbox before the redirect, so nothing is lost.
