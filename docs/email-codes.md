# Email verification code connections

Email code detection is optional and begins only when you connect an account. The native app uses the system browser for OAuth sign-in with PKCE and a one-shot loopback callback. It does not ship provider client credentials. You supply an OAuth client ID created in your own provider console; Google may also require its client secret for token exchange. The secret is saved only inside the Windows DPAPI-protected local connection file and is never returned to the interface.

Hover Island requests read-only inbox access: Gmail `gmail.readonly`, or Microsoft Graph delegated `Mail.Read`, `User.Read`, and `offline_access`. It checks the inbox every 25 seconds while notch notifications are enabled and Do Not Disturb is off. Each connection can be paused independently. The first successful check establishes a baseline and ignores mail already present. Later checks inspect at most 25 recent inbox messages from the last two days and fetch only message metadata and provider previews, never attachments. IDs are retained in a bounded deduplication list. A matching code is shown in memory for up to ten minutes and is not written to disk.

Code detection is intentionally conservative: the sender must look security-related, the message preview must include nearby verification-code language, and the candidate must be a 4–8 character alphanumeric token containing a digit. This can miss codes in messages whose provider preview omits the relevant text, and it can still surface a false match. The user should verify the sender and message context before using a code.

## Google / Gmail

1. Create or select a project in Google Cloud and enable the Gmail API.
2. Configure the OAuth consent screen and create an OAuth client with application type **Desktop app**.
3. Enter its client ID in Hover Island. Add the target account as a test user while the consent screen remains in testing.
4. Complete Google sign-in in the browser and approve Gmail read access.

Google classifies Gmail read scopes as restricted. A project intended for broad production use may need Google verification and other review. This app does not claim to be Google-verified. See [Google’s installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail messages API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), and [restricted-scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Microsoft / Outlook

1. Register an application in Microsoft Entra ID and choose accounts supported by your organization.
2. Add a **Mobile and desktop applications** platform and enable public-client flows.
3. Add delegated `Mail.Read`, `User.Read`, and `offline_access` permissions and grant any consent required by your tenant.
4. Enter the application (client) ID in Hover Island and complete Microsoft sign-in in the browser.

See Microsoft’s [desktop app configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration), [authorization code flow with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), and [Microsoft Graph delegated permissions](https://learn.microsoft.com/en-us/graph/auth-v2-user).

Pausing stops local checks and keeps the saved connection for resuming. Removing a connection deletes its locally stored refresh token. To revoke provider consent as well, use the account’s Google or Microsoft security settings. Hover Island does not access any account until you complete this setup and sign-in.
