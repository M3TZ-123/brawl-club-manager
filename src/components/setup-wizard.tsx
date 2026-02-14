"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Trophy, Key, CheckCircle } from "lucide-react";

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(1);
  const [clubTag, setClubTag] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const { setClubTag: saveClubTag, setApiKey: saveApiKey, setClubName, saveSettingsToDB } = useAppStore();

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
      
      // Save to database
      await saveSettingsToDB();
      
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleComplete = async () => {
    setIsLoading(true);
    try {
      // Trigger initial sync with credentials
      const state = useAppStore.getState();
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag: state.clubTag, apiKey: state.apiKey, initialSetup: true }),
      });
      onComplete();
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Trophy className="h-12 w-12 text-yellow-500" />
          </div>
          <CardTitle className="text-2xl">Brawl Stars Club Manager</CardTitle>
          <CardDescription>
            {step === 1 && "Step 1: Enter your Brawl Stars API key"}
            {step === 2 && "Step 2: Enter your club tag"}
            {step === 3 && "Setup complete!"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 1 && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">API Key</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="password"
                    placeholder="Enter your Brawl Stars API key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your API key from{" "}
                  <a
                    href="https://developer.brawlstars.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    developer.brawlstars.com
                  </a>
                </p>
              </div>
              <Button
                className="w-full"
                onClick={() => setStep(2)}
                disabled={!apiKey}
              >
                Continue
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Club Tag</label>
                <div className="relative">
                  <Trophy className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="#ABC123"
                    value={clubTag}
                    onChange={(e) => setClubTag(e.target.value.toUpperCase())}
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Find your club tag in-game under Club Info
                </p>
              </div>
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleVerifyClub}
                  disabled={!clubTag || isLoading}
                >
                  {isLoading ? "Verifying..." : "Verify Club"}
                </Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex flex-col items-center py-6">
                <CheckCircle className="h-16 w-16 text-green-500 mb-4" />
                <p className="text-lg font-medium">Setup Complete!</p>
                <p className="text-muted-foreground text-center">
                  Your club has been verified. Click below to start syncing data.
                </p>
              </div>
              <Button
                className="w-full"
                onClick={handleComplete}
                disabled={isLoading}
              >
                {isLoading ? "Starting sync..." : "Start Using App"}
              </Button>
            </>
          )}

          {/* Progress indicator */}
          <div className="flex justify-center gap-2 pt-4">
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
  );
}
