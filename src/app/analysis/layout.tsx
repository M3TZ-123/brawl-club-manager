import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Analysis",
  description: "Explore recorded teammate results and playing hours for your club.",
  alternates: { canonical: "/analysis" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
