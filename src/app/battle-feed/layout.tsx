import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Live Battle Feed",
  description: "See live Brawl Stars match history with teams, results, and trophy changes for your club members.",
  alternates: {
    canonical: "/battle-feed",
  },
  openGraph: {
    title: "Live Battle Feed | BrawlStatz",
    description: "See live Brawl Stars match history with teams, results, and trophy changes for your club members.",
    url: `${siteUrl}/battle-feed`,
  },
};

export default function BattleFeedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
