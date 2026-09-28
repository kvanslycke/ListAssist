# Google Calendar setup

The plugin talks to Google Calendar with **your own** OAuth 2.0
Desktop client — no shared credentials, no third-party relay.
Setup takes ~5 minutes, once per Google account. The refresh token
lives in the plugin's data file inside your vault and rides Obsidian
Sync to your other devices.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the
   Google account whose calendar you want to sync.
2. Top-left, click the project picker → **New Project**. Name it
   something like `list-assistant`. Create.
3. Wait a few seconds, then make sure the picker shows the new project.

## 2. Enable the Calendar API

1. Left menu → **APIs & Services → Library**.
2. Search for **Google Calendar API**. Click it, then **Enable**.

## 3. Configure the OAuth consent screen

1. Left menu → **APIs & Services → OAuth consent screen**.
2. User type: **External**. Create.
3. Fill in the required fields (app name, your email as support email,
   your email as developer contact). Save and continue through the
   Scopes and Test users pages without changes for now.
4. On the Test users page, add your own Google account under **Test
   users** so the app can authorize while it's in "Testing" mode.

## 4. Create the OAuth client

1. Left menu → **APIs & Services → Credentials**.
2. **+ Create credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it `list-assistant`.
4. Create. Copy the **Client ID** and **Client secret** shown in the
   dialog — you'll paste them into the plugin next.

## 5. Point the plugin at your client

Open Obsidian → Settings → List Assistant → **Google Calendar**.

- Paste **Client ID** and **Client secret**.
- Leave **Redirect port** at `42816` unless you know it's already in
  use. If you change it, remember: the plugin uses
  `http://127.0.0.1:<port>/callback` and a Desktop client accepts any
  loopback port, so you don't need to register it explicitly with
  Google.
- **Calendar ID:** `primary` uses your main calendar. To sync into a
  different calendar, open it in Google Calendar (web), click the
  three-dot menu next to it → **Settings and sharing** → scroll down
  to **Integrate calendar** and copy the **Calendar ID**.

Then click **Connect**. A browser tab opens on Google's consent
screen. Because your app is in Testing, Google shows a warning that
the app isn't verified — click **Advanced → Go to list-assistant
(unsafe)**, since it's your own app. Grant access. The tab shows
"Authorization complete" and closes; back in Obsidian, a notice says
"Connected to calendar: …".

## 6. Sync

- Command palette → **Sync Google Calendar** (or the calendar-sync
  ribbon icon).
- URI `obsidian://list-assistant?action=sync-calendar` — Phase 4's
  Windows Task Scheduler entry uses this alongside the triage URI.

The plugin only creates events for notes with **both** `priority: q1`
or `priority: q2` **and** `due: YYYY-MM-DD`. Q3/Q4 stay off the
calendar. Plan of the Day notes with `rapids-class` set get the full
time-blocked chain from the Rapids System template on that date.

## Failure modes

- **"Google did not return a refresh token."** You've already granted
  access on a prior attempt and Google is skipping the consent step,
  so the token endpoint returns only an access token. Fix: visit
  <https://myaccount.google.com/permissions>, revoke access to your
  `list-assistant` app, and Connect again.
- **"Token refresh failed: 400 invalid_grant".** The refresh token
  was revoked (you clicked Disconnect somewhere, or 6 months elapsed
  while the app is in Testing mode). Reconnect.
- **"OAuth timed out after 5 minutes."** Nothing hit the loopback
  callback in time. Retry.
- **Port already in use.** Something else is bound to your redirect
  port. Change the port in settings; no re-registration needed.

## Security notes

- The client secret and refresh token are stored in
  `.obsidian/plugins/list-assistant/data.json` inside your vault.
  Obsidian Sync encrypts sync traffic end-to-end. Anyone with local
  access to your vault has the same access to the tokens.
- To revoke this plugin's access entirely, use the same
  <https://myaccount.google.com/permissions> page.
- Scope requested: `calendar.events` only — the plugin cannot list,
  create, or delete calendars themselves, only events within a
  calendar you already have.
