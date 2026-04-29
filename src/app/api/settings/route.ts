import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { rejectCrossOriginRequest } from "@/lib/request-security";

const SENSITIVE_KEYS = new Set(["api_key", "discord_webhook"]);

const ALLOWED_SETTING_KEYS = new Set([
  "club_tag",
  "club_name",
  "api_key",
  "discord_webhook",
  "inactivity_threshold",
  "refresh_interval",
  "notifications_enabled",
  "required_trophies",
  "last_sync_time",
  "last_inactive_notif",
  "last_inactive_alert",
]);

function sanitizeSettingValue(key: string, value: unknown): string | null {
  if (value == null) return null;

  if (key === "api_key" || key === "discord_webhook") {
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (key === "club_tag") {
    return String(value).trim().toUpperCase();
  }

  if (key === "club_name") {
    return String(value).trim().slice(0, 120);
  }

  if (key === "notifications_enabled") {
    return value === true || value === "true" ? "true" : "false";
  }

  if (key === "inactivity_threshold") {
    const parsed = Number.parseInt(String(value), 10);
    return String(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 168) : 24);
  }

  if (key === "refresh_interval") {
    const parsed = Number.parseInt(String(value), 10);
    return String(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 60), 1440) : 240);
  }

  if (key === "required_trophies") {
    if (value === "") return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : null;
  }

  return String(value).trim();
}

// GET - Retrieve non-sensitive settings
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("key, value");

    if (error) {
      throw error;
    }

    const settings: Record<string, string> = {};
    let apiKeyConfigured = Boolean(process.env.BRAWL_API_KEY);
    let discordWebhookConfigured = false;

    for (const row of data || []) {
      if (SENSITIVE_KEYS.has(row.key)) {
        if (row.key === "api_key") apiKeyConfigured = apiKeyConfigured || Boolean(row.value);
        if (row.key === "discord_webhook") discordWebhookConfigured = discordWebhookConfigured || Boolean(row.value);
      } else {
        settings[row.key] = row.value;
      }
    }

    if (!settings.club_tag && process.env.CLUB_TAG) {
      settings.club_tag = process.env.CLUB_TAG;
    }
    settings.api_key_configured = String(apiKeyConfigured);
    settings.discord_webhook_configured = String(discordWebhookConfigured);

    return NextResponse.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

// POST - Save settings
export async function POST(request: NextRequest) {
  try {
    const crossOriginResponse = rejectCrossOriginRequest(request);
    if (crossOriginResponse) return crossOriginResponse;

    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Invalid settings payload" },
        { status: 400 }
      );
    }

    const upserts = Object.entries(body)
      .filter(([key]) => ALLOWED_SETTING_KEYS.has(key))
      .map(([key, value]) => {
        const sanitizedValue = sanitizeSettingValue(key, value);
        if (sanitizedValue == null) return null;

        return {
          key,
          value: sanitizedValue,
        };
      })
      .filter((row): row is { key: string; value: string } => row != null);

    if (upserts.length > 0) {
      const { error } = await supabase
        .from("settings")
        .upsert(upserts, { onConflict: "key" });

      if (error) {
        throw error;
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving settings:", error);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
