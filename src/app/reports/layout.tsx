import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Reports",
  description: "View weekly club reports, trophy trends, top gainers, and activity summaries for your Brawl Stars club.",
  alternates: {
    canonical: "/reports",
  },
  openGraph: {
    title: "Reports | BrawlStatz",
    description: "View weekly club reports, trophy trends, top gainers, and activity summaries for your Brawl Stars club.",
    url: `${siteUrl}/reports`,
  },
};

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
