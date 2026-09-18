# Brawl Stars Club Manager 🎮

A high-performance web application to track and manage your Brawl Stars club members, their activity, and performance.

The app supports Arabic/English with RTL, private administrator reviews, immutable membership provenance, fenced transactional syncs, and encrypted backups with automated restore verification. See [the Arabic operations guide](docs/BACKUP_OPERATIONS_AR.md) for backup recovery and key custody.

## ✨ Features

### 📊 Dashboard
- Real-time club statistics overview
- Activity distribution charts
- Top members leaderboard
- Recent club events

### 👥 Member Tracking
- Complete member list with sorting & filtering
- Individual player profiles (like Brawlify)
- Trophy tracking and progression charts
- Ranked stats (current & highest)
- Battle statistics (3v3, Solo, Duo victories)

### 🎯 Activity Detection
- **🟢 Active**: A recorded battle or nonzero trophy change within the last 24 hours.
- **🟡 Minimal**: The latest such activity is older than 24 hours but within the configured inactivity threshold (48–168 hours).
- **🔴 Inactive**: The latest valid recorded activity is older than that threshold.
- **⚪ No data**: Activity evidence is missing, invalid, or dated in the future. These members are not treated as inactive or included in inactivity alerts without valid older evidence.

### 📜 Member History
- Track when members join/leave
- Identify returning members
- See join/leave count history
- Distinguish new vs returning members

### 📈 Reports
- Weekly performance reports
- Top trophy gainers/losers
- Export to CSV/HTML

### 🔔 Notifications
- Browser notifications
- Discord webhook integration
- Alerts for member joins/leaves
- Inactivity warnings

### ⚙️ Settings
- Customizable inactivity thresholds
- Auto-sync intervals
- Dark/Light theme
- Data management

## 🚀 Getting Started

### Prerequisites
- Node.js 22 LTS or newer
- npm or yarn
- Brawl Stars API key
- Supabase account (free tier works!)

### 1. Install Dependencies

```bash
cd brawl-club-manager
npm install
```

### 2. Get Brawl Stars API Key

1. Go to [developer.brawlstars.com](https://developer.brawlstars.com)
2. Create an account and generate an API key
3. Add your IP address to the allowed list

### 3. Setup Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run `supabase/schema.sql`, then every file in `supabase/migrations/` in filename order. Existing installations need only the migrations; apply them before deploying the matching application code.
3. Copy your project URL and keys from Project Settings > API

### 4. Configure Environment

Create a `.env.local` file:

```env
# Brawl Stars API
BRAWL_API_KEY=your_api_key_here
CLUB_TAG=#YOUR_CLUB_TAG

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Admin access (server-only, never NEXT_PUBLIC_)
ADMIN_PASSWORD=choose_a_strong_admin_password
ADMIN_SESSION_SECRET=generate_a_long_random_cookie_signing_secret
CRON_SECRET=generate_a_long_random_cron_secret

# Optional
DISCORD_WEBHOOK_URL=your_discord_webhook
```

Admin-only actions include setup, settings changes, manual sync, player refresh, notification mutations, history notes, and join/leave tracking reset.
After updating `supabase/schema.sql`, run the Row Level Security section in Supabase SQL Editor so the public anon key cannot read `settings` or write to any app tables.

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

## 🧪 Tests

```bash
npm test
```

The regression tests use isolated fixtures and mocked services. See [FIXES.md](FIXES.md) for an Arabic explanation of all 15 review fixes and their verification results.

## 🌐 Deploy to Vercel (Free)

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Add environment variables
5. Deploy!

### Scheduled operations

The Supabase scheduler in `supabase/operations/enable_adaptive_scheduler.sql` checks the roster every 2 minutes, with full profiles and battle logs due every 10 minutes and ranked data every 30 minutes by default. Notification delivery runs every 2 minutes on the alternating minute. Upstream cooldowns and an active sync lease can delay a check; the dashboard reports actual freshness. The GitHub sync workflow is manual only. GitHub Actions schedules an encrypted backup with restore verification daily at 03:23 UTC and also supports manual dispatch; scheduled runs may be delayed.

Set repository secrets `VERCEL_APP_URL`, `CRON_SECRET`, and `BACKUP_ENCRYPTION_KEY`. The scheduler secret must match the private database setting `scheduler_token` or the existing server `CRON_SECRET` environment variable. Never put credentials in public settings, workflow source, URLs, or browser environment variables. Keep a separate secure copy of the backup encryption key; losing it makes the encrypted artifacts unusable.

Apply the SQL migrations before deployment and verify the public settings allowlist before saving the dedicated scheduler token. The browser refresh interval is independent of the backend schedule. See [backup operations](docs/BACKUP_OPERATIONS_AR.md) for artifact retrieval, retention, and an isolated restore rehearsal.

Mega Pig counters use the documented anonymous [BrawlTools club API](https://api.brawltools.net/docs). The shared database cache checks every 20 minutes, or every 10 minutes around a planned Mega Pig event; failures back off and respect `Retry-After`. Ordinary roster/profile sync continues independently. Apply migration `202609160042_mega_pig_source_provenance.sql` before deploying this provider change. The first new worker starts BrawlTools' independent cadence after any active legacy request finishes, preserving the former provider's failure state. Existing BrawlAce readings retain their source, and automatic cycle collection pauses on a source change until an administrator confirms a new reading belongs to that cycle. Provider counters do not establish cycle dates, attendance, or reward receipt.

## 📁 Project Structure

```
src/
├── app/
│   ├── api/           # API routes
│   │   ├── sync/      # Data sync endpoint
│   │   ├── members/   # Member endpoints
│   │   ├── events/    # Events endpoint
│   │   ├── history/   # History endpoint
│   │   └── reports/   # Reports endpoint
│   ├── members/       # Members pages
│   ├── activity/      # Activity page
│   ├── reports/       # Reports page
│   ├── history/       # History page
│   ├── settings/      # Settings page
│   └── page.tsx       # Dashboard
├── components/        # UI components
├── lib/              # Utilities & API
└── types/            # TypeScript types
```

## 🔧 Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI + Custom
- **State**: Zustand
- **Charts**: Recharts
- **Database**: Supabase (PostgreSQL)
- **API**: Brawl Stars Official API

## 📊 Database Schema

- `members` - Current member data
- `activity_log` - Trophy change history
- `club_events` - Join/leave events
- `member_history` - Long-term member tracking
- `settings` - App configuration

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

MIT License - feel free to use for your club!

## 🙏 Credits

- Brawl Stars API by Supercell
- [BrawlTools](https://brawltools.net) for Mega Pig counters and map statistics
- [Brawlify](https://brawlify.com) for game assets and map images
- Built with Next.js and Vercel
- Icons by Lucide

---

Made with ❤️ for Brawl Stars club leaders
