import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Readiness",
  description: "Review the club roster and brawler readiness.",
  alternates: { canonical: "/readiness" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
