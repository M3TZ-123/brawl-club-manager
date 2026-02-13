import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Brawl Stars Club Manager",
  description: "Track your club members, activity, and performance",
  icons: {
    icon: "/icon.gif",
  },
};

// Script to prevent theme flash - runs before React hydrates
const themeScript = `
  (function() {
    try {
      const stored = localStorage.getItem('brawl-club-manager-storage');
      if (stored) {
        const parsed = JSON.parse(stored);
        const theme = parsed.state?.theme || 'dark';
        document.documentElement.classList.add(theme);
      } else {
        document.documentElement.classList.add('dark');
      }
    } catch (e) {
      document.documentElement.classList.add('dark');
    }
  })();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
