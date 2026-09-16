import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Rivals",
  description: "Compare club rosters and observed ranking history.",
  alternates: { canonical: "/rivals" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
