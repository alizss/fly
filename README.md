# Air Travel Wallet V1

Working proof-of-life for the PRD:

- Team travel dashboard
- Traveler profile vault with masked document numbers
- Manual trip creation
- Demo checkout page at `/demo/checkout`
- Chrome Manifest V3 extension that detects the demo checkout page, autofills traveler details, runs risk checks, and saves a trip back to the dashboard
- Supabase-shaped SQL schema and RLS notes

## Run locally

```bash
npm run dev
```

Open `http://localhost:4173`.

## Install the extension locally

1. Open Chrome Extensions.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select `apps/extension`.
5. Open `http://localhost:4173/demo/checkout`.

The extension talks to the local API at `http://localhost:4173/api`.

## Testing real-site generic mode

The extension is configured to run on:

- `localhost:4173/demo/checkout`
- Skyscanner `.com` / `.net`
- Croatia Airlines `.com` / `.hr`
- GoToGate `.com`

Real-site support is best-effort generic detection. It should show the sidebar only when it sees enough passenger-style fields. It may need a site-specific mapping before it can fill every field reliably.

For a Skyscanner-style flow:

1. Search normally on Skyscanner.
2. Pick a flight.
3. Follow the redirect to the airline or OTA checkout.
4. When passenger fields appear, use the Air Travel Wallet sidebar.
5. It can fill passenger and billing details, but it must not fill card number/CVC or click the final payment button.

If Skyscanner redirects to a new OTA domain, add that domain to `apps/extension/manifest.json`, reload the unpacked extension, and retest on the passenger-details page.

## Notes

The local API still uses a lightweight Node server and JSON file store, while the dashboard UI now builds with Vite, TypeScript, React, Tailwind CSS, Lucide icons, and Framer Motion. The folder layout still leaves clear replacement points for Next.js, Supabase Auth, Postgres, and Edge Functions.
