import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Activity Leaderboard",
  description: "Track active players, performance trends, and leaderboard movement for your Brawl Stars club.",
  alternates: {
    canonical: "/activity",
  },
  openGraph: {
    title: "Activity Leaderboard | BrawlStatz",
    description: "Track active players, performance trends, and leaderboard movement for your Brawl Stars club.",
    url: `${siteUrl}/activity`,
  },
};

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  return children;
}
