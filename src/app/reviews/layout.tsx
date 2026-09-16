import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Member Notes",
  description: "Manage private member notes, decisions and absences.",
  alternates: { canonical: "/reviews" },
  robots: { index: false, follow: false }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
