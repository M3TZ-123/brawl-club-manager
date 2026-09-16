"use client";
import { T, useI18n, LanguageSelector } from "@/components/locale-provider";


import { FormEvent, ReactNode, useState } from "react";
import { LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import { useAdminSession } from "@/hooks/use-admin-session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type AdminGateProps = {
  children: ReactNode;
  title?: string;
  description?: string;
};

export function AdminGate({
  children,
  title = "Admin Access",
  description = "Sign in to manage your club settings and member reviews.",
}: AdminGateProps) {
  const { t } = useI18n();
  const { configured, isAdmin, isLoading, login } = useAdminSession();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      await login(password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Admin login failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div role="status" aria-label={t("Loading...")} className="flex min-h-[60vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <Card className="w-full max-w-lg border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <div className="mb-2 self-end"><LanguageSelector /></div>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              <T text="Admin access unavailable" /></CardTitle>
            <CardDescription>
              <T text="Ask the app owner to finish administrator setup." /></CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole className="h-6 w-6" />
            </div>
            <div className="mx-auto mb-2"><LanguageSelector /></div>
            <CardTitle><T text={title} /></CardTitle>
            <CardDescription><T text={description} /></CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="admin-password">
                  <T text=" Admin Password " /></label>
                <Input
                  id="admin-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder={t("Enter admin password")}
                />
              </div>

              {error && (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {t(error)}
                </p>
              )}

              <Button className="w-full gap-2" disabled={!password || isSubmitting}>
                <ShieldCheck className="h-4 w-4" />
                {isSubmitting ? <T text="Signing in..." /> : <T text="Sign In" />}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
