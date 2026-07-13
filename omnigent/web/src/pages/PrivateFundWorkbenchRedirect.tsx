import { Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { readActivePrivateFundProjectId } from "@/lib/privateFundApi";
import { useNavigate, useParams } from "@/lib/routing";

/**
 * Compatibility-only redirect for old private-fund project URLs.
 * The legacy management page is intentionally no longer mounted.
 */
export function PrivateFundWorkbenchRedirect() {
  const navigate = useNavigate();
  const { datasetId = "" } = useParams<{ datasetId?: string }>();
  const target = useMemo(() => {
    const activeDatasetId = datasetId.trim() || readActivePrivateFundProjectId().trim();
    return activeDatasetId ? `/?private_fund_project=${encodeURIComponent(activeDatasetId)}` : "/";
  }, [datasetId]);

  useEffect(() => {
    navigate(target, { replace: true });
  }, [navigate, target]);

  return (
    <div
      aria-label="正在进入研究工作台"
      className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
      正在进入研究工作台…
    </div>
  );
}
