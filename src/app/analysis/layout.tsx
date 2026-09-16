import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Analysis",
  description: "Explore observed club performance and teammate results.",
  alternates: { canonical: "/analysis" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
