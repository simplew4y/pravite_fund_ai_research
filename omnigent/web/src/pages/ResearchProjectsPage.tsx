import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  FileTextIcon,
  FolderInputIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { PageScroll } from "@/components/PageScroll";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  activatePrivateFundProject,
  createPrivateFundProject,
  deletePrivateFundFile,
  type PrivateFundFile,
  type PrivateFundProject,
  runPrivateFundPipeline,
  uploadPrivateFundFiles,
  writeActivePrivateFundProjectId,
} from "@/lib/privateFundApi";
import { Link, useNavigate, useParams } from "@/lib/routing";
import {
  privateFundProjectsQueryKey,
  usePrivateFundProject,
  usePrivateFundProjects,
} from "@/hooks/usePrivateFundProjects";
import { cn } from "@/lib/utils";

const EMPTY_PROJECTS: PrivateFundProject[] = [];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatTime(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: string): string {
  switch (status) {
    case "completed":
    case "indexed":
      return "border-success/30 bg-success/10 text-success";
    case "queued":
    case "running":
    case "indexing":
      return "border-warning/30 bg-warning/10 text-warning";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function StatusBadge({ status }: { status: string }) {
  const label =
    status === "completed"
      ? "Ready"
      : status === "indexing" || status === "running"
        ? "Indexing"
        : status === "queued"
          ? "Queued"
          : status === "draft"
            ? "Draft"
            : status === "failed"
              ? "Failed"
              : status;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
        statusTone(status),
      )}
    >
      {label}
    </span>
  );
}

export function ResearchProjectsPage() {
  const { datasetId } = useParams<{ datasetId?: string }>();
  return datasetId ? <ProjectDetail datasetId={datasetId} /> : <ProjectsIndex />;
}

