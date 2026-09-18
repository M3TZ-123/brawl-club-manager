"use client";
import { T, useI18n } from "@/components/locale-provider";


import { useState, useEffect, useRef } from "react";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useAppStore, type SettingsChanges } from "@/lib/store";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Save, 
  Key, 
  Bell, 
  Clock, 
  Palette, 
  Database, 
  CheckCircle,
  ExternalLink,
} from "lucide-react";

export default function SettingsPage() {
  const { t } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const session = useRef({ isAdmin, sessionLoading });
  session.current = { isAdmin, sessionLoading };
  const {
    clubTag,
    apiKeyConfigured,
    theme,
    inactivityThreshold,
    notificationsEnabled,
    discordWebhookConfigured,
    setTheme,
    saveSettingsToDB,
    loadSettingsFromDB,
    hasLoadedSettings,
    isLoadingSettings,
    settingsError,
  } = useAppStore();

  const [localClubTag, setLocalClubTag] = useState<string | null>(null);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localDiscordWebhook, setLocalDiscordWebhook] = useState("");
  const [localInactivityThreshold, setLocalInactivityThreshold] = useState<number | null>(null);
  const [localNotificationsEnabled, setLocalNotificationsEnabled] = useState<boolean | null>(null);
  const [generalError, setGeneralError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [notifError, setNotifError] = useState("");
  const [generalStatus, setGeneralStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [activityStatus, setActivityStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [notifStatus, setNotifStatus] = useState<"idle" | "saving" | "saved">("idle");
  const controller = useRef<AbortController | null>(null);
  const pendingSave = useRef(false);

  useEffect(() => {
    controller.current = new AbortController();
    const reset = () => {
      controller.current?.abort();
      controller.current = new AbortController();
      pendingSave.current = false;
      setLocalClubTag(null); setLocalApiKey(""); setLocalDiscordWebhook("");
      setLocalInactivityThreshold(null); setLocalNotificationsEnabled(null);
      setGeneralError(""); setActivityError(""); setNotifError("");
      setGeneralStatus("idle"); setActivityStatus("idle"); setNotifStatus("idle");
    };
    window.addEventListener("admin-session-changed", reset);
    return () => { controller.current?.abort(); window.removeEventListener("admin-session-changed", reset); };
  }, []);

  const beginSave = () => {
    const current = controller.current;
    if (!session.current.isAdmin || session.current.sessionLoading || pendingSave.current || !current || current.signal.aborted) return null;
    pendingSave.current = true;
    return current;
  };

  useEffect(() => {
    if (!hasLoadedSettings) {
      loadSettingsFromDB();
    }
  }, [hasLoadedSettings, loadSettingsFromDB]);

  const effectiveClubTag = localClubTag ?? clubTag;
  const effectiveInactivityThreshold = localInactivityThreshold ?? inactivityThreshold;
  const effectiveNotificationsEnabled = localNotificationsEnabled ?? notificationsEnabled;
  const saving = [generalStatus, activityStatus, notifStatus].includes("saving");

  const parseBoundedInput = (value: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };

  const handleSaveGeneral = async () => {
    const current = beginSave(); if (!current) return;
    setGeneralStatus("saving");
    setGeneralError("");
    try {
      const normalizeTag = (value: string) => "#" + value.trim().replace(/^%23/i, "#").replace(/^#/, "").toUpperCase();
      const changes: SettingsChanges = { clubTag: effectiveClubTag };
      if (normalizeTag(effectiveClubTag) !== normalizeTag(clubTag) || localApiKey.trim() || !apiKeyConfigured) {
        const verified = await fetchJsonWithTimeout<{ clubTag: string; clubName: string; requiredTrophies: number }>("/api/verify-club", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
          body: JSON.stringify({ clubTag: effectiveClubTag, apiKey: localApiKey }),
        });
        if (current.signal.aborted) return;
        changes.clubTag = verified.clubTag;
        changes.clubName = verified.clubName;
        changes.requiredTrophies = typeof verified.requiredTrophies === "number" ? verified.requiredTrophies : null;
      }
      if (localApiKey.trim()) changes.apiKey = localApiKey;
      await saveSettingsToDB(changes, { signal: current.signal });
      if (current.signal.aborted) return;
      setLocalClubTag(null);
      setLocalApiKey("");
      setGeneralStatus("saved");
    } catch (error) {
      if (current.signal.aborted) return;
      setGeneralError(error instanceof Error ? error.message : "Failed to save settings. Please try again.");
      setGeneralStatus("idle");
    } finally { if (controller.current === current) pendingSave.current = false; }
  };

  const handleSaveNotifications = async () => {
    const current = beginSave(); if (!current) return;
    setNotifStatus("saving");
    setNotifError("");
    try {
      await saveSettingsToDB({ notificationsEnabled: effectiveNotificationsEnabled,
        ...(localDiscordWebhook.trim() ? { discordWebhook: localDiscordWebhook } : {}),
      }, { signal: current.signal });
      if (current.signal.aborted) return;
      setLocalNotificationsEnabled(null);
      setLocalDiscordWebhook("");
      setNotifStatus("saved");
    } catch (error) {
      if (current.signal.aborted) return;
      setNotifError(error instanceof Error ? error.message : "Failed to save notification settings. Please try again.");
      setNotifStatus("idle");
    } finally { if (controller.current === current) pendingSave.current = false; }
  };

  const handleSaveActivity = async () => {
    const current = beginSave(); if (!current) return;
    setActivityStatus("saving");
    setActivityError("");
    try {
      await saveSettingsToDB({ inactivityThreshold: effectiveInactivityThreshold }, { signal: current.signal });
      if (current.signal.aborted) return;
      setLocalInactivityThreshold(null);
      setActivityStatus("saved");
    } catch (error) {
      if (current.signal.aborted) return;
      setActivityError(error instanceof Error ? error.message : "Failed to save activity settings. Please try again.");
      setActivityStatus("idle");
    } finally { if (controller.current === current) pendingSave.current = false; }
  };

  return (
    <LayoutWrapper>
      <AdminGate>
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold"><T text="Settings" /></h1>
        </div>

        {isLoadingSettings || !hasLoadedSettings ? (
          <p role="status" className="py-8 text-muted-foreground"><T text="Loading..." /></p>
        ) : settingsError ? (
          <Card><CardContent className="space-y-3 pt-6">
            <p role="alert"><T text="Could not load settings. Please try again." /></p>
            <Button onClick={() => { void loadSettingsFromDB(true).catch(() => {}); }}><T text="Retry" /></Button>
          </CardContent></Card>
        ) : <Tabs defaultValue={apiKeyConfigured && clubTag ? "activity" : "general"} className="space-y-4">
              <TabsList className="flex flex-wrap h-auto gap-1 p-1">
                <TabsTrigger value="activity" className="text-xs sm:text-sm"><T text="Activity" /></TabsTrigger>
                <TabsTrigger value="notifications" className="text-xs sm:text-sm"><T text="Notifications" /></TabsTrigger>
                <TabsTrigger value="general" className="text-xs sm:text-sm"><T text="Club connection" /></TabsTrigger>
              </TabsList>

              {/* General Settings */}
              <TabsContent value="general">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Key className="h-5 w-5" />
                      <T text="Club connection" /></CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="settings-club-tag" className="text-sm font-medium"><T text="Club Tag" /></label>
                      <Input
                        id="settings-club-tag"
                        aria-describedby="settings-club-tag-hint"
                        dir="ltr"
                        spellCheck={false}
                        placeholder="#ABC123"
                        value={effectiveClubTag}
                        onChange={(e) => { setLocalClubTag(e.target.value.toUpperCase()); setGeneralStatus("idle"); }}
                        disabled={saving}
                      />
                      <p id="settings-club-tag-hint" className="text-xs text-muted-foreground">
                        <T text=" Your club&apos;s unique tag (found in-game) " /></p>
                    </div>

                    <details open={!apiKeyConfigured} className="rounded-lg border p-3">
                      <summary className="cursor-pointer text-sm font-medium"><T text={apiKeyConfigured ? "Change API key" : "Set up API key"} /></summary>
                      <div className="mt-3 space-y-2">
                      <label htmlFor="settings-api-key" className="text-sm font-medium"><T text="API Key" /></label>
                      <Input
                        id="settings-api-key"
                        aria-describedby="settings-api-key-hint"
                        dir="ltr"
                        type="password"
                        placeholder={t(apiKeyConfigured ? "Stored API key configured" : "Enter your API key")}
                        value={localApiKey}
                        onChange={(e) => { setLocalApiKey(e.target.value); setGeneralStatus("idle"); }}
                        disabled={saving}
                        autoComplete="off"
                      />
                      <p id="settings-api-key-hint" className="text-xs text-muted-foreground">
                        {apiKeyConfigured ? <T text="Leave blank to keep the saved key. " /> : ""}
                        <T text=" Get your API key from" />{" "}
                        <a
                          href="https://developer.brawlstars.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          <T text=" developer.brawlstars.com " /><ExternalLink className="h-3 w-3" />
                        </a>
                      </p>
                      </div>
                    </details>

                    {generalError && <p role="alert" className="text-sm text-destructive">{t(generalError)}</p>}
                    <Button onClick={handleSaveGeneral} disabled={saving || !effectiveClubTag.trim()}>
                      {generalStatus === "saving" ? (
                        t("Saving...")
                      ) : generalStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 me-2" />
                          <T text=" Saved! " /></>
                      ) : (
                        <>
                          <Save className="h-4 w-4 me-2" />
                          <T text=" Save Changes " /></>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Activity Settings */}
              <TabsContent value="activity">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-5 w-5" />
                      <T text=" Activity Tracking " /></CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="settings-inactivity-threshold" className="text-sm font-medium">
                        <T text=" Inactivity Threshold (hours) " /></label>
                      <Input
                        id="settings-inactivity-threshold"
                        aria-describedby="settings-inactivity-hint"
                        dir="ltr"
                        type="number"
                        min="48"
                        max="168"
                        value={effectiveInactivityThreshold}
                        disabled={saving}
                        onChange={(e) => {
                          setLocalInactivityThreshold(parseBoundedInput(e.target.value, 48, 48, 168));
                          setActivityStatus("idle");
                        }}
                      />
                      <p id="settings-inactivity-hint" className="text-xs text-muted-foreground">
                        <T text=" Players with no recorded battle or trophy change past this threshold are marked inactive " /></p>
                    </div>

                    <details className="p-4 rounded-lg bg-muted/50">
                      <summary className="cursor-pointer font-medium"><T text="How activity is measured" /></summary>
                      <div className="mt-3 space-y-3">
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li><T text="Active: battle or trophy change in the last 24 hours" /></li>
                        <li><T text="Low activity: last recorded activity between 24 and " />{effectiveInactivityThreshold} <T text=" hours ago" /></li>
                        <li><T text="Inactive: no recorded activity for more than " />{effectiveInactivityThreshold} <T text=" hours" /></li>
                        <li><T text="Unknown: no valid activity evidence yet" /></li>
                      </ul>
                      </div>
                    </details>

                    {activityError && <p role="alert" className="text-sm text-destructive">{t(activityError)}</p>}
                    <Button onClick={handleSaveActivity} disabled={saving}>
                      {activityStatus === "saving" ? (
                        t("Saving...")
                      ) : activityStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 me-2" />
                          <T text=" Saved! " /></>
                      ) : (
                        <>
                          <Save className="h-4 w-4 me-2" />
                          <T text=" Save Changes " /></>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Notifications Settings */}
              <TabsContent value="notifications">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Bell className="h-5 w-5" />
                      <T text=" Notifications " /></CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label htmlFor="settings-notifications" className="font-medium"><T text="Enable Notifications" /></label>
                      </div>
                      <Switch
                        id="settings-notifications"
                        checked={effectiveNotificationsEnabled}
                        onCheckedChange={(value) => { setLocalNotificationsEnabled(value); setNotifStatus("idle"); }}
                        disabled={saving}
                      />
                    </div>

                    <details className="rounded-lg border p-3">
                      <summary className="cursor-pointer text-sm font-medium"><T text="Discord delivery" /> · <span className="font-normal text-muted-foreground"><T text={discordWebhookConfigured ? "Configured" : "Optional"} /></span></summary>
                      <div className="mt-3 space-y-2">
                      <label htmlFor="settings-discord-webhook" className="text-sm font-medium"><T text="Discord Webhook URL" /></label>
                      <Input
                        id="settings-discord-webhook"
                        aria-describedby="settings-discord-webhook-hint"
                        dir="ltr"
                        spellCheck={false}
                        type="password"
                        placeholder={discordWebhookConfigured ? t("Stored webhook configured") : "https://discord.com/api/webhooks/..."}
                        value={localDiscordWebhook}
                        onChange={(e) => { setLocalDiscordWebhook(e.target.value); setNotifStatus("idle"); }}
                        disabled={saving}
                        autoComplete="off"
                      />
                      <p id="settings-discord-webhook-hint" className="text-xs text-muted-foreground">
                        <T text=" Optional: Send notifications to a Discord channel. " />{discordWebhookConfigured ? <T text=" Leave blank to keep the saved webhook." /> : ""}
                      </p>
                      </div>
                    </details>

                    <details className="p-4 rounded-lg bg-muted/50">
                      <summary className="cursor-pointer font-medium"><T text="Notification Events" /></summary>
                      <ul className="mt-3 text-sm text-muted-foreground space-y-1">
                        <li><T text="• Member joins the club" /></li>
                        <li><T text="• Member leaves the club" /></li>
                        <li><T text="• Inactive members summary (once per day)" /></li>
                      </ul>
                    </details>

                    {notifError && <p role="alert" className="text-sm text-destructive">{t(notifError)}</p>}
                    <Button onClick={handleSaveNotifications} disabled={saving}>
                      {notifStatus === "saving" ? (
                        t("Saving...")
                      ) : notifStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 me-2" />
                          <T text=" Saved! " /></>
                      ) : (
                        <>
                          <Save className="h-4 w-4 me-2" />
                          <T text=" Save Changes " /></>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Appearance Settings */}
              <details className="rounded-lg border bg-card p-4">
                <summary className="cursor-pointer font-medium"><Palette className="me-2 inline h-4 w-4" /><T text="Appearance" /></summary>
                  <div className="mt-4 space-y-4">
                    <fieldset>
                      <legend className="text-sm font-medium mb-3"><T text="Theme" /></legend>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          aria-pressed={theme === "light"}
                          onClick={() => setTheme("light")}
                          className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                            theme === "light"
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <div className="h-8 rounded bg-white border mb-2" aria-hidden="true"></div>
                          <p className="font-medium"><T text="Light" /></p>
                        </button>
                        <button
                          type="button"
                          aria-pressed={theme === "dark"}
                          onClick={() => setTheme("dark")}
                          className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                            theme === "dark"
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <div className="h-8 rounded bg-zinc-900 border border-zinc-700 mb-2" aria-hidden="true"></div>
                          <p className="font-medium"><T text="Dark" /></p>
                        </button>
                      </div>
                    </fieldset>
                  </div>
              </details>

              {/* Data Settings */}
              <details className="rounded-lg border bg-card p-4">
                <summary className="cursor-pointer font-medium"><Database className="me-2 inline h-4 w-4" /><T text="History and backups" /></summary>
                    <div className="mt-4">
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li><T text="Display preferences are saved on this device." /></li>
                        <li><T text="Club history is saved securely and backed up daily." /></li>
                        <li><T text="Account trophy history is retained for 91 days to support 90-day comparisons; daily summaries for 365 days." /></li>
                      </ul>
                    </div>

              </details>
            </Tabs>}
          </div>
      </AdminGate>
    </LayoutWrapper>
  );
}
