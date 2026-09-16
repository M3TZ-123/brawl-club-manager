import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Game Events and Rankings",
  description: "Explore current game events and club rankings.",
  alternates: { canonical: "/game" }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
