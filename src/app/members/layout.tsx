import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export const metadata: Metadata = {
  title: "Club Members",
  description: "Browse club roster, filter members, and review player trophies and roles in one place.",
  alternates: {
    canonical: "/members",
  },
  openGraph: {
    title: "Club Members | BrawlStatz",
    description: "Browse club roster, filter members, and review player trophies and roles in one place.",
    url: `${siteUrl}/members`,
  },
};

export default function MembersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
