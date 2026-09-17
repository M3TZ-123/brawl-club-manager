import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Rivals",
  description: "Follow your club's ranking and compare selected clubs in one clear view.",
  alternates: { canonical: "/rivals" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
