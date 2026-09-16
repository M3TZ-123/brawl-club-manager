"use client";
import { T, useI18n } from "@/components/locale-provider";


import { useState, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  const {
    clubTag,
    apiKeyConfigured,
    theme,
    inactivityThreshold,
    notificationsEnabled,
    discordWebhookConfigured,
    setClubTag,
    setApiKey,
    setTheme,
    setInactivityThreshold,
    setNotificationsEnabled,
    setDiscordWebhook,
    saveSettingsToDB,
    loadSettingsFromDB,
    hasLoadedSettings,
  } = useAppStore();

  const [localClubTag, setLocalClubTag] = useState<string | null>(null);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localDiscordWebhook, setLocalDiscordWebhook] = useState("");
  const [localInactivityThreshold, setLocalInactivityThreshold] = useState<number | null>(null);
  const [generalStatus, setGeneralStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [activityStatus, setActivityStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [notifStatus, setNotifStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    if (!hasLoadedSettings) {
      loadSettingsFromDB();
    }
  }, [hasLoadedSettings, loadSettingsFromDB]);

  const effectiveClubTag = localClubTag ?? clubTag;
  const effectiveInactivityThreshold = localInactivityThreshold ?? inactivityThreshold;

  const parseBoundedInput = (value: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };

  const handleSaveGeneral = async () => {
    setGeneralStatus("saving");
    try {
      setClubTag(effectiveClubTag);
      if (localApiKey.trim()) {
        setApiKey(localApiKey);
      }
      await saveSettingsToDB();
      setLocalApiKey("");
      setGeneralStatus("saved");
      setTimeout(() => setGeneralStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save general settings:", error);
      alert(t("Failed to save settings. Please try again."));
      setGeneralStatus("idle");
    }
  };

  const handleSaveNotifications = async () => {
    setNotifStatus("saving");
    try {
      if (localDiscordWebhook.trim()) {
        setDiscordWebhook(localDiscordWebhook);
      }
      await saveSettingsToDB();
      setLocalDiscordWebhook("");
      setNotifStatus("saved");
      setTimeout(() => setNotifStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save notification settings:", error);
      alert(t("Failed to save notification settings. Please try again."));
      setNotifStatus("idle");
    }
  };

  const handleSaveActivity = async () => {
    setActivityStatus("saving");
    try {
      setInactivityThreshold(effectiveInactivityThreshold);
      await saveSettingsToDB();
      setActivityStatus("saved");
      setTimeout(() => setActivityStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save activity settings:", error);
      alert(t("Failed to save activity settings. Please try again."));
      setActivityStatus("idle");
    }
  };

  return (
    <LayoutWrapper>
      <AdminGate>
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold"><T text="Settings" /></h1>
          <p className="text-muted-foreground">
            <T text=" Configure your club manager preferences " /></p>
        </div>

        <Tabs defaultValue="general" className="space-y-4">
              <TabsList className="flex flex-wrap h-auto gap-1 p-1">
                <TabsTrigger value="general" className="text-xs sm:text-sm"><T text="General" /></TabsTrigger>
                <TabsTrigger value="activity" className="text-xs sm:text-sm"><T text="Activity" /></TabsTrigger>
                <TabsTrigger value="notifications" className="text-xs sm:text-sm"><T text="Notifications" /></TabsTrigger>
                <TabsTrigger value="appearance" className="text-xs sm:text-sm"><T text="Appearance" /></TabsTrigger>
                <TabsTrigger value="data" className="text-xs sm:text-sm"><T text="Data" /></TabsTrigger>
              </TabsList>

              {/* General Settings */}
              <TabsContent value="general">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Key className="h-5 w-5" />
                      <T text=" API Configuration " /></CardTitle>
                    <CardDescription>
                      <T text=" Configure your Brawl Stars API connection " /></CardDescription>
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
                        onChange={(e) => setLocalClubTag(e.target.value.toUpperCase())}
                      />
                      <p id="settings-club-tag-hint" className="text-xs text-muted-foreground">
                        <T text=" Your club&apos;s unique tag (found in-game) " /></p>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="settings-api-key" className="text-sm font-medium"><T text="API Key" /></label>
                      <Input
                        id="settings-api-key"
                        aria-describedby="settings-api-key-hint"
                        dir="ltr"
                        type="password"
                        placeholder={t(apiKeyConfigured ? "Stored API key configured" : "Enter your API key")}
                        value={localApiKey}
                        onChange={(e) => setLocalApiKey(e.target.value)}
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

                    <Button onClick={handleSaveGeneral} disabled={generalStatus === "saving"}>
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
                    <CardDescription>
                      <T text=" Configure how activity is tracked and measured " /></CardDescription>
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
                        onChange={(e) =>
                          setLocalInactivityThreshold(parseBoundedInput(e.target.value, 48, 48, 168))
                        }
                      />
                      <p id="settings-inactivity-hint" className="text-xs text-muted-foreground">
                        <T text=" Players with no recorded battle or trophy change past this threshold are marked inactive " /></p>
                    </div>

                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2"><T text="Sync Schedule" /></h4>
                      <p className="text-sm text-muted-foreground">
                        <T text="View sync and storage details in the Admin page. Use Sync Now for an immediate update." /></p>
                    </div>

                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2"><T text="Activity Detection" /></h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li><T text="Active: battle or trophy change in the last 24 hours" /></li>
                        <li><T text="Low activity: last recorded activity between 24 and " />{effectiveInactivityThreshold} <T text=" hours ago" /></li>
                        <li><T text="Inactive: no recorded activity for more than " />{effectiveInactivityThreshold} <T text=" hours" /></li>
                      </ul>
                    </div>

                    <Button onClick={handleSaveActivity} disabled={activityStatus === "saving"}>
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
                    <CardDescription>
                      <T text=" Configure alerts and notifications " /></CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label htmlFor="settings-notifications" className="font-medium"><T text="Enable Notifications" /></label>
                        <p id="settings-notifications-hint" className="text-sm text-muted-foreground">
                          <T text=" Receive alerts for important events " /></p>
                      </div>
                      <Switch
                        id="settings-notifications"
                        aria-describedby="settings-notifications-hint"
                        checked={notificationsEnabled}
                        onCheckedChange={setNotificationsEnabled}
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="settings-discord-webhook" className="text-sm font-medium"><T text="Discord Webhook URL" /></label>
                      <Input
                        id="settings-discord-webhook"
                        aria-describedby="settings-discord-webhook-hint"
                        dir="ltr"
                        spellCheck={false}
                        type="url"
                        placeholder={discordWebhookConfigured ? t("Stored webhook configured") : "https://discord.com/api/webhooks/..."}
                        value={localDiscordWebhook}
                        onChange={(e) => setLocalDiscordWebhook(e.target.value)}
                        autoComplete="off"
                      />
                      <p id="settings-discord-webhook-hint" className="text-xs text-muted-foreground">
                        <T text=" Optional: Send notifications to a Discord channel. " />{discordWebhookConfigured ? <T text=" Leave blank to keep the saved webhook." /> : ""}
                      </p>
                    </div>

                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2"><T text="Notification Events" /></h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li><T text="• Member joins the club" /></li>
                        <li><T text="• Member leaves the club" /></li>
                        <li><T text="• Inactive members summary (once per day)" /></li>
                      </ul>
                    </div>

                    <Button onClick={handleSaveNotifications} disabled={notifStatus === "saving"}>
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
              <TabsContent value="appearance">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Palette className="h-5 w-5" />
                      <T text=" Appearance " /></CardTitle>
                    <CardDescription>
                      <T text=" Customize the look and feel " /></CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
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
                          <div className="h-20 rounded bg-white border mb-2"></div>
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
                          <div className="h-20 rounded bg-zinc-900 border border-zinc-700 mb-2"></div>
                          <p className="font-medium"><T text="Dark" /></p>
                        </button>
                      </div>
                    </fieldset>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Data Settings */}
              <TabsContent value="data">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Database className="h-5 w-5" />
                      <T text=" Data Management " /></CardTitle>
                    <CardDescription>
                      <T text=" Manage your stored data " /></CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2"><T text="History and backups" /></h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li><T text="Display preferences are saved on this device." /></li>
                        <li><T text="Club history is saved securely and backed up daily." /></li>
                        <li><T text="Account trophy history is retained for 91 days to support 90-day comparisons; daily summaries for 365 days." /></li>
                      </ul>
                    </div>

                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
      </AdminGate>
    </LayoutWrapper>
  );
}
