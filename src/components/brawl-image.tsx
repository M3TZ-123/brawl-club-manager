"use client";

import Image from "next/image";
import { useState } from "react";

export function BrawlImage({ src, alt, width, height, className, fallback }: {
  src: string; alt: string; width: number; height: number; className?: string; fallback?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return <span role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}
    className={`inline-flex shrink-0 items-center justify-center ${className || ""}`} style={{ width, height }}>{fallback || alt.trim().slice(0, 1) || "⚔️"}</span>;
  return <Image src={src} alt={alt} width={width} height={height} className={className} onError={() => setFailed(src)} />;
}
