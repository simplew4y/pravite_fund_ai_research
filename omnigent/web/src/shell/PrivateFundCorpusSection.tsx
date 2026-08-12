import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  FolderIcon,
  GripVerticalIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  UploadCloudIcon,
  UploadIcon,
} from "lucide-react";

import { PrivateFundCreateProjectDialog } from "@/components/private-fund/PrivateFundCreateProjectDialog";
import { PrivateFundEditProjectDialog } from "@/components/private-fund/PrivateFundEditProjectDialog";
import { PrivateFundGlobalUploadDialog } from "@/components/private-fund/PrivateFundGlobalUploadDialog";
import { PrivateFundUploadDialog } from "@/components/private-fund/PrivateFundUploadDialog";
import { usePrivateFundDocumentUpload } from "@/components/private-fund/usePrivateFundDocumentUpload";
import { usePrivateFundGlobalUpload } from "@/components/private-fund/usePrivateFundGlobalUpload";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { showToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";
import {
  useCreatePrivateFundSourceFolder,
  useDeletePrivateFundFiles,
  useDeletePrivateFundProject,
  useDeletePrivateFundSourceFolder,
  useMovePrivateFundSourceFile,
  usePrivateFundProject,
  usePrivateFundSourceFolders,
  useRenamePrivateFundSourceFolder,
} from "@/hooks/usePrivateFundProjects";
import {
  PRIVATE_FUND_DATASET_ID_LABEL_KEY,
  type PrivateFundFile,
  type PrivateFundProject,
  type PrivateFundSourceFolder,
  writeActivePrivateFundProjectId,
} from "@/lib/privateFundApi";
import { useLocation, useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { composerAttachmentKey, type ComposerAttachment, useChatStore } from "@/store/chatStore";
import { usePrivateFundWorkspaceStore } from "@/store/privateFundWorkspaceStore";
import { sortByUpdatedAtDesc } from "./sidebarNav";

const EMPTY_FILES: PrivateFundFile[] = [];
const EXPANDED_FOLDERS_STORAGE_PREFIX = "omnigent.sidebar.privateFundExpandedFolders:";

function folderExpansionKey(datasetId: string): string {
  return `${EXPANDED_FOLDERS_STORAGE_PREFIX}${datasetId}`;
}

function readExpandedFolders(datasetId: string): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(folderExpansionKey(datasetId)) || "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpandedFolders(datasetId: string, folderIds: Set<string>): void {
  try {
    window.localStorage.setItem(folderExpansionKey(datasetId), JSON.stringify([...folderIds]));
  } catch {
    // Expansion is a local presentation preference only.
  }
}

function normalizeFilePath(file: PrivateFundFile, project: PrivateFundProject | undefined): string {
  const rawPath = file.storedPath || file.sourcePath;
  if (!rawPath) return file.name;
  const path = rawPath.replace(/\\/g, "/");
  const roots = [project?.datasetRoot, project?.sourceDir, project?.uploadsDir]
    .filter((root): root is string => Boolean(root))
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""));
  for (const root of roots) {
    if (path === root) return file.name;
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1) || file.name;
  }
  return path.startsWith("/") ? file.name : path;
}

function folderNameError(
  name: string,
  folders: PrivateFundSourceFolder[],
  t: TFunction,
  currentId?: string,
): string {
  const normalized = name.trim();
  if (!normalized) return t("sourceLibrary.folderNameRequired");
  if (normalized.length > 40) return t("sourceLibrary.folderNameTooLong");
  if (/[\\/]/.test(normalized) || normalized === "." || normalized === "..") {
    return t("sourceLibrary.folderNameInvalid");
  }
  if (
    folders.some(
      (folder) =>
        folder.folderId !== currentId &&
        folder.name.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    )
  ) {
    return t("sourceLibrary.folderNameDuplicate");
  }
  return "";
}

function projectStatus(
  project: PrivateFundProject,
  t: TFunction,
): { label: string; className: string } {
  const status = (project.latestJob?.status ?? project.status).toLowerCase();
  if (["running", "queued", "indexing"].includes(status)) {
    return { label: t("sourceLibrary.projectUpdating"), className: "text-primary" };
  }
  if (status === "failed") {
    return { label: t("sourceLibrary.projectNeedsAttention"), className: "text-destructive" };
  }
  if (project.indexReady || ["completed", "ready"].includes(status)) {
    return { label: t("sourceLibrary.projectReady"), className: "text-success" };
  }
  return { label: t("sourceLibrary.projectPendingIndex"), className: "text-warning" };
}

