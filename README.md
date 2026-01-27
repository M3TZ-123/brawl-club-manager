# Brawl Stars Club Manager 🎮

A high-performance web application to track and manage your Brawl Stars club members, their activity, and performance.

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
- **🟢 Active**: Significant trophy changes (±20+)
- **🟡 Minimal**: Just opened game (streak keeper)
- **🔴 Inactive**: No changes in 24+ hours

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
- Node.js 18+
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
2. Go to SQL Editor and run the schema from `supabase/schema.sql`
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

# Optional
DISCORD_WEBHOOK_URL=your_discord_webhook
```

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

## 🌐 Deploy to Vercel (Free)

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Add environment variables
5. Deploy!

### Setup Auto-Sync (Vercel Cron)

Create `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/sync",
      "schedule": "0 */4 * * *"
    }
  ]
}
```

This syncs data every 4 hours automatically.

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

- **Framework**: Next.js 14 (App Router)
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
- Built with Next.js and Vercel
- Icons by Lucide

---

Made with ❤️ for Brawl Stars club leaders
