import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club events",
  description: "Follow Mega Pig and organize club events.",
  alternates: { canonical: "/club-planning" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
