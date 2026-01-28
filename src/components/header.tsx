"use client";

import { useAppStore } from "@/lib/store";
import { Bell, Moon, Sun, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";

export function Header() {
  const { theme, setTheme, clubName } = useAppStore();
  const { toggleSidebar, state } = useSidebar();

  return (
    <header className="h-16 border-b bg-card flex items-center justify-between px-6 gap-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="h-9 w-9"
          title={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
        >
          <PanelLeft className="h-5 w-5" />
          <span className="sr-only">Toggle Sidebar</span>
        </Button>
        <h1 className="text-lg md:text-xl font-semibold truncate">{clubName || "Brawl Stars Club Manager"}</h1>
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
