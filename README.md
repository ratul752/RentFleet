# RentFleet

A full-stack vehicle rental platform with an independent customer storefront and protected admin dashboard, sharing a MongoDB Atlas database. The existing RentFleet Pro customer and admin layouts and API flows are retained. No demo accounts, sample fleet, or live credentials are packaged.

## Features

- Browse and filter vehicles, check rental dates, create reservations, cancel unpaid reserved bookings, and view personal booking history and balance.
- Separate customer and staff logins, profile editing, password changes, admin/owner/staff permissions.
- Fleet, customers, reservations, checkout/return, recorded payments, maintenance, expenses, analytics, staff, settings, and CSV reports.
- MongoDB-backed persistent data, hashed passwords, hashed session tokens, expirations, transactional writes and durable per-account authentication rate limits.

## Architecture

```
RentFleet-Atlas/
  client/    # customer / and admin /admin; build-based UI + same-origin API proxy
  server/    # Node API + MongoDB repositories and transaction handling
```

The browser uses `/api/...` on the client origin. The client proxies to the separately deployed backend using `PUBLIC_API_BASE_URL`; the backend checks `CLIENT_ORIGINS`. This preserves HttpOnly same-origin session cookies even when the two hosting domains differ. Source pages are JavaScript templates; HTML is generated into ignored `client/dist/`. Browser-delivered frontend code remains inspectable. The backend does not serve its source files.

## MongoDB Atlas setup

1. Use your existing Atlas cluster or make a Free M0 cluster. Use a separate database named `RentFleet`; do not select `OravelLifestyle`.
2. Create a dedicated **database user** with `readWrite` limited to `RentFleet`. Use a unique password. A first-run connection creates indexes and collections automatically; manually creating a database or collections is optional.
3. Add your current IP to Atlas IP Access List for local tests. A deployment with dynamic outgoing IPs may require `0.0.0.0/0`; prefer restricted/static outbound IPs when available. Use TLS, least privilege and strong credentials.
4. Cluster -> Connect -> Drivers -> Node.js. Copy the Atlas URI, substitute your database username and URL-encoded password, and choose `RentFleet` as database name. Store the URI only server-side.
5. This project requires a replica set supporting transactions (Atlas is suitable), not a standalone local MongoDB server. The Windows DNS override is included; set `MONGO_DNS_FIX=false` if not needed.

## Local setup (Windows PowerShell)

Use Node.js 22.x. Open the repository root in VS Code and use two terminals.

Terminal 1:

```powershell
cd server
npm install
Copy-Item .env.example .env
code .env
```

Set `MONGODB_URI`, `MONGODB_DB=RentFleet`, `OWNER_EMAIL`, `OWNER_PASSWORD` (10–128 characters; use 16+), and `OWNER_NAME` in the server environment. Owner is created only if the `users` collection is empty; changing environment variables later does not change an existing owner password. Do not reuse the database password for the owner. Keep `CLIENT_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` for local development.

```powershell
npm run test:db
npm start
```

Terminal 2 (repository root):

```powershell
cd client
Copy-Item .env.example .env
npm run dev
```

Customer site `http://localhost:5173`, administration `http://localhost:5173/admin`, backend health `http://localhost:5000/api/health`. Add real vehicles using the owner account, then sign up from the customer portal to book one. To see updated source, restart the frontend dev command.

## Deploy separately on Vercel

Commit `client/`, `server/`, this README and examples to **one repository**. Never commit real `.env` files, database dumps, keys or generated files. A public GitHub repository exposes all committed source. Make a private repo if you want to protect source. Use a commercial-use-compatible hosting plan for real business operations.

### Server project

Root Directory: `server`; Framework Preset: Other; Node.js: 22.x; Build Command and Output Directory: use checked-in `vercel.json` (output `public`). Install Command: `npm install`. Add environment variables from `server/.env`: `MONGODB_URI`, `MONGODB_DB`, `OWNER_NAME`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `CLIENT_ORIGINS`. No need to set PORT or HOST on Vercel. Use production mode. For an empty database, owner credentials are mandatory in production; anonymous owner setup is disabled in production. Preserve existing owner credentials if already configured. Set `CLIENT_ORIGINS` to the actual client origin after it deploys. No trailing slash. Mark database URI and owner password secret; public origins are configuration values. Check the actual server's `/api/health` endpoint after deploying.

### Client project

Import the same repository again. Root Directory: `client`; Framework Preset: Other; Node.js: 22.x; Build Command: `npm run build`; Output Directory: `dist`; Install Command: default. Add `PUBLIC_API_BASE_URL` with the actual HTTPS backend origin, without `/api` or a trailing slash. Set visibility Config (not Secret). This value is consumed by the client proxy function at runtime. Deploy. Update the backend's `CLIENT_ORIGINS` to the actual client origin and redeploy backend. Use the live client URL for customers and `/admin` for staff; no need to open backend first. If Vercel Deployment Protection blocks the public API, configure public production access while keeping previews protected as appropriate. Test `/api/health` through the client domain as well as backend domain.

## Tests and production limits

`npm run test:db` connects to Atlas, creates indexes and tests a write transaction. To run full API integration tests, set a separate test-only cluster URI in PowerShell, e.g. `$env:MONGODB_TEST_URI='YOUR_TEST_ATLAS_URI'`, then `npm test` from `server/`. Tests generate unique `RentFleet_test_*` databases and remove only those test databases afterward. Test credentials must permit creation and deletion of those isolated test databases. Do not use a production-only database account. Without this variable, integration tests are skipped. The API test suite includes auth isolation, pricing, concurrent booking requests, payments, rental lifecycle, reporting, and restart persistence.

Source v1.4 data was not migrated: use an empty RentFleet database unless intentional migration is planned. Runtime no longer uses SQLite. Payment recording is manual, not an online payment gateway. This release does not add OTP/password recovery by email. A single transaction lock serializes writes to avoid double booking across instances; suitable for a small fleet, but load testing and more granular locks/pagination are needed before larger-scale production use. Per-account rate limits do not replace a global abuse protection/WAF. Real Atlas and Vercel integration must still be tested using your credentials. See VALIDATION.md.
