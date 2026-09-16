import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brawlstatz.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const routes = [
    "",
    "/activity",
    "/battle-feed",
    "/history",
    "/members",
    "/reports",
    "/analysis",
    "/readiness",
    "/game",
    "/rivals",
    "/club-planning",
    "/join",
  ];

  return routes.map((route) => ({
    url: `${siteUrl}${route}`,
    lastModified: now,
    changeFrequency: route === "" ? "daily" : "hourly",
    priority: route === "" ? 1 : 0.7,
  }));
}
