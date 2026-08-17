import { useState, type FormEvent } from "react";
import { Inbox, Languages, Plus, Settings, Trash2 } from "lucide-react";

import {
  useCreateProject,
  useDeleteProject,
  useProjects,
} from "../../api/queries";
import { Blueprint } from "../../components/Blueprint";
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
  const { t } = useT();
  const projects = useProjects();
  const removeProject = useDeleteProject();
  const { selectedProjectId, selectProject, toggleLang } = useUiStore();
  const [creating, setCreating] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxCount = useInboxCount();

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
          onClick={toggleLang}
          aria-label="切换语言 / Switch language"
        >
          <Languages size={16} />
        </button>
        <button
          className="btn btn-icon btn-secondary"
          onClick={() => setCreating(true)}
          aria-label={t("rail.newProject")}
        >
          <Plus size={16} />
        </button>
      </div>

      <MonoLabel style={{ padding: "0 4px" }}>
        {t("rail.tracking")} · {projects.data?.length ?? 0}
      </MonoLabel>

      {projects.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {projects.isError ? (
        <p className="error-text">
          {t("common.error")}{" "}
          <button className="btn btn-ghost" onClick={() => void projects.refetch()}>
            {t("common.retry")}
          </button>
        </p>
      ) : null}

      {projects.data?.map((project) => (
        <Blueprint key={project.id}>
          <button
            className="rail-project"
            aria-current={project.id === selectedProjectId}
            onClick={() => selectProject(project.id)}
          >
            <span className="name">
              {project.name}
              {project.ticker ? <MonoLabel>{project.ticker}</MonoLabel> : null}
            </span>
            {project.companyName ? (
              <span className="text-muted" style={{ fontSize: 12 }}>
                {project.companyName}
              </span>
            ) : null}
          </button>
        </Blueprint>
      ))}
      {projects.data?.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>
          {t("rail.noProjects")}
        </p>
      ) : null}

      {selectedProjectId ? (
        <button
          className="btn btn-ghost"
          onClick={() => remove(selectedProjectId)}
          disabled={removeProject.isPending}
        >
          <Trash2 size={14} /> {t("project.delete")}
        </button>
      ) : null}

      <div className="rail-footer">
        <button className="btn btn-ghost" onClick={() => setInboxOpen(true)}>
          <Inbox size={14} /> {t("rail.inbox")}
          {inboxCount > 0 ? <span className="tag tag-accent">{inboxCount}</span> : null}
        </button>
        <MonoLabel>
          <Settings size={12} style={{ verticalAlign: "-2px" }} />{" "}
          {t("rail.settings")}
        </MonoLabel>
      </div>

      {creating ? <CreateProjectDialog onClose={() => setCreating(false)} /> : null}
      {inboxOpen ? <InboxPanel onClose={() => setInboxOpen(false)} /> : null}
    </nav>
  );
}
