import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Battle Feed",
  description: "Browse recorded Brawl Stars battle history with teams, results, and trophy changes for your club members.",
  alternates: {
    canonical: "/battle-feed",
  },
  openGraph: {
    title: "Battle Feed | BrawlStatz",
    description: "Browse recorded Brawl Stars battle history with teams, results, and trophy changes for your club members.",
    url: `${siteUrl}/battle-feed`,
  },
};

export default function BattleFeedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