function formatFileSize(bytes: number, t: TFunction): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return t("sourceLibrary.unknownSize");
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatFileUpdatedAt(
  value: string | null | undefined,
  locale: string,
  t: TFunction,
): string {
  if (!value) return t("sourceLibrary.unknownTime");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("sourceLibrary.unknownTime");
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function fileClassification(file: PrivateFundFile, t: TFunction): string {
  const value = file.docSubtype || file.docType;
  return value && value !== "unknown"
    ? value.replaceAll("_", " ")
    : t("sourceLibrary.unclassified");
}

function AttachmentCheckbox({
  checked,
  mixed = false,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      aria-checked={mixed ? "mixed" : checked}
      ref={(element) => {
        if (element) element.indeterminate = mixed;
      }}
      onChange={onChange}
      className="size-3.5 shrink-0 cursor-pointer rounded border-border accent-primary disabled:cursor-default disabled:opacity-40"
    />
  );
}

type FolderFileRow = {
  file: PrivateFundFile;
  attachment: ComposerAttachment;
  attachmentKey: string;
  assignment: "auto" | "manual";
};

function DraggableFileRow({
  row,
  folderId,
  attached,
  manageMode,
  managed,
  movePending,
  onToggle,
  onPreview,
  onRestore,
}: {
  row: FolderFileRow;
  folderId: string;
  attached: boolean;
  manageMode: boolean;
  managed: boolean;
  movePending: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onRestore: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const date = formatFileUpdatedAt(row.file.uploadedAt, locale, t);
  const size = formatFileSize(row.file.size, t);
  const classification = fileClassification(row.file, t);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `private-fund-file:${row.file.name}`,
    data: { fileName: row.file.name, folderId },
    disabled: manageMode || movePending,
  });
  return (
    <div
      ref={setNodeRef}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        "group ml-5 flex min-h-11 items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-muted",
        attached && !manageMode && "bg-muted/50",
        isDragging && "opacity-35",
      )}
    >
      <button
        type="button"
        aria-label={t("sourceLibrary.dragSource", { name: row.file.name })}
        className="flex size-6 shrink-0 touch-none items-center justify-center rounded text-muted-foreground opacity-40 hover:bg-background hover:opacity-100 focus-visible:opacity-100 disabled:cursor-default"
        disabled={manageMode || movePending}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3" />
      </button>
      <AttachmentCheckbox
        checked={manageMode ? managed : attached}
        label={
          manageMode
            ? t("sourceLibrary.selectSourceManage", { name: row.file.name })
            : t("sourceLibrary.selectSourceQuestion", { name: row.file.name })
        }
        onChange={onToggle}
      />
      <button
        type="button"
        aria-label={t("sourceLibrary.previewSource", { name: row.file.name })}
        className="flex min-w-0 flex-1 items-start gap-1.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onPreview}
        title={t("sourceLibrary.sourceMetadata", {
          name: row.file.name,
          size,
          date,
          count: row.file.chunkCount,
          classification,
        })}
      >
        <FileTextIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{row.file.name}</span>
          <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">
            {t("sourceLibrary.sourceSummary", {
              date,
              size,
              count: row.file.chunkCount,
              classification,
            })}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-[9px] font-medium text-muted-foreground">
          {row.file.fileType.toUpperCase() || "FILE"}
        </span>
      </button>
      {row.assignment === "manual" && !manageMode ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("sourceLibrary.sourceFolderActions", { name: row.file.name })}
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontalIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRestore}>
              <RotateCcwIcon className="size-3.5" />
              {t("sourceLibrary.restoreAutomatic")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function FolderDropRow({
  folder,
  expanded,
  editing,
  editName,
  allSelected,
  someSelected,
  manageMode,
  busy,
  onToggleExpanded,
  onToggleSelection,
  onEditNameChange,
  onEditKeyDown,
  onStartRename,
  onDelete,
}: {
  folder: PrivateFundSourceFolder;
  expanded: boolean;
  editing: boolean;
  editName: string;
  allSelected: boolean;
  someSelected: boolean;
  manageMode: boolean;
  busy: boolean;
  onToggleExpanded: () => void;
  onToggleSelection: () => void;
  onEditNameChange: (value: string) => void;
  onEditKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: `private-fund-folder:${folder.folderId}`,
    data: { folderId: folder.folderId },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group flex min-h-8 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-muted",
        isOver && "bg-primary/10 ring-1 ring-primary/30",
      )}
    >
      <button
        type="button"
        aria-label={t(expanded ? "sourceLibrary.collapseFolder" : "sourceLibrary.expandFolder", {
          name: folder.name,
        })}
        aria-expanded={expanded}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background"
        onClick={onToggleExpanded}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
      </button>
      <AttachmentCheckbox
        checked={allSelected}
        mixed={someSelected}
        disabled={folder.fileCount === 0}
        label={t(
          manageMode ? "sourceLibrary.selectFolderManage" : "sourceLibrary.addFolderQuestion",
          { name: folder.name },
        )}
        onChange={onToggleSelection}
      />
      {editing ? (
        <input
          autoFocus
          value={editName}
          aria-label={t("sourceLibrary.renameFolderLabel", { name: folder.name })}
          onChange={(event) => onEditNameChange(event.target.value)}
          onKeyDown={onEditKeyDown}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-xs font-medium"
          onClick={onToggleExpanded}
        >
          <span className="min-w-0 truncate">{folder.name}</span>
          <span className="shrink-0 text-[10px] font-normal tabular-nums text-muted-foreground">
            ({folder.fileCount})
          </span>
        </button>
      )}
      {!editing ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("sourceLibrary.folderActions", { name: folder.name })}
              className="size-6 shrink-0 text-muted-foreground"
              disabled={busy}
            >
              <MoreHorizontalIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onStartRename}>
              <PencilIcon className="size-3.5" />
              {t("sourceLibrary.rename")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" />
              {t("sourceLibrary.deleteFolder")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function PrivateFundCorpusSection({
  projects,
  projectsLoading,
  conversations,
  selectedDatasetId,
}: {
  projects: PrivateFundProject[];
  projectsLoading: boolean;
  conversations: Conversation[];
  selectedDatasetId: string | null;
  workbench?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const projectQuery = usePrivateFundProject(selectedDatasetId);
  const folderQuery = usePrivateFundSourceFolders(selectedDatasetId);
  const project = projectQuery.data?.project;
  const files = projectQuery.data?.files ?? EMPTY_FILES;
  const upload = usePrivateFundDocumentUpload(selectedDatasetId);
  const globalUpload = usePrivateFundGlobalUpload();
  const deleteProject = useDeletePrivateFundProject();
  const deleteFiles = useDeletePrivateFundFiles(selectedDatasetId);
  const createFolder = useCreatePrivateFundSourceFolder(selectedDatasetId);
  const renameFolder = useRenamePrivateFundSourceFolder(selectedDatasetId);
  const deleteFolder = useDeletePrivateFundSourceFolder(selectedDatasetId);
  const moveFile = useMovePrivateFundSourceFile(selectedDatasetId);

  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [projectDeleteOpen, setProjectDeleteOpen] = useState(false);
  const [sourceDeleteOpen, setSourceDeleteOpen] = useState(false);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<PrivateFundSourceFolder | null>(
    null,
  );
  const [manageMode, setManageMode] = useState(false);
  const [managedNames, setManagedNames] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    readExpandedFolders(selectedDatasetId ?? ""),
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState("");
  const [editingFolderName, setEditingFolderName] = useState("");
  const [draggedFileName, setDraggedFileName] = useState("");
  const openDocumentPreview = usePrivateFundWorkspaceStore((state) => state.openDocumentPreview);
  const setSelectedSourceDocumentIds = usePrivateFundWorkspaceStore(
    (state) => state.setSelectedSourceDocumentIds,
  );

  const pendingAttachments = useChatStore((state) => state.pendingComposerAttachments);
  const pendingRemovals = useChatStore((state) => state.pendingComposerAttachmentRemovals);
  const activeAttachments = useChatStore((state) => state.activeComposerAttachments);
  const attachedKeys = useMemo(() => {
    const keys = new Set([
      ...activeAttachments.map(composerAttachmentKey),
      ...pendingAttachments.map(composerAttachmentKey),
    ]);
    for (const attachment of pendingRemovals) keys.delete(composerAttachmentKey(attachment));
    return keys;
  }, [activeAttachments, pendingAttachments, pendingRemovals]);

  const fileRows = useMemo(() => {
    const assignmentByName = new Map<string, "auto" | "manual">();
    for (const folder of folderQuery.data?.folders ?? []) {
      for (const item of folder.files) assignmentByName.set(item.fileName, item.assignment);
    }
    return new Map(
      files.map((file) => {
        const attachment = { path: normalizeFilePath(file, project), isDir: false };
        return [
          file.name,
          {
            file,
            attachment,
            attachmentKey: composerAttachmentKey(attachment),
            assignment: assignmentByName.get(file.name) ?? "auto",
          } satisfies FolderFileRow,
        ];
      }),
    );
  }, [files, folderQuery.data?.folders, project]);

  const folderRows = useMemo(
    () =>
      (folderQuery.data?.folders ?? []).map((folder) => ({
        folder,
        rows: folder.files
          .map((item) => fileRows.get(item.fileName))
          .filter((row): row is FolderFileRow => Boolean(row)),
      })),
    [fileRows, folderQuery.data?.folders],
  );
  const allRows = useMemo(() => [...fileRows.values()], [fileRows]);
  const attachedCount = allRows.filter((row) => attachedKeys.has(row.attachmentKey)).length;
  const selectedSourceDocumentIds = useMemo(
    () =>
      allRows
        .filter((row) => attachedKeys.has(row.attachmentKey))
        .map((row) => row.file.docId)
        .filter((documentId): documentId is string => Boolean(documentId)),
    [allRows, attachedKeys],
  );
  const allManaged = allRows.length > 0 && managedNames.size === allRows.length;
  const someManaged = managedNames.size > 0 && !allManaged;

  const orderedProjects = useMemo(() => {
    const latestConversationAt = new Map<string, number>();
    for (const conversation of conversations) {
      if (conversation.archived) continue;
      const datasetId = conversation.labels?.[PRIVATE_FUND_DATASET_ID_LABEL_KEY];
      if (!datasetId) continue;
      latestConversationAt.set(
        datasetId,
        Math.max(latestConversationAt.get(datasetId) ?? 0, conversation.updated_at || 0),
      );
    }
    return [...projects].sort((a, b) => {
      if (a.datasetId === selectedDatasetId) return -1;
      if (b.datasetId === selectedDatasetId) return 1;
      return (
        (latestConversationAt.get(b.datasetId) ?? 0) - (latestConversationAt.get(a.datasetId) ?? 0)
      );
    });
  }, [conversations, projects, selectedDatasetId]);
  const visibleProjects = useMemo(() => {
    const query = projectSearch.trim().toLocaleLowerCase();
    if (!query) return orderedProjects;
    return orderedProjects.filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(query) ||
        item.datasetId.toLocaleLowerCase().includes(query),
    );
  }, [orderedProjects, projectSearch]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  useEffect(() => {
    if (!selectedDatasetId) return;
    setSelectedSourceDocumentIds(selectedDatasetId, selectedSourceDocumentIds);
  }, [selectedDatasetId, selectedSourceDocumentIds, setSelectedSourceDocumentIds]);

  useEffect(() => {
    const next = readExpandedFolders(selectedDatasetId ?? "");
    setExpandedFolders(next);
    setManageMode(false);
    setManagedNames(new Set());
    setCreatingFolder(false);
    setEditingFolderId("");
    setFolderDeleteTarget(null);
  }, [selectedDatasetId]);

  useEffect(() => {
    if (!selectedDatasetId || folderRows.length === 0) return;
    const attachedFolderIds = folderRows
      .filter(({ rows }) => rows.some((row) => attachedKeys.has(row.attachmentKey)))
      .map(({ folder }) => folder.folderId);
    if (attachedFolderIds.length === 0) return;
    setExpandedFolders((current) => {
      const next = new Set(current);
      let changed = false;
      for (const folderId of attachedFolderIds) {
        if (!next.has(folderId)) {
          next.add(folderId);
          changed = true;
        }
      }
      if (changed) writeExpandedFolders(selectedDatasetId, next);
      return changed ? next : current;
    });
  }, [attachedKeys, folderRows, selectedDatasetId]);

  function setFolderExpanded(folderId: string, expanded: boolean) {
    if (!selectedDatasetId) return;
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (expanded) next.add(folderId);
      else next.delete(folderId);
      writeExpandedFolders(selectedDatasetId, next);
      return next;
    });
  }

  function switchProject(nextDatasetId: string) {
    if (nextDatasetId === selectedDatasetId) {
      setProjectPickerOpen(false);
      setProjectSearch("");
      return;
    }
    const store = useChatStore.getState();
    for (const attachment of [...activeAttachments, ...pendingAttachments]) {
      store.removeComposerAttachment(attachment);
    }
    writeActivePrivateFundProjectId(nextDatasetId);
    setProjectPickerOpen(false);
    setProjectSearch("");
    if (location.pathname === "/") {
      const params = new URLSearchParams(location.search);
      params.set("private_fund_project", nextDatasetId);
      navigate(`/?${params.toString()}`);
      return;
    }
    const latest = sortByUpdatedAtDesc(
      conversations.filter(
        (conversation) =>
          !conversation.archived &&
          conversation.labels?.[PRIVATE_FUND_DATASET_ID_LABEL_KEY] === nextDatasetId,
      ),
      null,
    )[0];
    navigate(
      latest
        ? `/c/${latest.id}?private_fund_project=${encodeURIComponent(nextDatasetId)}`
        : `/?private_fund_project=${encodeURIComponent(nextDatasetId)}`,
    );
  }

  function toggleRows(rows: FolderFileRow[]) {
    if (manageMode) {
      const allSelected = rows.length > 0 && rows.every((row) => managedNames.has(row.file.name));
      setManagedNames((current) => {
        const next = new Set(current);
        for (const row of rows) {
          if (allSelected) next.delete(row.file.name);
          else next.add(row.file.name);
        }
        return next;
      });
      return;
    }
    const store = useChatStore.getState();
    const allSelected = rows.length > 0 && rows.every((row) => attachedKeys.has(row.attachmentKey));
    for (const row of rows) {
      if (allSelected) store.removeComposerAttachment(row.attachment);
      else if (!attachedKeys.has(row.attachmentKey)) store.addComposerAttachment(row.attachment);
    }
  }

  function toggleFile(row: FolderFileRow) {
    if (manageMode) {
      setManagedNames((current) => {
        const next = new Set(current);
        if (next.has(row.file.name)) next.delete(row.file.name);
        else next.add(row.file.name);
        return next;
      });
      return;
    }
    const store = useChatStore.getState();
    if (attachedKeys.has(row.attachmentKey)) store.removeComposerAttachment(row.attachment);
    else store.addComposerAttachment(row.attachment);
  }

  async function submitNewFolder() {
    const validationError = folderNameError(newFolderName, folderQuery.data?.folders ?? [], t);
    if (validationError) {
      showToast(validationError);
      return;
    }
    try {
      await createFolder.mutateAsync(newFolderName.trim());
      setNewFolderName("");
      setCreatingFolder(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("sourceLibrary.createFolderFailed"));
    }
  }

  async function submitFolderRename(folder: PrivateFundSourceFolder) {
    const validationError = folderNameError(
      editingFolderName,
      folderQuery.data?.folders ?? [],
      t,
      folder.folderId,
    );
    if (validationError) {
      showToast(validationError);
      return;
    }
    try {
      await renameFolder.mutateAsync({
        folderId: folder.folderId,
        name: editingFolderName.trim(),
      });
      setEditingFolderId("");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("sourceLibrary.renameFolderFailed"));
    }
  }

  async function confirmDeleteSources() {
    const names = [...managedNames];
    if (names.length === 0) return;
    try {
      await deleteFiles.mutateAsync(names);
      const store = useChatStore.getState();
      for (const name of names) {
        const row = fileRows.get(name);
        if (row) store.removeComposerAttachment(row.attachment);
      }
      setManagedNames(new Set());
      setManageMode(false);
      setSourceDeleteOpen(false);
      showToast(t("sourceLibrary.deletedSources", { count: names.length }));
    } catch {
      // The mutation error remains visible in the confirmation dialog.
    }
  }

  async function confirmDeleteFolder() {
    if (!folderDeleteTarget) return;
    const target = folderDeleteTarget;
    try {
      await deleteFolder.mutateAsync(target.folderId);
      const store = useChatStore.getState();
      for (const item of target.files) {
        const row = fileRows.get(item.fileName);
        if (row) store.removeComposerAttachment(row.attachment);
      }
      setFolderDeleteTarget(null);
      showToast(
        target.fileCount > 0
          ? t("sourceLibrary.deletedFolderWithSources", {
              name: target.name,
              count: target.fileCount,
            })
          : t("sourceLibrary.deletedFolder", { name: target.name }),
      );
    } catch {
      // The mutation error remains visible in the confirmation dialog.
    }
  }

  async function confirmDeleteProject() {
    if (!selectedDatasetId) return;
    try {
      await deleteProject.mutateAsync(selectedDatasetId);
      writeActivePrivateFundProjectId("");
      setProjectDeleteOpen(false);
      navigate("/");
      showToast(t("sourceLibrary.deletedProject", { name: project?.name ?? selectedDatasetId }));
    } catch {
      // The mutation error remains visible in the confirmation dialog.
    }
  }

  function onFolderNameKeyDown(event: KeyboardEvent<HTMLInputElement>, submit: () => void) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCreatingFolder(false);
      setEditingFolderId("");
    }
  }

  function onDragStart(event: DragStartEvent) {
    setDraggedFileName(String(event.active.data.current?.fileName ?? ""));
  }

  function onDragEnd(event: DragEndEvent) {
    const fileName = String(event.active.data.current?.fileName ?? "");
    const sourceFolderId = String(event.active.data.current?.folderId ?? "");
    const targetFolderId = String(event.over?.data.current?.folderId ?? "");
    setDraggedFileName("");
    if (!fileName || !targetFolderId || targetFolderId === sourceFolderId) return;
    setFolderExpanded(targetFolderId, true);
    moveFile.mutate(
      { fileName, folderId: targetFolderId },
      {
        onError: (error) =>
          showToast(error instanceof Error ? error.message : t("sourceLibrary.moveSourceFailed")),
      },
    );
  }

  return (
    <section className="mb-3" data-testid="private-fund-corpus-section">
      <PrivateFundCreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreated={(created) => switchProject(created.datasetId)}
      />
      <PrivateFundEditProjectDialog
        open={editProjectOpen}
        project={project}
        onOpenChange={setEditProjectOpen}
      />
      <PrivateFundUploadDialog {...upload.dialogProps} />
      <PrivateFundGlobalUploadDialog
        open={globalUpload.open}
        batch={globalUpload.batch}
        message={globalUpload.message}
        projects={projects}
        uploading={globalUpload.isUploading}
        processing={globalUpload.isProcessing}
        routing={globalUpload.isRouting}
        progressPercent={globalUpload.progressPercent}
        progressLabel={globalUpload.progressLabel}
        onOpenChange={globalUpload.setOpen}
        onSelectFiles={globalUpload.selectFiles}
        onRoute={globalUpload.routeItem}
        onStartAnotherBatch={globalUpload.startAnotherBatch}
      />
      <Dialog
        open={projectDeleteOpen}
        onOpenChange={(open) => !deleteProject.isPending && setProjectDeleteOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sourceLibrary.deleteProjectTitle")}</DialogTitle>
            <DialogDescription>
              {t("sourceLibrary.deleteProjectDescription", {
                name: project?.name ?? selectedDatasetId,
              })}
            </DialogDescription>
          </DialogHeader>
          {deleteProject.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {deleteProject.error instanceof Error
                ? deleteProject.error.message
                : t("sourceLibrary.deleteProjectFailed")}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProjectDeleteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProject.isPending}
              onClick={() => void confirmDeleteProject()}
            >
              {deleteProject.isPending
                ? t("sourceLibrary.deleting")
                : t("sourceLibrary.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={sourceDeleteOpen}
        onOpenChange={(open) => !deleteFiles.isPending && setSourceDeleteOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("sourceLibrary.deleteSourcesTitle", { count: managedNames.size })}
            </DialogTitle>
            <DialogDescription>{t("sourceLibrary.deleteSourcesDescription")}</DialogDescription>
          </DialogHeader>
          {deleteFiles.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {deleteFiles.error instanceof Error
                ? deleteFiles.error.message
                : t("sourceLibrary.deleteSourcesFailed")}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSourceDeleteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteFiles.isPending}
              onClick={() => void confirmDeleteSources()}
            >
              {deleteFiles.isPending
                ? t("sourceLibrary.deleting")
                : t("sourceLibrary.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(folderDeleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteFolder.isPending) setFolderDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("sourceLibrary.deleteFolderTitle", { name: folderDeleteTarget?.name })}
            </DialogTitle>
            <DialogDescription>
              {folderDeleteTarget?.fileCount
                ? t("sourceLibrary.deleteFolderWithSourcesDescription", {
                    count: folderDeleteTarget.fileCount,
                  })
                : t("sourceLibrary.deleteEmptyFolderDescription")}
            </DialogDescription>
          </DialogHeader>
          {deleteFolder.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {deleteFolder.error instanceof Error
                ? deleteFolder.error.message
                : t("sourceLibrary.deleteFolderFailed")}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFolderDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteFolder.isPending}
              onClick={() => void confirmDeleteFolder()}
            >
              {deleteFolder.isPending
                ? t("sourceLibrary.deleting")
                : t("sourceLibrary.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button
        type="button"
        variant="secondary"
        data-testid="private-fund-global-upload-button"
        className="mb-2 h-auto w-full justify-start gap-2 rounded-lg px-2.5 py-2 text-left"
        onClick={globalUpload.openDialog}
      >
        {globalUpload.isUploading || globalUpload.isProcessing ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />
        ) : (
          <UploadCloudIcon className="size-4 shrink-0 text-primary" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">{t("sidebar.upload")}</span>
          <span className="block truncate text-[10px] font-normal text-muted-foreground">
            {globalUpload.progressLabel}
          </span>
        </span>
        {globalUpload.attentionCount > 0 ? (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-300">
            {t("sidebar.pendingConfirmation", {
              count: globalUpload.attentionCount,
              defaultValue: `${globalUpload.attentionCount} pending`,
            })}
          </span>
        ) : null}
      </Button>

      <div className="flex min-h-9 items-center gap-1">
        <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="private-fund-project-switcher"
              aria-label={`${t("privateFund.researchProject")}: ${project?.name ?? selectedDatasetId ?? t("common.noData")}`}
              className="relative z-[101] flex min-w-0 flex-1 pointer-events-auto isolate items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {project?.name ?? selectedDatasetId ?? t("privateFund.researchProject")}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="z-[110] w-72 gap-0 p-1 pointer-events-auto"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <div className="flex items-center gap-2 border-b px-2 py-1.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                type="search"
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder={t("sidebar.searchProjects", "Search research projects")}
                aria-label={t("sidebar.searchProjects", "Search research projects")}
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {projectsLoading ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("common.loading")}
                </p>
              ) : visibleProjects.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("sidebar.noProjects")}
                </p>
              ) : (
                visibleProjects.map((candidate) => {
                  const status = projectStatus(candidate, t);
                  return (
                    <button
                      key={candidate.datasetId}
                      type="button"
                      data-testid={`private-fund-project-option-${candidate.datasetId}`}
                      onClick={() => switchProject(candidate.datasetId)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CircleIcon
                        className={cn("size-2 shrink-0 fill-current", status.className)}
                      />
                      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t("sidebar.fileCount", {
                          count: candidate.uploadCount || candidate.fileCount,
                          defaultValue: `${candidate.uploadCount || candidate.fileCount} files`,
                        })}
                      </span>
                      {candidate.datasetId === selectedDatasetId ? (
                        <CheckIcon className="size-3.5 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })
              )}
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  data-testid="private-fund-create-project-option"
                  onClick={() => {
                    setProjectPickerOpen(false);
                    setProjectSearch("");
                    setCreateProjectOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PlusIcon className="size-3.5 text-muted-foreground" />
                  {t("sidebar.newProject")}
                </button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`${t("sidebar.upload")}: ${project?.name ?? selectedDatasetId ?? t("privateFund.researchProject")}`}
              data-testid="private-fund-upload-button"
              disabled={!selectedDatasetId || upload.isPending}
              onClick={upload.openDialog}
              className="size-7 shrink-0"
            >
              {upload.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <UploadIcon className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("sidebar.upload")}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("sidebar.projectActions", "Project actions")}
              className="size-7 shrink-0"
              disabled={!selectedDatasetId}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!project} onClick={() => setEditProjectOpen(true)}>
              <PencilIcon className="size-3.5" />
              {t("sidebar.editProject")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setProjectDeleteOpen(true)}
            >
              <Trash2Icon className="size-3.5" />
              {t("sidebar.deleteProject")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {selectedDatasetId ? (
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex min-h-8 items-center gap-1 px-1">
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-semibold">{t("sidebar.sources")}</h3>
              <p className="truncate text-[10px] text-muted-foreground">
                {attachedCount > 0
                  ? t("sidebar.attachedCount", {
                      count: attachedCount,
                      defaultValue: `${attachedCount} sources added to this question`,
                    })
                  : t(
                      "sidebar.selectSourceHint",
                      "Select source checkboxes to add them to the question context",
                    )}
              </p>
            </div>
            {manageMode ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-[11px]"
                  disabled={managedNames.size === 0}
                  onClick={() => setSourceDeleteOpen(true)}
                >
                  {t("sourceLibrary.deleteSelected", { count: managedNames.size || "" })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setManageMode(false);
                    setManagedNames(new Set());
                  }}
                >
                  {t("common.done", "Done")}
                </Button>
              </>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("sourceLibrary.newFolderLabel")}
                      className="size-7"
                      onClick={() => {
                        setCreatingFolder(true);
                        setNewFolderName("");
                      }}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t("sidebar.newFolder", "New folder")}
                  </TooltipContent>
                </Tooltip>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setManageMode(true)}
                >
                  {t("privateFund.batchManage")}
                </Button>
              </>
            )}
          </div>

          {manageMode ? (
            <div className="mt-1 flex min-h-8 items-center gap-2 rounded-md bg-muted/35 px-2">
              <AttachmentCheckbox
                checked={allManaged}
                mixed={someManaged}
                disabled={allRows.length === 0}
                label={t("sourceLibrary.selectAllManage")}
                onChange={() => toggleRows(allRows)}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                {t("sourceLibrary.selectedForManagement", { count: managedNames.size })}
              </span>
            </div>
          ) : null}

          {creatingFolder ? (
            <div className="mt-1 flex min-h-8 items-center gap-1 rounded-md px-1.5">
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={newFolderName}
                aria-label={t("sourceLibrary.newFolderName")}
                placeholder={t("sidebar.newFolder", "New folder")}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => onFolderNameKeyDown(event, () => void submitNewFolder())}
                className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("sourceLibrary.saveNewFolder")}
                className="size-6"
                disabled={createFolder.isPending}
                onClick={() => void submitNewFolder()}
              >
                {createFolder.isPending ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <CheckIcon className="size-3" />
                )}
              </Button>
            </div>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={onDragStart}
            onDragCancel={() => setDraggedFileName("")}
            onDragEnd={onDragEnd}
          >
            <div className="mt-1 max-h-[36vh] min-h-10 overflow-y-auto pr-0.5 [scrollbar-gutter:stable]">
              {projectQuery.isLoading || folderQuery.isLoading ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{t("common.loading")}</p>
              ) : folderQuery.isError ? (
                <p className="px-2 py-2 text-xs text-destructive">
                  {t("sidebar.sourceLoadFailed", "Could not load sources")}
                </p>
              ) : folderRows.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{t("sidebar.noSources")}</p>
              ) : (
                folderRows.map(({ folder, rows }) => {
                  const expanded = expandedFolders.has(folder.folderId);
                  const selectedCount = rows.filter((row) =>
                    manageMode
                      ? managedNames.has(row.file.name)
                      : attachedKeys.has(row.attachmentKey),
                  ).length;
                  const allSelected = rows.length > 0 && selectedCount === rows.length;
                  const someSelected = selectedCount > 0 && !allSelected;
                  return (
                    <div key={folder.folderId} className="mb-0.5">
                      <FolderDropRow
                        folder={folder}
                        expanded={expanded}
                        editing={editingFolderId === folder.folderId}
                        editName={editingFolderName}
                        allSelected={allSelected}
                        someSelected={someSelected}
                        manageMode={manageMode}
                        busy={renameFolder.isPending || deleteFolder.isPending}
                        onToggleExpanded={() => setFolderExpanded(folder.folderId, !expanded)}
                        onToggleSelection={() => toggleRows(rows)}
                        onEditNameChange={setEditingFolderName}
                        onEditKeyDown={(event) =>
                          onFolderNameKeyDown(event, () => void submitFolderRename(folder))
                        }
                        onStartRename={() => {
                          setEditingFolderId(folder.folderId);
                          setEditingFolderName(folder.name);
                        }}
                        onDelete={() => {
                          deleteFolder.reset();
                          setFolderDeleteTarget(folder);
                        }}
                      />
                      {expanded
                        ? rows.map((row) => (
                            <DraggableFileRow
                              key={row.file.name}
                              row={row}
                              folderId={folder.folderId}
                              attached={attachedKeys.has(row.attachmentKey)}
                              manageMode={manageMode}
                              managed={managedNames.has(row.file.name)}
                              movePending={moveFile.isPending}
                              onToggle={() => toggleFile(row)}
                              onPreview={() => {
                                if (!selectedDatasetId) return;
                                openDocumentPreview(selectedDatasetId, row.file.name);
                              }}
                              onRestore={() =>
                                moveFile.mutate(
                                  { fileName: row.file.name, folderId: null },
                                  {
                                    onError: (error) =>
                                      showToast(
                                        error instanceof Error
                                          ? error.message
                                          : t("sourceLibrary.restoreAutomaticFailed"),
                                      ),
                                  },
                                )
                              }
                            />
                          ))
                        : null}
                    </div>
                  );
                })
              )}
            </div>
            <DragOverlay dropAnimation={null}>
              {draggedFileName ? (
                <div className="flex max-w-56 items-center gap-2 rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-lg">
                  <FileTextIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{draggedFileName}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      ) : null}
    </section>
  );
}
