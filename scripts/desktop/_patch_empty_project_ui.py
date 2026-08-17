#!/usr/bin/env python3
from pathlib import Path

path = Path(
    "/home/code/pravite_fund_ai_research/omnigent/web/src/shell/PrivateFundCorpusSection.tsx"
)
text = path.read_text(encoding="utf-8")
old = """  if (!selectedDatasetId && projects.length === 0 && !projectsLoading) return null;

  return (
    <section className=\"mb-3\" data-testid=\"private-fund-corpus-section\">
      <PrivateFundCreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreated={(created) => switchProject(created.datasetId)}
      />
"""
new = """  // Empty workspace: still show a clear entry to create the first project.
  // Previously we returned null here, which hid 新建研究项目 entirely after
  // a clean install / wiped AppData.
  if (!selectedDatasetId && projects.length === 0 && !projectsLoading) {
    return (
      <section className=\"mb-3\" data-testid=\"private-fund-corpus-section\">
        <PrivateFundCreateProjectDialog
          open={createProjectOpen}
          onOpenChange={setCreateProjectOpen}
          onCreated={(created) => switchProject(created.datasetId)}
        />
        <div className=\"rounded-lg border border-dashed border-border/80 bg-muted/20 px-3 py-4\">
          <p className=\"text-sm font-medium text-foreground\">还没有研究项目</p>
          <p className=\"mt-1 text-xs text-muted-foreground\">
            创建一个项目后即可上传资料、建立索引并开始研究对话。
          </p>
          <Button
            type=\"button\"
            size=\"sm\"
            className=\"mt-3\"
            data-testid=\"private-fund-create-project-empty\"
            onClick={() => setCreateProjectOpen(true)}
          >
            <PlusIcon className=\"size-3.5\" />
            新建研究项目
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className=\"mb-3\" data-testid=\"private-fund-corpus-section\">
      <PrivateFundCreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreated={(created) => switchProject(created.datasetId)}
      />
"""
if old not in text:
    raise SystemExit("pattern not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("patched", path)
