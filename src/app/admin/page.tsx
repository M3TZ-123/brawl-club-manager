"use client";
import { T } from "@/components/locale-provider";


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
            <h1 className="text-2xl font-bold"><T text="Admin" /></h1>
            <p className="text-muted-foreground">
              <T text=" Manage protected operations and sensitive configuration. " /></p>
          </div>
          <Button variant="outline" className="gap-2" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            <T text=" Sign Out " /></Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-green-500" />
                <T text=" Protected " /></CardTitle>
              <CardDescription>
                <T text=" Admin session is active on this browser. " /></CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-5 w-5 text-primary" />
                <T text=" Settings " /></CardTitle>
              <CardDescription>
                <T text=" API keys and webhooks are editable only after admin login. " /></CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full">
                <Link href="/settings"><T text="Open Settings" /></Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <RotateCw className="h-5 w-5 text-amber-500" />
                <T text=" Sync " /></CardTitle>
              <CardDescription>
                <T text=" Manual sync and player refresh actions are admin-only. " /></CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full">
                <Link href="/"><T text="Go to Dashboard" /></Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-5 w-5 text-cyan-500" />
              <T text=" Database Security " /></CardTitle>
            <CardDescription>
              <T text=" Public reads stay available, while writes and sensitive settings go through server API routes. " /></CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <T text=" Keep " /><code className="rounded bg-muted px-1.5 py-0.5"><T text="SUPABASE_SERVICE_ROLE_KEY" /></code>,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5"><T text="ADMIN_PASSWORD" /></code><T text=", and" />{" "}
            <code className="rounded bg-muted px-1.5 py-0.5"><T text="ADMIN_SESSION_SECRET" /></code> <T text=" private in Vercel. " /></CardContent>
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
