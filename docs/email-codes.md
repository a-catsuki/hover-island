# Email verification code connections

Email code detection is optional and begins only when you connect an account. In Settings > Connections the user clicks **Sign in with Google** (or Microsoft), picks an account in the browser and approves read access. That is the whole flow. Under the hood it is the native-app OAuth flow: system browser, PKCE, and a one-shot loopback callback on `127.0.0.1`.

One-click sign-in needs OAuth clients built into the app. They are read at compile time from the environment or from the gitignored `src-tauri/.env.oauth` (copy `src-tauri/oauth.env.example`). A build without them hides the buttons and shows the "use your own OAuth app" form instead, where a user can paste a client ID from their own console. Refresh tokens are saved only in the Windows DPAPI-protected local connection file.

Each connection can also raise **new mail alerts** in the island (bell button, on by default). Only Primary (Gmail) or Focused (Outlook) inbox mail alerts, at most three per check. Codes never double as alerts.

Hover Island requests read-only inbox access: Gmail `gmail.readonly`, or Microsoft Graph delegated `Mail.Read`, `User.Read`, and `offline_access`. It checks the inbox every 25 seconds while notch notifications are enabled and Do Not Disturb is off. Each connection can be paused independently. The first successful check establishes a baseline and ignores mail already present. Later checks inspect at most 25 recent inbox messages from the last two days and fetch only message metadata and provider previews, never attachments. IDs are retained in a bounded deduplication list. A matching code is shown in memory for up to ten minutes and is not written to disk.

Code detection is intentionally conservative: the sender must look security-related, the message preview must include nearby verification-code language, and the candidate must be a 4–8 character alphanumeric token containing a digit. This can miss codes in messages whose provider preview omits the relevant text, and it can still surface a false match. The user should verify the sender and message context before using a code.

## One-time developer setup (for one-click sign-in)

### Google

1. In [Google Cloud console](https://console.cloud.google.com/) create a project and enable the **Gmail API**.
2. **Google Auth Platform > Branding**: app name "Hover Island", support email, logo, home page and privacy policy URLs (the landing page works), authorized domain.
3. **Audience**: User type **External**. Then **Publish app** (move it out of Testing). In Testing only listed test users can sign in and their refresh tokens expire after 7 days, so codes would stop working weekly.
4. **Data access**: add `openid`, `email` and `https://www.googleapis.com/auth/gmail.readonly`.
5. **Clients > Create client > Desktop app**. Put the client ID and secret in `src-tauri/.env.oauth` as `HOVER_GOOGLE_CLIENT_ID` and `HOVER_GOOGLE_CLIENT_SECRET`, then rebuild. Google treats a Desktop client secret as public; PKCE protects the flow.

`gmail.readonly` is a **restricted** scope. Until the app passes Google's restricted-scope verification (brand review, a privacy policy, a demo video, and a yearly third-party security assessment, CASA), users see a "Google hasn't verified this app" screen and must click Advanced > Go to Hover Island, and the project is capped at 100 users in total. That is fine for personal use and a small beta. For a wide public release, budget for verification or keep a non-OAuth fallback (for example IMAP with a Google app password).

### Microsoft

1. [Microsoft Entra admin center](https://entra.microsoft.com/) > App registrations > New registration. Supported accounts: **any organizational directory and personal Microsoft accounts** (the app signs in through `/common`).
2. Authentication > Add a platform > **Mobile and desktop applications**, redirect URI `http://localhost`. Turn on **Allow public client flows**.
3. API permissions: delegated `Mail.Read`, `User.Read`, `offline_access` (personal accounts need no admin consent).
4. Put the Application (client) ID in `src-tauri/.env.oauth` as `HOVER_MICROSOFT_CLIENT_ID` and rebuild. No secret.

Without publisher verification Microsoft shows the app as "unverified" on the consent screen, but sign-in works.

## Your own OAuth app (Advanced)

### Google / Gmail

1. Create or select a project in Google Cloud and enable the Gmail API.
2. Configure the OAuth consent screen and create an OAuth client with application type **Desktop app**.
3. Enter its client ID in Hover Island. Add the target account as a test user while the consent screen remains in testing.
4. Complete Google sign-in in the browser and approve Gmail read access.

Google classifies Gmail read scopes as restricted. A project intended for broad production use may need Google verification and other review. This app does not claim to be Google-verified. See [Google’s installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail messages API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), and [restricted-scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### Microsoft / Outlook

1. Register an application in Microsoft Entra ID and choose accounts supported by your organization.
2. Add a **Mobile and desktop applications** platform and enable public-client flows.
3. Add delegated `Mail.Read`, `User.Read`, and `offline_access` permissions and grant any consent required by your tenant.
4. Enter the application (client) ID in Hover Island and complete Microsoft sign-in in the browser.

See Microsoft’s [desktop app configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration), [authorization code flow with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), and [Microsoft Graph delegated permissions](https://learn.microsoft.com/en-us/graph/auth-v2-user).

Pausing stops local checks and keeps the saved connection for resuming. Removing a connection deletes its locally stored refresh token. To revoke provider consent as well, use the account’s Google or Microsoft security settings. Hover Island does not access any account until you complete this setup and sign-in.
