import { useServerInfo } from "@/lib/CapabilitiesContext";
import { cn } from "@/lib/utils";

export function ProductVersionLabel({ className }: { className?: string }) {
  const info = useServerInfo();
  const version = info === "loading" ? null : info.product_version;

  if (!version) return null;

  return (
    <span
      data-testid="product-version"
      className={cn("whitespace-nowrap text-[10px] font-normal text-muted-foreground", className)}
      title={`工作台版本 ${version}`}
    >
      v{version}
    </span>
  );
}