function ProjectsIndex() {
  const navigate = useNavigate();
  const query = usePrivateFundProjects();
  const projects = query.data ?? EMPTY_PROJECTS;
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(q) || project.datasetId.toLowerCase().includes(q),
    );
  }, [projects, search]);

  return (
    <PageScroll contentClassName="px-8" extraBottom="2.5rem">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Research Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage source files, run the private-fund pipeline, then start project-scoped Q&A or
            memo work.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            <RefreshCwIcon className="size-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            New project
          </Button>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <SearchIcon className="size-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[minmax(220px,1fr)_110px_120px_120px_160px] border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>Project</span>
          <span>Files</span>
          <span>Chunks</span>
          <span>Status</span>
          <span className="text-right">Updated</span>
        </div>
        {query.isLoading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading projects…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <FolderInputIcon className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No research projects yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one, upload PDFs or Excel files, then run pipeline.
              </p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-4" />
              New project
            </Button>
          </div>
        ) : (
          filtered.map((project) => (
            <button
              key={project.datasetId}
              type="button"
              onClick={() =>
                navigate(`/research-projects/${encodeURIComponent(project.datasetId)}`)
              }
              className="grid w-full grid-cols-[minmax(220px,1fr)_110px_120px_120px_160px] items-center border-b border-border px-4 py-3 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/50"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.datasetId}
                </span>
              </span>
              <span>{project.uploadCount || project.fileCount}</span>
              <span>{project.chunkCount.toLocaleString()}</span>
              <StatusBadge status={project.latestJob?.status ?? project.status} />
              <span className="text-right text-xs text-muted-foreground">
                {formatTime(project.updatedAt)}
              </span>
            </button>
          ))
        )}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(project) =>
          navigate(`/research-projects/${encodeURIComponent(project.datasetId)}`)
        }
      />
    </PageScroll>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: PrivateFundProject) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [ticker, setTicker] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      createPrivateFundProject({
        name: name.trim(),
        companyName: companyName.trim(),
        companyTicker: ticker.trim(),
      }),
    onSuccess: (project) => {
      writeActivePrivateFundProjectId(project.datasetId);
      void queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey });
      onOpenChange(false);
      setName("");
      setCompanyName("");
      setTicker("");
      onCreated(project);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New research project</DialogTitle>
          <DialogDescription>
            Create a project-level dataset for files, index metadata, Q&A, and memo generation.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Company"
            />
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="Ticker"
            />
          </div>
          {mutation.error && (
            <p className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Create failed"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2Icon className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDetail({ datasetId }: { datasetId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const projectQuery = usePrivateFundProject(datasetId);
  const project = projectQuery.data?.project;
  const files = projectQuery.data?.files ?? [];
  const uploadMutation = useMutation({
    mutationFn: (filesToUpload: File[]) => uploadPrivateFundFiles(datasetId, filesToUpload),
    onSuccess: () => {
      void projectQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey });
    },
  });
  const pipelineMutation = useMutation({
    mutationFn: () => runPrivateFundPipeline(datasetId),
    onSuccess: () => {
      void projectQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey });
    },
  });
  const activateMutation = useMutation({
    mutationFn: async () => {
      await activatePrivateFundProject(datasetId);
      writeActivePrivateFundProjectId(datasetId);
    },
  });
  const actionError = uploadMutation.error ?? pipelineMutation.error ?? activateMutation.error;
  const actionErrorMessage = actionError instanceof Error ? actionError.message : "Action failed";

  function onUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length > 0) uploadMutation.mutate(selected);
  }

  async function startChat(mode?: "memo") {
    await activateMutation.mutateAsync();
    const search = new URLSearchParams({
      private_fund_project: datasetId,
      private_fund_entry: "research",
    });
    const workspace = project?.datasetRoot || project?.sourceDir || project?.uploadsDir;
    if (workspace) search.set("private_fund_workspace", workspace);
    if (mode) search.set("private_fund_mode", mode);
    navigate(`/?${search.toString()}`);
  }

  if (projectQuery.isLoading) {
    return (
      <PageScroll contentClassName="px-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Loading project…
        </div>
      </PageScroll>
    );
  }

  if (!project) {
    return (
      <PageScroll contentClassName="px-8">
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="font-medium">Project not found</p>
          <Button asChild className="mt-4" size="sm">
            <Link to="/research-projects">Back to projects</Link>
          </Button>
        </div>
      </PageScroll>
    );
  }

  const liveStatus = pipelineMutation.data?.status ?? project.latestJob?.status ?? project.status;
  const running = liveStatus === "queued" || liveStatus === "running" || liveStatus === "indexing";

  return (
    <PageScroll contentClassName="px-8" extraBottom="2.5rem">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground">
            <Link to="/research-projects">Projects</Link>
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl font-semibold">{project.name}</h1>
            <StatusBadge status={liveStatus} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.datasetId} · {project.uploadCount || project.fileCount} files ·{" "}
            {project.chunkCount.toLocaleString()} chunks
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept=".pdf,.xlsx,.xlsm,application/pdf"
            className="hidden"
            onChange={onUploadChange}
          />
          <Button variant="secondary" size="sm" onClick={() => uploadInputRef.current?.click()}>
            {uploadMutation.isPending ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <UploadIcon className="size-4" />
            )}
            Upload
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={running || files.length === 0}
            onClick={() => pipelineMutation.mutate()}
          >
            {running ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <DatabaseIcon className="size-4" />
            )}
            Run pipeline
          </Button>
          <Button size="sm" disabled={!project.indexReady} onClick={() => void startChat()}>
            Start research
            <ArrowRightIcon className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!project.indexReady}
            onClick={() => void startChat("memo")}
          >
            Generate memo
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{actionErrorMessage}</span>
        </div>
      )}

      <ProjectMetrics project={project} />

      <Tabs defaultValue="files" className="mt-6">
        <TabsList variant="pill">
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="index">Index</TabsTrigger>
          <TabsTrigger value="memo">Memo</TabsTrigger>
        </TabsList>
        <TabsContent value="files" className="mt-4">
          <FilesTable
            datasetId={datasetId}
            files={files}
            onChanged={() => void projectQuery.refetch()}
          />
        </TabsContent>
        <TabsContent value="pipeline" className="mt-4">
          <PipelinePanel project={project} running={running} />
        </TabsContent>
        <TabsContent value="index" className="mt-4">
          <IndexPanel project={project} />
        </TabsContent>
        <TabsContent value="memo" className="mt-4">
          <MemoPanel project={project} onGenerate={() => void startChat("memo")} />
        </TabsContent>
      </Tabs>
    </PageScroll>
  );
}

function ProjectMetrics({ project }: { project: PrivateFundProject }) {
  const metrics = [
    { label: "Files", value: project.uploadCount || project.fileCount, icon: FileTextIcon },
    { label: "Indexed docs", value: project.indexedDocumentCount, icon: CheckCircle2Icon },
    { label: "Chunks", value: project.chunkCount.toLocaleString(), icon: DatabaseIcon },
    { label: "Memos", value: project.memoCount, icon: FileTextIcon },
  ];
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(({ label, value, icon: Icon }) => (
        <div key={label} className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <Icon className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-2 text-2xl font-semibold">{value}</p>
        </div>
      ))}
    </div>
  );
}

