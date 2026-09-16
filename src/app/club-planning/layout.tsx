import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Goals and Events",
  description: "Plan club goals, teams and events.",
  alternates: { canonical: "/club-planning" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
