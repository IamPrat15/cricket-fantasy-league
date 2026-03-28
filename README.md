# ⚡ Thunder XI — IPL Fantasy League 2026

A free, self-hosted IPL Fantasy League web app with:
- Mobile OTP login (via Twilio)
- Team builder with live budget & role validation
- Admin panel to view all teams & update scores
- Leaderboard by participants and by players (revealed after deadline)

---

## 🚀 Deploy to Render (Free Tier) — Step by Step

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/thunder-xi.git
git push -u origin main
```

### 2. Create Render Web Service
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### 3. Set Environment Variables on Render
Go to your service → Environment → Add these:

| Key | Value |
|-----|-------|
| `JWT_SECRET` | Any random 32-char string (use: `openssl rand -hex 32`) |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | Your chosen admin password |
| `DEADLINE` | `2026-03-28T14:00:00.000Z` (adjust to your match time, UTC) |
| `TWILIO_ACCOUNT_SID` | From Twilio console (or leave blank for dev mode) |
| `TWILIO_AUTH_TOKEN` | From Twilio console |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (e.g. `+12025551234`) |

### 4. Deploy!
Render auto-deploys on every push. First deploy takes ~2 minutes.

---

## 📱 Twilio OTP Setup (Free)

1. Sign up at [twilio.com](https://twilio.com) — free trial gives $15 credit
2. Get your Account SID and Auth Token from the dashboard
3. Get a free phone number
4. Add the 3 Twilio env vars above

> **Dev Mode:** If Twilio is not configured, OTPs are printed to the server console log. Perfect for testing.

---

## ⏰ Setting the Deadline

The `DEADLINE` env var controls when submissions close and leaderboard opens.

- Format: ISO 8601 UTC
- IPL 2026 first match: 28 March 2026, 7:30 PM IST = `2026-03-28T14:00:00.000Z`
- Set it ~30 min before match start to be safe

---

## 👤 Admin Usage

1. Go to your app URL → click "Admin" in login page
2. Login with your `ADMIN_USERNAME` / `ADMIN_PASSWORD`
3. **Before deadline:** See all submitted teams
4. **After matches:** Enter actual player scores → teams auto-recalculate
5. Leaderboard becomes public after deadline automatically

---

## 🏏 Game Rules (from Excel)

- **Budget:** 1000 Fantasy Points
- **Team size:** 11 players
- **Overseas:** Max 4
- **WK:** 1–2 | **Batters:** 3–5 | **All-Rounders:** 1–3 | **Bowlers:** 3–5
- **Captain & Vice-Captain** required
- One team per user, no changes after submission

---

## 🗄️ Database

Uses SQLite (`better-sqlite3`) — zero config, file-based.

> ⚠️ **Render Free Tier Note:** Render's free tier has ephemeral storage — the SQLite file resets on every deploy/restart. For production use, either:
> - Upgrade to Render's paid tier with a persistent disk ($7/mo)
> - Use [Turso](https://turso.tech) (free SQLite-compatible cloud DB) — swap `better-sqlite3` for `@libsql/client`
> - Use [Railway](https://railway.app) free tier which has persistent storage

---

## 📁 Project Structure

```
thunder-xi/
├── src/
│   ├── server.js      # Express API server
│   ├── db.js          # SQLite schema & connection
│   └── players.json   # All 250 IPL 2026 players
├── public/
│   └── index.html     # Full SPA frontend
├── render.yaml        # Render deployment config
├── .env.example       # Environment variable template
└── package.json
```
