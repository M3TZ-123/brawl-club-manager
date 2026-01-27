"use client";

import { useState, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Save, 
  Key, 
  Bell, 
  Clock, 
  Palette, 
  Database, 
  AlertTriangle,
  CheckCircle,
  ExternalLink
} from "lucide-react";

export default function SettingsPage() {
  const {
    clubTag,
    apiKey,
    theme,
    inactivityThreshold,
    refreshInterval,
    notificationsEnabled,
    discordWebhook,
    setClubTag,
    setApiKey,
    setTheme,
    setInactivityThreshold,
    setRefreshInterval,
    setNotificationsEnabled,
    setDiscordWebhook,
  } = useAppStore();

  const [localClubTag, setLocalClubTag] = useState(clubTag);
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localDiscordWebhook, setLocalDiscordWebhook] = useState(discordWebhook);
  const [localInactivityThreshold, setLocalInactivityThreshold] = useState(inactivityThreshold);
  const [localRefreshInterval, setLocalRefreshInterval] = useState(refreshInterval);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    setLocalClubTag(clubTag);
    setLocalApiKey(apiKey);
    setLocalDiscordWebhook(discordWebhook);
    setLocalInactivityThreshold(inactivityThreshold);
    setLocalRefreshInterval(refreshInterval);
  }, [clubTag, apiKey, discordWebhook, inactivityThreshold, refreshInterval]);

  const handleSaveGeneral = () => {
    setSaveStatus("saving");
    setClubTag(localClubTag);
    setApiKey(localApiKey);
    setTimeout(() => {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    }, 500);
  };

  const handleSaveNotifications = () => {
    setSaveStatus("saving");
    setDiscordWebhook(localDiscordWebhook);
    setTimeout(() => {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    }, 500);
  };

  const handleSaveActivity = () => {
    setSaveStatus("saving");
    setInactivityThreshold(localInactivityThreshold);
    setRefreshInterval(localRefreshInterval);
    setTimeout(() => {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    }, 500);
  };

  const handleClearData = () => {
    if (confirm("Are you sure you want to clear all local data? This cannot be undone.")) {
      localStorage.clear();
      window.location.reload();
    }
  };

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto space-y-6">
            <div>
              <h1 className="text-2xl font-bold">Settings</h1>
              <p className="text-muted-foreground">
                Configure your club manager preferences
              </p>
            </div>

            <Tabs defaultValue="general" className="space-y-4">
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="activity">Activity Tracking</TabsTrigger>
                <TabsTrigger value="notifications">Notifications</TabsTrigger>
                <TabsTrigger value="appearance">Appearance</TabsTrigger>
                <TabsTrigger value="data">Data</TabsTrigger>
              </TabsList>

              {/* General Settings */}
              <TabsContent value="general">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Key className="h-5 w-5" />
                      API Configuration
                    </CardTitle>
                    <CardDescription>
                      Configure your Brawl Stars API connection
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Club Tag</label>
                      <Input
                        placeholder="#ABC123"
                        value={localClubTag}
                        onChange={(e) => setLocalClubTag(e.target.value.toUpperCase())}
                      />
                      <p className="text-xs text-muted-foreground">
                        Your club&apos;s unique tag (found in-game)
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        type="password"
                        placeholder="Enter your API key"
                        value={localApiKey}
                        onChange={(e) => setLocalApiKey(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Get your API key from{" "}
                        <a
                          href="https://developer.brawlstars.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          developer.brawlstars.com
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </p>
                    </div>

                    <Button onClick={handleSaveGeneral} disabled={saveStatus === "saving"}>
                      {saveStatus === "saving" ? (
                        "Saving..."
                      ) : saveStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 mr-2" />
                          Saved!
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Save Changes
                        </>
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
                      Activity Tracking
                    </CardTitle>
                    <CardDescription>
                      Configure how activity is tracked and measured
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Inactivity Threshold (hours)
                      </label>
                      <Input
                        type="number"
                        min="1"
                        max="168"
                        value={localInactivityThreshold}
                        onChange={(e) =>
                          setLocalInactivityThreshold(parseInt(e.target.value) || 24)
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Players with no trophy changes for this many hours are marked inactive
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Auto-Sync Interval (minutes)
                      </label>
                      <Input
                        type="number"
                        min="60"
                        max="1440"
                        step="60"
                        value={localRefreshInterval}
                        onChange={(e) =>
                          setLocalRefreshInterval(parseInt(e.target.value) || 240)
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        How often to automatically sync data (minimum 60 minutes)
                      </p>
                    </div>

                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2">Activity Detection</h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li>🟢 <strong>Active:</strong> ±20+ trophy change</li>
                        <li>🟡 <strong>Minimal:</strong> Small trophy change (streak keeper)</li>
                        <li>🔴 <strong>Inactive:</strong> No changes past threshold</li>
                      </ul>
                    </div>

                    <Button onClick={handleSaveActivity} disabled={saveStatus === "saving"}>
                      {saveStatus === "saving" ? (
                        "Saving..."
                      ) : saveStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 mr-2" />
                          Saved!
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Save Changes
                        </>
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
                      Notifications
                    </CardTitle>
                    <CardDescription>
                      Configure alerts and notifications
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Enable Notifications</p>
                        <p className="text-sm text-muted-foreground">
                          Receive alerts for important events
                        </p>
                      </div>
                      <Switch
                        checked={notificationsEnabled}
                        onCheckedChange={setNotificationsEnabled}
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Discord Webhook URL</label>
                      <Input
                        type="url"
                        placeholder="https://discord.com/api/webhooks/..."
                        value={localDiscordWebhook}
                        onChange={(e) => setLocalDiscordWebhook(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Optional: Send notifications to a Discord channel
                      </p>
                    </div>

                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2">Notification Events</h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li>• Member joins the club</li>
                        <li>• Member leaves the club</li>
                        <li>• Member inactive for 48+ hours</li>
                        <li>• Weekly report available</li>
                      </ul>
                    </div>

                    <Button onClick={handleSaveNotifications} disabled={saveStatus === "saving"}>
                      {saveStatus === "saving" ? (
                        "Saving..."
                      ) : saveStatus === "saved" ? (
                        <>
                          <CheckCircle className="h-4 w-4 mr-2" />
                          Saved!
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Save Changes
                        </>
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
                      Appearance
                    </CardTitle>
                    <CardDescription>
                      Customize the look and feel
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <label className="text-sm font-medium mb-3 block">Theme</label>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setTheme("light")}
                          className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                            theme === "light"
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <div className="h-20 rounded bg-white border mb-2"></div>
                          <p className="font-medium">Light</p>
                        </button>
                        <button
                          onClick={() => setTheme("dark")}
                          className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                            theme === "dark"
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <div className="h-20 rounded bg-zinc-900 border border-zinc-700 mb-2"></div>
                          <p className="font-medium">Dark</p>
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Data Settings */}
              <TabsContent value="data">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Database className="h-5 w-5" />
                      Data Management
                    </CardTitle>
                    <CardDescription>
                      Manage your stored data
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="p-4 rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2">Storage Info</h4>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        <li>• Local settings stored in browser</li>
                        <li>• Member data synced to Supabase database</li>
                        <li>• Activity logs retained for 30 days</li>
                      </ul>
                    </div>

                    <div className="border-t pt-4">
                      <div className="flex items-start gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/20">
                        <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
                        <div>
                          <h4 className="font-medium text-destructive">Danger Zone</h4>
                          <p className="text-sm text-muted-foreground mb-3">
                            Clear all locally stored data. This will reset your settings and
                            require reconfiguration.
                          </p>
                          <Button variant="destructive" onClick={handleClearData}>
                            Clear Local Data
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </main>
      </div>
    </div>
  );
}
