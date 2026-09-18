"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, LogOut, Settings } from "lucide-react";
import { T } from "@/components/locale-provider";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SyncHealthCard } from "@/components/sync-health";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAdminSession } from "@/hooks/use-admin-session";

function AdminPanel({ onLogout }: { onLogout: () => Promise<void> }) {
  return <LayoutWrapper><div className="mx-auto max-w-5xl space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold"><T text="Admin" /></h1>
      <Button variant="outline" className="gap-2" onClick={onLogout}><LogOut className="h-4 w-4" /><T text="Sign Out" /></Button>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="border-primary/40"><CardContent className="p-5"><Link href="/reviews" className="flex items-center gap-3 hover:text-primary"><ClipboardList className="h-5 w-5" /><span className="font-semibold"><T text="Notes and departure reasons" /></span></Link></CardContent></Card>
      <Card><CardContent className="p-5"><Link href="/settings" className="flex items-center gap-3 hover:text-primary"><Settings className="h-5 w-5" /><span className="font-semibold"><T text="Settings" /></span></Link></CardContent></Card>
    </div>
    <SyncHealthCard />
  </div></LayoutWrapper>;
}

export default function AdminPage() {
  const { logout } = useAdminSession();
  const router = useRouter();
  // Keep the error above the gate: pending sign-out unmounts private content.
  const [logoutError, setLogoutError] = useState(false);
  const handleLogout = async () => {
    setLogoutError(false);
    try { await logout(); router.replace("/"); }
    catch { setLogoutError(true); }
  };
  return <>
    {logoutError && <p role="alert" className="mx-auto max-w-5xl p-4 text-sm text-destructive"><T text="Could not sign out. Please try again." /></p>}
    <AdminGate><AdminPanel onLogout={handleLogout} /></AdminGate>
  </>;
}
