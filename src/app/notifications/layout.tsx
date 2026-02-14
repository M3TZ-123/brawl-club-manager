import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Read club alerts, member updates, and unread notifications from your Brawl Stars tracking system.",
  alternates: {
    canonical: "/notifications",
  },
  openGraph: {
    title: "Notifications | BrawlStatz",
    description: "Read club alerts, member updates, and unread notifications from your Brawl Stars tracking system.",
    url: `${siteUrl}/notifications`,
  },
};

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
