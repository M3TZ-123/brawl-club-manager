"use client";
import { T, useI18n, LanguageSelector } from "@/components/locale-provider";


import { useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { AdminGate } from "@/components/admin-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Trophy, Key, CheckCircle } from "lucide-react";

export function SetupWizard() {
  const { t } = useI18n();
  const [step, setStep] = useState(() => {
    const saved = useAppStore.getState();
    return saved.clubTag && saved.apiKeyConfigured ? 3 : 1;
  });
  const [clubTag, setClubTag] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const {
    setClubTag: saveClubTag,
    setApiKey: saveApiKey,
    setClubName,
    setRequiredTrophies,
    saveSettingsToDB,
    loadSettingsFromDB,
  } = useAppStore();

  const handleVerifyClub = async () => {
    setIsLoading(true);
    setError("");

    try {
      const response = await fetch("/api/verify-club", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag, apiKey }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to verify club");
      }

      saveClubTag(clubTag);
      saveApiKey(apiKey);
      setClubName(data.clubName);
      setRequiredTrophies(typeof data.requiredTrophies === "number" ? data.requiredTrophies : null);
      
      // Save to database
      await saveSettingsToDB();
      setApiKey("");
      
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleComplete = async () => {
    setIsLoading(true);
    setError("");
    try {
      // Trigger initial sync with credentials
      const state = useAppStore.getState();
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag: state.clubTag, initialSetup: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || "Initial sync failed");
      }
      invalidateJsonCache();
      await loadSettingsFromDB(true);
      if (!useAppStore.getState().lastSyncTime) {
        throw new Error("Sync finished, but its completion could not be confirmed. Please try again.");
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Initial sync failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AdminGate
      title={t("Admin Setup Required")}
      description="Sign in before adding the Brawl Stars API key and creating the initial club setup."
    >
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="fixed end-4 top-4"><LanguageSelector /></div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Trophy className="h-12 w-12 text-yellow-500" />
          </div>
          <CardTitle className="text-2xl"><T text="Brawl Stars Club Manager" /></CardTitle>
          <CardDescription role="status" aria-live="polite">
            {step === 1 && t("Step 1: Enter your Brawl Stars API key")}
            {step === 2 && t("Step 2: Enter your club tag")}
            {step === 3 && t("Step 3: Sync your club")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 1 && (
            <>
              <div className="space-y-2">
                <label htmlFor="setup-api-key" className="text-sm font-medium"><T text="API Key" /></label>
                <div className="relative" dir="ltr">
                  <Key className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="setup-api-key"
                    aria-describedby="setup-api-key-hint"
                    dir="ltr"
                    type="password"
                    placeholder={t("Enter your Brawl Stars API key")}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="ps-10"
                  />
                </div>
                <p id="setup-api-key-hint" className="text-xs text-muted-foreground">
                  <T text=" Get your API key from" />{" "}
                  <a
                    href="https://developer.brawlstars.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    <T text=" developer.brawlstars.com " /></a>
                </p>
              </div>
              <Button
                className="w-full"
                onClick={() => setStep(2)}
                disabled={!apiKey}
              >
                <T text=" Continue " /></Button>
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <label htmlFor="setup-club-tag" className="text-sm font-medium"><T text="Club Tag" /></label>
                <div className="relative" dir="ltr">
                  <Trophy className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="setup-club-tag"
                    aria-describedby="setup-club-tag-hint"
                    dir="ltr"
                    spellCheck={false}
                    placeholder="#ABC123"
                    value={clubTag}
                    onChange={(e) => setClubTag(e.target.value.toUpperCase())}
                    className="ps-10"
                  />
                </div>
                <p id="setup-club-tag-hint" className="text-xs text-muted-foreground">
                  <T text=" Find your club tag in-game under Club Info " /></p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">{t(error)}</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>
                  <T text=" Back " /></Button>
                <Button
                  className="flex-1"
                  onClick={handleVerifyClub}
                  disabled={!clubTag || isLoading}
                >
                  {isLoading ? <T text="Verifying..." /> : <T text="Verify Club" />}
                </Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex flex-col items-center py-6">
                <CheckCircle className="h-16 w-16 text-green-500 mb-4" />
                <p className="text-lg font-medium"><T text="Ready to Sync" /></p>
                <p className="text-muted-foreground text-center">
                  <T text=" Your club has been verified. Click below to start syncing data. " /></p>
              </div>
              <Button
                className="w-full"
                onClick={handleComplete}
                disabled={isLoading}
              >
                {isLoading ? <T text="Starting sync..." /> : <T text="Start Using App" />}
              </Button>
              <Button className="w-full" variant="outline" asChild>
                <Link href="/settings"><T text="Edit Configuration" /></Link>
              </Button>
              {error && (
                <p role="alert" className="text-sm text-destructive text-center">{t(error)}</p>
              )}
            </>
          )}

          {/* Progress indicator */}
          <div aria-hidden="true" className="flex justify-center gap-2 pt-4">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`h-2 w-2 rounded-full ${
                  s <= step ? "bg-primary" : "bg-muted"
                }`}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
    </AdminGate>
  );
}
