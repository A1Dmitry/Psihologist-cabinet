# Google identity for a client attaching triage

This is the public-client flow for attaching the optional triage result to a booking. It is **not** psychologist login (psychologists use the separate manual email/Telegram code flow in issue #40).

## Runtime behavior

1. Guest bookings without a triage assessment remain available.
2. A client who chooses to attach triage explicitly agrees to share the result and Google-verified name/email with the selected psychologist.
3. The client then chooses the Google button or explicitly opens One Tap. One Tap is never prompted automatically before consent.
4. GIS returns a Google ID token. The browser sends it directly to Supabase Auth (`signInWithIdToken` / GoTrue ID-token grant), with a single-use SHA-256 nonce. The ID token is not logged or saved.
5. The Supabase session is held separately from psychologist auth (tab-scoped storage); guest booking always uses the anon key, never an accidentally active psychologist token.
6. The assessment remains in the existing private `sessions.note`; free text remains in `clients.note`. Questionnaire answers, notes, ID tokens, and auth tokens must not go to Telegram or Google Apps Script.

**Backend caveat:** `create_booking` currently accepts anonymous bookings and has no auth-user link/triage flag. The client flow cannot enforce identity against a direct RPC caller. SR-005 in `docs/SCHEMA-REQUESTS.md` and issue #41 ask Agent 1 to add the server-side check/link. Do not describe enforcement as complete until that contract is implemented and deployed.

## Google Cloud configuration

Create a Google OAuth client of type **Web application**.

**Authorized JavaScript origins** (origins only — no project path):

- `https://a1dmitry.github.io` — candidate derived from the current source/deployed Pages path; confirm with the owner before configuring production.
- `http://localhost:8765`
- `http://127.0.0.1:8765`

Add another origin only if testing from another permanent origin. A preview host is session-specific and should not be treated as a production origin.

**Authorized redirect URI:** because this app exchanges the GIS token through Supabase Auth, configure the Supabase callback (confirm the exact value in Supabase Dashboard → Authentication → Sign In / Providers → Google):

- `https://phiavtroybgwyjdhqqkh.supabase.co/auth/v1/callback` — candidate from the repository's current Supabase config; confirm the active project ref with the owner before configuring production.

The supplied backend-free GIS sample said to leave redirect URIs blank; that instruction does not apply to this Supabase-backed provider setup.

## Supabase configuration

1. Supabase Dashboard → Authentication → Sign In / Providers → Google: enable Google.
2. Enter the Google Web Client ID and Client Secret in the Dashboard. **The Client Secret must never be placed in this repository or browser code.**
3. After the owner confirms the production URL, configure the Supabase Site URL/redirect allowlist for that exact origin and the app's required callback routes. The source currently contains the GitHub Pages URL above as a candidate; do not copy it into production settings without confirmation.
4. Provide the public Web Client ID to the static app before `js/app.js` loads, for example by adding this inline script in `index.html` before the module entry point:

   ```html
   <script>window.PSY_GOOGLE_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';</script>
   ```

   Alternatively, change the exported `GOOGLE_CLIENT_ID` expression in `js/services/supabaseConfig.js` to the public Web Client ID literal. The current default is blank on purpose; until configured, the triage attachment flow fails closed while guest bookings continue.
5. A Google OAuth origin/redirect change can take several minutes to propagate. Test the deployed GitHub Pages URL, not only localhost.

## Verification checklist

- Test button and One Tap only after triage consent; verify the page does not auto-prompt on load.
- Confirm the provider rejects wrong audience, expired token, nonce mismatch/replay, unverified email, and provider/network errors.
- Confirm returned name/email come from the Supabase Auth response, not a decoded localStorage JWT payload.
- Confirm the public booking sends the client Supabase access token only for an attached triage result; guest booking uses the anon key even if a psychologist has a session in the same tab.
- Confirm invalid/missing Google configuration prevents attaching triage but does not prevent ordinary booking.
- Complete SR-005 / issue #41 before treating the RPC as server-enforced; run a real Google/Supabase E2E test after production setup.
