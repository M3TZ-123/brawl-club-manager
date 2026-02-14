import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Settings",
  description: "Configure API keys, sync intervals, notifications, and data preferences for your BrawlStatz workspace.",
  alternates: {
    canonical: "/settings",
  },
  openGraph: {
    title: "Settings | BrawlStatz",
    description: "Configure API keys, sync intervals, notifications, and data preferences for your BrawlStatz workspace.",
    url: `${siteUrl}/settings`,
  },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
