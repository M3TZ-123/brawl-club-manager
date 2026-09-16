"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, LogOut, Settings } from "lucide-react";
import { T } from "@/components/locale-provider";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SyncHealthCard } from "@/components/sync-health";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAdminSession } from "@/hooks/use-admin-session";

function AdminPanel() {
  const { logout } = useAdminSession();
  const router = useRouter();
  const handleLogout = async () => { await logout(); router.replace("/"); };
  return <LayoutWrapper><div className="mx-auto max-w-5xl space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold"><T text="Admin" /></h1><p className="mt-1 text-sm text-muted-foreground"><T text="Monitor updates and manage your club." /></p></div>
      <Button variant="outline" className="gap-2" onClick={handleLogout}><LogOut className="h-4 w-4" /><T text="Sign Out" /></Button>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Card><CardContent className="p-5"><Link href="/reviews" className="flex items-center gap-3 hover:text-primary"><ClipboardList className="h-5 w-5" /><div><p className="font-semibold"><T text="Member reviews" /></p><p className="mt-1 text-sm text-muted-foreground"><T text="Notes and follow-ups for your members." /></p></div></Link></CardContent></Card>
      <Card><CardContent className="p-5"><Link href="/settings" className="flex items-center gap-3 hover:text-primary"><Settings className="h-5 w-5" /><div><p className="font-semibold"><T text="Settings" /></p><p className="mt-1 text-sm text-muted-foreground"><T text="Club connection, activity rules and notifications." /></p></div></Link></CardContent></Card>
    </div>
    <SyncHealthCard />
  </div></LayoutWrapper>;
}

export default function AdminPage() {
  return <AdminGate><AdminPanel /></AdminGate>;
}
