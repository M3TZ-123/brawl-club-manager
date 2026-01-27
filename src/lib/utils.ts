import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTag(tag: string): string {
  return tag.startsWith("#") ? tag : `#${tag}`;
}

export function encodeTag(tag: string): string {
  return encodeURIComponent(formatTag(tag));
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getActivityStatus(
  trophyChange: number,
  hoursSinceLastChange: number
): "active" | "minimal" | "inactive" {
  if (hoursSinceLastChange > 24) return "inactive";
  if (Math.abs(trophyChange) >= 20) return "active";
  if (Math.abs(trophyChange) > 0) return "minimal";
  return "inactive";
}

export function getActivityColor(status: "active" | "minimal" | "inactive"): string {
  switch (status) {
    case "active":
      return "text-green-500";
    case "minimal":
      return "text-yellow-500";
    case "inactive":
      return "text-red-500";
  }
}

export function getActivityEmoji(status: "active" | "minimal" | "inactive"): string {
  switch (status) {
    case "active":
      return "🟢";
    case "minimal":
      return "🟡";
    case "inactive":
      return "🔴";
  }
}

export function getRankColor(rank: string): string {
  const lowerRank = rank.toLowerCase();
  if (lowerRank.includes("unranked")) return "text-muted-foreground";
  if (lowerRank.includes("masters") || lowerRank.includes("pro")) return "text-purple-500";
  if (lowerRank.includes("legendary")) return "text-yellow-500";
  if (lowerRank.includes("mythic")) return "text-red-500";
  if (lowerRank.includes("diamond")) return "text-cyan-500";
  if (lowerRank.includes("gold")) return "text-yellow-400";
  if (lowerRank.includes("silver")) return "text-gray-400";
  if (lowerRank.includes("bronze")) return "text-amber-700";
  return "text-muted-foreground";
}
