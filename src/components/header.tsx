"use client";

import { useAppStore } from "@/lib/store";
import { Bell, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header() {
  const { theme, setTheme, clubName } = useAppStore();

  return (
    <header className="h-16 border-b bg-card flex items-center justify-between px-6">
      <div>
        <h1 className="text-xl font-semibold">{clubName || "Brawl Stars Club Manager"}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </Button>
        <Button variant="ghost" size="icon">
          <Bell className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
