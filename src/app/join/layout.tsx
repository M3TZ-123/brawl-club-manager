import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Join the Club",
  description: "Read club requirements and submit a private membership application.",
  alternates: { canonical: "/join" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
