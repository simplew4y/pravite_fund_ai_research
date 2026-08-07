import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PackageCheckIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getInstalledSkills,
  installMarketplaceSkill,
  type InstalledSkill,
  type MarketplaceSearchResponse,
  type MarketplaceSkill,
  searchMarketplaceSkills,
  uninstallSkill,
} from "@/lib/skillsMarketplaceApi";
import { cn } from "@/lib/utils";

const DEFAULT_QUERY = "investment research";
const QUICK_SEARCHES = [
  { label: "投资研究", query: "investment research" },
  { label: "财务建模", query: "financial modeling" },
  { label: "估值分析", query: "DCF valuation" },
  { label: "尽职调查", query: "investment due diligence" },
  { label: "SEC 披露", query: "SEC filings" },
] as const;

type SkillsView = "marketplace" | "installed";

function displayStars(stars: number): string {
  if (stars >= 10_000) return `${(stars / 1000).toFixed(0)}k`;
  if (stars >= 1_000) return `${(stars / 1000).toFixed(1)}k`;
  return String(stars);
}

function MarketplaceCard({
  skill,
  busy,
  onInstall,
}: {
  skill: MarketplaceSkill;
  busy: boolean;
  onInstall: (skill: MarketplaceSkill) => void;
}) {
  return (
    <article className="flex min-h-52 flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground" title={skill.name}>
            {skill.name}
          </h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">by {skill.author}</p>
        </div>
        {skill.installed && (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <CheckIcon className="size-3" />
            已安装
          </Badge>
        )}
      </div>

      <p className="mt-4 line-clamp-4 flex-1 text-sm leading-6 text-muted-foreground">
        {skill.description}
      </p>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <StarIcon className="size-3.5" />
            {displayStars(skill.stars)}
          </span>
          <a
            href={skill.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            查看来源
            <ExternalLinkIcon className="size-3" />
          </a>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={skill.installed || busy}
          onClick={() => onInstall(skill)}
          className="shrink-0"
          aria-label={`${skill.installed ? "已安装" : "安装"} ${skill.name}`}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {skill.installed ? "已安装" : "Install"}
        </Button>
      </div>
    </article>
  );
}

function InstalledCard({
  skill,
  busy,
  confirming,
  onUninstall,
  onCancel,
}: {
  skill: InstalledSkill;
  busy: boolean;
  confirming: boolean;
  onUninstall: (skill: InstalledSkill) => void;
  onCancel: () => void;
}) {
  return (
    <article className="flex min-h-48 flex-col rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{skill.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {skill.author ? `by ${skill.author}` : "本地技能"}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 gap-1">
          <PackageCheckIcon className="size-3" />
          {skill.managed ? "市场安装" : "本地安装"}
        </Badge>
      </div>
      <p className="mt-4 line-clamp-4 flex-1 text-sm leading-6 text-muted-foreground">
        {skill.description}
      </p>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        {skill.githubUrl ? (
          <a
            href={skill.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            查看来源
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">用户技能目录</span>
        )}
        <div className="flex items-center gap-2">
          {confirming && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={confirming ? "destructive" : "outline"}
            disabled={busy}
            onClick={() => onUninstall(skill)}
            aria-label={`${confirming ? "确认卸载" : "卸载"} ${skill.name}`}
          >
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <Trash2Icon className="size-4" />
            )}
            {confirming ? "确认卸载" : "卸载"}
          </Button>
        </div>
      </div>
    </article>
  );
}

export function SkillsSettingsSection() {
  const [view, setView] = useState<SkillsView>("marketplace");
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [marketplace, setMarketplace] = useState<MarketplaceSearchResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      setInstalled(await getInstalledSkills());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取已安装技能。");
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  const runSearch = useCallback(async (nextQuery: string, page = 1, append = false) => {
    const normalized = nextQuery.trim();
    if (normalized.length < 2) return;
    setLoadingMarket(true);
    setError(null);
    setNotice(null);
    try {
      const result = await searchMarketplaceSkills(normalized, page);
      setMarketplace((current) =>
        append && current ? { ...result, skills: [...current.skills, ...result.skills] } : result,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "技能市场暂时不可用。");
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  useEffect(() => {
    void runSearch(DEFAULT_QUERY);
    void refreshInstalled();
  }, [refreshInstalled, runSearch]);

  const installedMarketplaceIds = useMemo(
    () => new Set(installed.flatMap((skill) => (skill.marketplaceId ? [skill.marketplaceId] : []))),
    [installed],
  );
  const marketSkills = useMemo(
    () =>
      (marketplace?.skills ?? []).map((skill) => ({
        ...skill,
        installed: skill.installed || installedMarketplaceIds.has(skill.id),
      })),
    [installedMarketplaceIds, marketplace],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(query);
  };

  const chooseQuickSearch = (nextQuery: string) => {
    setQuery(nextQuery);
    void runSearch(nextQuery);
  };

  const install = async (skill: MarketplaceSkill) => {
    setBusyId(skill.id);
    setError(null);
    setNotice(null);
    try {
      await installMarketplaceSkill(skill.id);
      await refreshInstalled();
      setMarketplace((current) =>
        current
          ? {
              ...current,
              skills: current.skills.map((item) =>
                item.id === skill.id ? { ...item, installed: true } : item,
              ),
            }
          : current,
      );
      setNotice(`“${skill.name}”已安装，新建对话即可使用。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "技能安装失败。");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (skill: InstalledSkill) => {
    if (confirmingId !== skill.installId) {
      setConfirmingId(skill.installId);
      return;
    }
    setBusyId(skill.installId);
    setError(null);
    setNotice(null);
    try {
      await uninstallSkill(skill.installId);
      setInstalled((current) => current.filter((item) => item.installId !== skill.installId));
      setMarketplace((current) =>
        current
          ? {
              ...current,
              skills: current.skills.map((item) =>
                item.id === skill.marketplaceId ? { ...item, installed: false } : item,
              ),
            }
          : current,
      );
      setNotice(`“${skill.name}”已卸载，新建对话后不再加载。`);
      setConfirmingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "技能卸载失败。");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
            <h1 className="text-2xl font-semibold">技能 Skills</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            为研究助手安装专业工作流。技能按当前账号保存，不会影响其他用户。
          </p>
        </div>
        <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="技能视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === "marketplace"}
            onClick={() => setView("marketplace")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              view === "marketplace"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            技能市场
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "installed"}
            onClick={() => setView("installed")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              view === "installed"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            已安装 {installed.length > 0 ? `(${installed.length})` : ""}
          </button>
        </div>
      </div>

      <Alert className="mt-6 border-amber-500/25 bg-amber-500/5">
        <ShieldAlertIcon />
        <AlertTitle>安装前请确认来源可信</AlertTitle>
        <AlertDescription>
          社区技能可能包含指令、脚本和外部服务依赖。系统只允许从市场记录的公开 GitHub
          目录安装，并限制文件数量和体积，但不会替你保证第三方内容的安全性。
        </AlertDescription>
      </Alert>

      {(error || notice) && (
        <Alert
          variant={error ? "destructive" : "default"}
          className={cn("mt-4", !error && "border-emerald-500/25 bg-emerald-500/5")}
        >
          {error ? <ShieldAlertIcon /> : <CheckIcon />}
          <AlertTitle>{error ? "操作未完成" : "操作成功"}</AlertTitle>
          <AlertDescription aria-live="polite">{error ?? notice}</AlertDescription>
        </Alert>
      )}

      {view === "marketplace" ? (
        <div className="mt-6">
          <form onSubmit={submitSearch} className="flex max-w-2xl items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能，例如：估值、尽调、SEC filings"
                aria-label="搜索技能"
                className="pl-9"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={query.trim().length < 2 || loadingMarket}
            >
              {loadingMarket ? <Loader2Icon className="size-4 animate-spin" /> : null}
              搜索
            </Button>
          </form>

          <div className="mt-3 flex flex-wrap gap-2" aria-label="金融技能快捷搜索">
            {QUICK_SEARCHES.map((item) => (
              <Button
                key={item.query}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => chooseQuickSearch(item.query)}
              >
                {item.label}
              </Button>
            ))}
          </div>

          {marketplace?.warning && (
            <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">{marketplace.warning}</p>
          )}

          {loadingMarket && marketSkills.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              正在检索金融技能…
            </div>
          ) : marketSkills.length > 0 ? (
            <>
              <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
                {marketSkills.map((skill) => (
                  <MarketplaceCard
                    key={skill.id}
                    skill={skill}
                    busy={busyId === skill.id}
                    onInstall={(item) => void install(item)}
                  />
                ))}
              </div>
              {marketplace?.hasNext && (
                <div className="mt-6 flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loadingMarket}
                    onClick={() => void runSearch(marketplace.query, marketplace.page + 1, true)}
                  >
                    {loadingMarket && <Loader2Icon className="size-4 animate-spin" />}
                    加载更多
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center">
              <SearchIcon className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 font-medium">没有找到相关技能</p>
              <p className="mt-1 text-sm text-muted-foreground">尝试更短的英文或中文关键词。</p>
            </div>
          )}
        </div>
      ) : loadingInstalled ? (
        <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" />
          正在读取已安装技能…
        </div>
      ) : installed.length > 0 ? (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {installed.map((skill) => (
            <InstalledCard
              key={skill.installId}
              skill={skill}
              busy={busyId === skill.installId}
              confirming={confirmingId === skill.installId}
              onUninstall={(item) => void remove(item)}
              onCancel={() => setConfirmingId(null)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center">
          <PackageCheckIcon className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 font-medium">还没有安装技能</p>
          <p className="mt-1 text-sm text-muted-foreground">
            前往技能市场，选择适合你的研究工作流。
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={() => setView("marketplace")}
          >
            浏览技能市场
          </Button>
        </div>
      )}
    </section>
  );
}
