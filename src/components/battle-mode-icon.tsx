import { Swords } from "lucide-react";
import { BrawlImage } from "@/components/brawl-image";
import { getBattleModeInfo } from "@/lib/battle-catalog";

type BattleMode = string | null | undefined | ReturnType<typeof getBattleModeInfo>;

// Adjacent mode labels already name decorative icons. Pass label for standalone use.
export function BattleModeIcon({ mode, modeId, size = 20, className = "", label = "" }: {
  mode: BattleMode;
  modeId?: number | null;
  size?: number;
  className?: string;
  label?: string;
}) {
  const info = mode && typeof mode === "object" ? mode : getBattleModeInfo(mode, modeId);
  const fallback = <Swords aria-hidden="true" className="h-full w-full" strokeWidth={1.75} />;
  return info.imageUrl
    ? <BrawlImage src={info.imageUrl} alt={label} width={size} height={size} className={`shrink-0 object-contain ${className}`} fallback={fallback} />
    : <span role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}
      className={`inline-flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size }}>{fallback}</span>;
}