function FilesTable({
  datasetId,
  files,
  onChanged,
}: {
  datasetId: string;
  files: PrivateFundFile[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: (fileName: string) => deletePrivateFundFile(datasetId, fileName),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey });
    },
  });

  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center">
        <FileTextIcon className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No files yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload PDFs or Excel files to build an index.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid grid-cols-[minmax(220px,1fr)_90px_100px_110px_110px_44px] border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>Name</span>
        <span>Type</span>
        <span>Size</span>
        <span>Status</span>
        <span>Chunks</span>
        <span />
      </div>
      {files.map((file) => (
        <div
          key={`${file.name}-${file.sourcePath ?? file.docId ?? ""}`}
          className="grid grid-cols-[minmax(220px,1fr)_90px_100px_110px_110px_44px] items-center border-b border-border px-4 py-3 text-sm last:border-b-0"
        >
          <span className="min-w-0">
            <span className="block truncate font-medium">{file.name}</span>
            {file.errorMessage && (
              <span className="block truncate text-xs text-destructive">{file.errorMessage}</span>
            )}
          </span>
          <span className="uppercase text-muted-foreground">{file.fileType}</span>
          <span>{formatBytes(file.size)}</span>
          <StatusBadge status={file.status} />
          <span>{file.chunkCount.toLocaleString()}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate(file.name)}
            aria-label={`Delete ${file.name}`}
          >
            {deleteMutation.isPending ? (
              <MoreHorizontalIcon className="size-4" />
            ) : (
              <Trash2Icon className="size-4" />
            )}
          </Button>
        </div>
      ))}
    </div>
  );
}

function PipelinePanel({ project, running }: { project: PrivateFundProject; running: boolean }) {
  const steps = [
    ["Files scanned", project.uploadCount || project.fileCount],
    ["Documents parsed", project.documentCount],
    ["Documents indexed", project.indexedDocumentCount],
    ["Chunks written", project.chunkCount],
  ] as const;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Pipeline status</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Latest run: {formatTime(project.latestJob?.finishedAt ?? project.latestJob?.startedAt)}
          </p>
        </div>
        <StatusBadge status={project.latestJob?.status ?? project.status} />
      </div>
      <div className="mt-4 grid gap-2">
        {steps.map(([label, value], index) => (
          <div key={label} className="flex items-center gap-3 rounded-md bg-muted/40 px-3 py-2">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                value > 0 ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
              )}
            >
              {running && index === 1 ? <Loader2Icon className="size-3 animate-spin" /> : index + 1}
            </span>
            <span className="flex-1 text-sm">{label}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{value}</span>
          </div>
        ))}
      </div>
      {project.latestJob?.message && (
        <p className="mt-4 text-sm text-muted-foreground">{project.latestJob.message}</p>
      )}
    </div>
  );
}

function IndexPanel({ project }: { project: PrivateFundProject }) {
  const rows = [
    ["Dataset id", project.datasetId],
    [
      "Collection path",
      project.datasetRoot ? `${project.datasetRoot}/meta/collection.sqlite3` : "Not built",
    ],
    ["Index count", String(project.indexCount)],
    ["Chunk count", project.chunkCount.toLocaleString()],
    ["Failed documents", String(project.failedDocumentCount)],
  ];
  return (
    <div className="rounded-lg border border-border bg-card">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[160px_minmax(0,1fr)] border-b border-border px-4 py-3 text-sm last:border-b-0"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate font-mono text-xs" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MemoPanel({
  project,
  onGenerate,
}: {
  project: PrivateFundProject;
  onGenerate: () => void;
}) {
  const memoUrl = project.latestMemoPath
    ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(project.latestMemoPath)}`
    : null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Memo artifacts</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.memoCount > 0
              ? `${project.memoCount} artifact files · latest ${project.latestMemoName}`
              : "No memo artifacts for this project yet."}
          </p>
        </div>
        <Button size="sm" disabled={!project.indexReady} onClick={onGenerate}>
          Generate memo
        </Button>
      </div>
      {memoUrl && (
        <Button asChild variant="secondary" size="sm" className="mt-4">
          <a href={memoUrl} target="_blank" rel="noreferrer">
            Open latest memo
          </a>
        </Button>
      )}
    </div>
  );
}
