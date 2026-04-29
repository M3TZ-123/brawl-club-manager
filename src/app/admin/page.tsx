"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, KeyRound, LogOut, RotateCw, ShieldCheck } from "lucide-react";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminSession } from "@/hooks/use-admin-session";

function AdminPanel() {
  const { logout } = useAdminSession();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.replace("/");
  };

  return (
    <LayoutWrapper>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Admin</h1>
            <p className="text-muted-foreground">
              Manage protected operations and sensitive configuration.
            </p>
          </div>
          <Button variant="outline" className="gap-2" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-green-500" />
                Protected
              </CardTitle>
              <CardDescription>
                Admin session is active on this browser.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-5 w-5 text-primary" />
                Settings
              </CardTitle>
              <CardDescription>
                API keys and webhooks are editable only after admin login.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full">
                <Link href="/settings">Open Settings</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <RotateCw className="h-5 w-5 text-amber-500" />
                Sync
              </CardTitle>
              <CardDescription>
                Manual sync and player refresh actions are admin-only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full">
                <Link href="/">Go to Dashboard</Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-5 w-5 text-cyan-500" />
              Database Security
            </CardTitle>
            <CardDescription>
              Public reads stay available, while writes and sensitive settings go through server API routes.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Keep <code className="rounded bg-muted px-1.5 py-0.5">SUPABASE_SERVICE_ROLE_KEY</code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">ADMIN_PASSWORD</code>, and{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">ADMIN_SESSION_SECRET</code> private in Vercel.
          </CardContent>
        </Card>
      </div>
    </LayoutWrapper>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <AdminPanel />
    </AdminGate>
  );
}
