import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Club Recruitment",
  description: "Manage private club candidates and applications.",
  alternates: { canonical: "/recruitment" },
  robots: { index: false, follow: false }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
