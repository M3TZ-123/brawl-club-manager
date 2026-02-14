import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawl-club-manager.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const routes = [
    "",
    "/activity",
    "/battle-feed",
    "/history",
    "/members",
    "/notifications",
    "/reports",
    "/settings",
  ];

  return routes.map((route) => ({
    url: `${siteUrl}${route}`,
    lastModified: now,
    changeFrequency: route === "" ? "daily" : "hourly",
    priority: route === "" ? 1 : 0.7,
  }));
}
