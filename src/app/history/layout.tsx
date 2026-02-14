import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Member History",
  description: "Track join and leave history, notes, and long-term membership changes in your Brawl Stars club.",
  alternates: {
    canonical: "/history",
  },
  openGraph: {
    title: "Member History | BrawlStatz",
    description: "Track join and leave history, notes, and long-term membership changes in your Brawl Stars club.",
    url: `${siteUrl}/history`,
  },
};

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
