"use client";

import Image from "next/image";
import { type ReactNode, useState } from "react";
import { ImageOff } from "lucide-react";

export function BrawlImage({ src, alt, width, height, className, fallback }: {
  src: string | null | undefined; alt: string; width: number; height: number; className?: string; fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <span role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}
    className={`inline-flex shrink-0 items-center justify-center ${className || ""}`} style={{ width, height }}>{fallback ?? <ImageOff aria-hidden="true" className="h-full w-full" strokeWidth={1.5} />}</span>;
  return <Image src={src} alt={alt} width={width} height={height} className={className} onError={() => setFailed(src)} />;
}
