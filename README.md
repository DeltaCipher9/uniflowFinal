# UniFlow

University Life Operating System: frontend (`public/`) + backend (`server/`).

## Run it

1. Install **Node.js LTS (22.13 or newer)** from https://nodejs.org  (check: `node -v`)
2. Open this folder in VS Code, open the terminal (Ctrl + `) and run:

       npm install
       npm start

3. Open **http://localhost:3000** (not the .html files directly, and not Live Server). The root URL shows the public UniFlow landing page; click **Open UniFlow** to sign in.
4. Click **Create account**, sign up, and you're in. Stop the server with Ctrl + C.

Accounts and all data are saved in `data/uniflow.db` (created automatically).
Delete that file to reset everything. Don't commit `data/` to GitHub (already in .gitignore).

## Folder map

    server/server.js   API: register, login, logout, me, load/save user data
    server/db.js       SQLite database + table definitions
    public/            the website (login.html is new; app.js now talks to the API)
    data/              created on first run: uniflow.db + jwt-secret.txt (private!)

## API

    POST /api/auth/register   {name, email, password, program?}
    POST /api/auth/login      {email, password}
    POST /api/auth/logout
    GET  /api/auth/me
    GET  /api/data            -> {data:{courses,tasks,projects}} for the logged-in user
    PUT  /api/data            {data:{courses,tasks,projects}}

## Deploy to Render

This project includes `render.yaml` for deployment on Render. The service uses Node 22+, runs `npm ci` during build, `npm start` at runtime, exposes `/health` for health checks, and uses a persistent disk for the SQLite database.

After deployment, Render will provide a public HTTPS URL. The root URL (`/`) is a public UniFlow landing page; the app itself is available through `/login.html` and the dashboard at `/index.html` after login.

The public landing page is prepared for search-engine discovery. To appear for searches such as `UniFlow`, submit the final Render URL to Google Search Console after deployment. Search indexing is controlled by Google and may take time; deployment alone does not guarantee an immediate search result.


## Student Profile + Routine AI

UniFlow now includes `profile.html`, where a student can enter personal information and upload a RUET CSE class routine (PDF/PNG/JPG/WEBP). With `OPENAI_API_KEY` configured, the backend sends the routine to the OpenAI Responses API and returns structured academic-year/series/semester/section and class data. The app also links the RUET official website, CSE notices/routine pages, and the RUET CSE Archive as knowledge sources.

Add these environment variables before starting the server:

    OPENAI_API_KEY=your_key_here
    OPENAI_MODEL=gpt-6-luna

The API key stays on the server; it is never placed in browser JavaScript.


## Authentication

- Password fields include a Show/Hide control.
- Each email can have only one account. Emails are normalized to lowercase and the SQLite `users.email` column has a UNIQUE constraint; the database constraint also protects against concurrent duplicate registrations.
- Forgot password creates a single-use reset token valid for 30 minutes.
- For real email delivery, set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Resend must be configured for the sender domain. In local development, if those values are absent, the reset URL is printed to the server console instead.
- Password reset requests intentionally return the same message for existing and non-existing emails to reduce account enumeration.
