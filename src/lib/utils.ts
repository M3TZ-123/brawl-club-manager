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
  if (lowerRank.includes("pro")) return "text-pink-500";
  if (lowerRank.includes("masters")) return "text-purple-500";
  if (lowerRank.includes("legendary")) return "text-yellow-500";
  if (lowerRank.includes("mythic")) return "text-red-500";
  if (lowerRank.includes("diamond")) return "text-cyan-500";
  if (lowerRank.includes("gold")) return "text-yellow-400";
  if (lowerRank.includes("silver")) return "text-gray-400";
  if (lowerRank.includes("bronze")) return "text-amber-700";
  return "text-muted-foreground";
}

export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay} days ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)} weeks ago`;
  return formatDate(date);
}
