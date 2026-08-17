import { useState, type FormEvent } from "react";
import { Check, Inbox, Plus, Search, Settings, Trash2 } from "lucide-react";

import {
  useCreateProject,
  useDeleteProject,
  useProjects,
} from "../../api/queries";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";
import { InboxPanel, useInboxCount } from "./InboxPanel";

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const create = useCreateProject();
  const selectProject = useUiStore((state) => state.selectProject);
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [ticker, setTicker] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const project = await create.mutateAsync({
      name,
      ...(companyName.trim() ? { companyName } : {}),
      ...(ticker.trim() ? { ticker } : {}),
    });
    selectProject(project.id);
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog elev-lg"
        role="dialog"
        aria-label={t("project.create.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">{t("project.create.title")}</h2>
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="project-name">{t("project.create.name")}</label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="project-company">{t("project.create.company")}</label>
            <input
              id="project-company"
              className="input"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              maxLength={300}
            />
          </div>
          <div className="field">
            <label htmlFor="project-ticker">{t("project.create.ticker")}</label>
            <input
              id="project-ticker"
              className="input"
              value={ticker}
              onChange={(event) => setTicker(event.target.value)}
              maxLength={40}
            />
          </div>
          {create.isError ? <p className="error-text">{t("common.error")}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={create.isPending}>
              {t("project.create.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ProjectRail() {
  const { t, lang } = useT();
  const projects = useProjects();
  const removeProject = useDeleteProject();
  const { selectedProjectId, selectProject, toggleLang } = useUiStore();
  const [creating, setCreating] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inboxCount = useInboxCount();

  const visible = projects.data?.filter(
    (project) =>
      !search ||
      project.name.toLowerCase().includes(search.toLowerCase()) ||
      (project.ticker ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (project.companyName ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  function remove(projectId: string) {
    if (!window.confirm(t("project.delete.confirm"))) return;
    removeProject.mutate(projectId, {
      onSuccess: () => {
        if (selectedProjectId === projectId) selectProject(null);
      },
    });
  }

  return (
    <nav className="app-rail" aria-label={t("app.title")}>
      <div className="rail-brand">
        <span className="brand-mark">{t("app.brand")}</span>
        <span>{t("app.title")}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-icon btn-secondary"
          style={{ width: 32, height: 32 }}
          onClick={() => setCreating(true)}
          aria-label={t("rail.newProject")}
          title={t("rail.newProject")}
        >
          <Plus size={16} />
        </button>
      </div>

      <label className="rail-search">
        <Search size={15} color="#71717a" />
        <input
          placeholder={t("rail.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      {projects.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {projects.isError ? (
        <p className="error-text">
          {t("common.error")}{" "}
          <button className="btn btn-ghost" onClick={() => void projects.refetch()}>
            {t("common.retry")}
          </button>
        </p>
      ) : null}

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {visible?.map((project) => (
          <button
            key={project.id}
            className="rail-project"
            aria-current={project.id === selectedProjectId}
            onClick={() => selectProject(project.id)}
          >
            <span style={{ display: "block", paddingRight: 26 }}>
              <span style={{ display: "block", font: "600 14.5px/1.3 var(--font-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {project.name}
              </span>
              <MonoLabel>{project.ticker ?? project.companyName ?? ""}</MonoLabel>
            </span>
            <span className="status-dot" title={t("rail.ready")}>
              <Check size={11} />
            </span>
          </button>
        ))}
        {visible?.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13, padding: "0 4px" }}>
            {t("rail.noProjects")}
          </p>
        ) : null}
      </div>

      <div className="rail-footer">
        <button
          className="btn btn-quiet danger"
          title={t("project.delete")}
          aria-label={t("project.delete")}
          onClick={() => selectedProjectId && remove(selectedProjectId)}
          disabled={!selectedProjectId || removeProject.isPending}
        >
          <Trash2 size={15} />
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-quiet"
          style={{ position: "relative" }}
          title={t("rail.inbox")}
          aria-label={t("rail.inbox")}
          onClick={() => setInboxOpen(true)}
        >
          <Inbox size={16} />
          {inboxCount > 0 ? <span className="badge-dot" /> : null}
        </button>
        <button className="btn btn-quiet" title={t("rail.settings")} aria-label={t("rail.settings")}>
          <Settings size={16} />
        </button>
        <button
          className="btn btn-quiet"
          style={{ width: "auto", minWidth: 40, padding: "0 9px", font: "600 12px/1 var(--font-body)" }}
          title="语言 / Language"
          onClick={toggleLang}
        >
          {lang === "zh" ? "EN" : "中"}
        </button>
      </div>

      {creating ? <CreateProjectDialog onClose={() => setCreating(false)} /> : null}
      {inboxOpen ? <InboxPanel onClose={() => setInboxOpen(false)} /> : null}
    </nav>
  );
}
