import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPrivateFundSourceFolder,
  deletePrivateFundFiles,
  deletePrivateFundProject,
  deletePrivateFundSourceFolder,
  getPrivateFundAssets,
  getPrivateFundPipelineJob,
  getPrivateFundProject,
  getPrivateFundSourceFolders,
  getPrivateFundTrackingOverview,
  getPrivateFundValuationTrackingOverview,
  getPrivateFundWorkflow,
  listPrivateFundProjects,
  movePrivateFundSourceFile,
  renamePrivateFundSourceFolder,
  type PrivateFundSourceFolderTree,
} from "@/lib/privateFundApi";

export const privateFundProjectsQueryKey = ["private-fund-projects"] as const;
export const privateFundSourceFoldersQueryKey = (datasetId: string | null | undefined) =>
  ["private-fund-source-folders", datasetId] as const;

export function usePrivateFundProjects() {
  return useQuery({
    queryKey: privateFundProjectsQueryKey,
    queryFn: listPrivateFundProjects,
    refetchInterval: (query) =>
      query.state.data?.some((project) =>
        ["queued", "running"].includes(project.latestJob?.status ?? ""),
      )
        ? 2500
        : false,
  });
}

export function useDeletePrivateFundProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePrivateFundProject,
    onSuccess: async (_result, datasetId) => {
      queryClient.removeQueries({ queryKey: ["private-fund-project", datasetId] });
      queryClient.removeQueries({ queryKey: ["private-fund-assets", datasetId] });
      queryClient.removeQueries({ queryKey: ["private-fund-workflow", datasetId] });
      queryClient.removeQueries({ queryKey: privateFundSourceFoldersQueryKey(datasetId) });
      await queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey });
    },
  });
}

export function useDeletePrivateFundFiles(datasetId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileNames: string[]) => deletePrivateFundFiles(datasetId!, fileNames),
    onSuccess: async (next) => {
      queryClient.setQueryData(["private-fund-project", datasetId], next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] }),
        queryClient.invalidateQueries({ queryKey: privateFundSourceFoldersQueryKey(datasetId) }),
      ]);
    },
  });
}

export function usePrivateFundSourceFolders(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: privateFundSourceFoldersQueryKey(datasetId),
    queryFn: () => getPrivateFundSourceFolders(datasetId!),
    enabled: Boolean(datasetId),
  });
}

function useSourceFolderMutationResult(datasetId: string | null | undefined) {
  const queryClient = useQueryClient();
  return (next: Awaited<ReturnType<typeof getPrivateFundSourceFolders>>) => {
    queryClient.setQueryData(privateFundSourceFoldersQueryKey(datasetId), next);
  };
}

export function useCreatePrivateFundSourceFolder(datasetId: string | null | undefined) {
  const setResult = useSourceFolderMutationResult(datasetId);
  return useMutation({
    mutationFn: (name: string) => createPrivateFundSourceFolder(datasetId!, name),
    onSuccess: setResult,
  });
}

export function useRenamePrivateFundSourceFolder(datasetId: string | null | undefined) {
  const setResult = useSourceFolderMutationResult(datasetId);
  return useMutation({
    mutationFn: ({ folderId, name }: { folderId: string; name: string }) =>
      renamePrivateFundSourceFolder(datasetId!, folderId, name),
    onSuccess: setResult,
  });
}

export function useDeletePrivateFundSourceFolder(datasetId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deletePrivateFundSourceFolder(datasetId!, folderId),
    onSuccess: async (next) => {
      queryClient.setQueryData(privateFundSourceFoldersQueryKey(datasetId), next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: privateFundProjectsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] }),
      ]);
    },
  });
}

export function useMovePrivateFundSourceFile(datasetId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = privateFundSourceFoldersQueryKey(datasetId);
  return useMutation({
    mutationFn: ({ fileName, folderId }: { fileName: string; folderId: string | null }) =>
      movePrivateFundSourceFile(datasetId!, fileName, folderId),
    onMutate: async ({ fileName, folderId }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PrivateFundSourceFolderTree>(queryKey);
      if (previous && folderId) {
        queryClient.setQueryData<PrivateFundSourceFolderTree>(queryKey, {
          ...previous,
          folders: previous.folders.map((folder) => {
            const remaining = folder.files.filter((file) => file.fileName !== fileName);
            const files =
              folder.folderId === folderId
                ? [...remaining, { fileName, assignment: "manual" as const }]
                : remaining;
            return { ...folder, files, fileCount: files.length };
          }),
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });
}

export function usePrivateFundWorkflow(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-workflow", datasetId],
    queryFn: () => getPrivateFundWorkflow(datasetId!),
    enabled: Boolean(datasetId),
    refetchInterval: 2500,
  });
}

export function usePrivateFundAssets(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-assets", datasetId],
    queryFn: () => getPrivateFundAssets(datasetId!),
    enabled: Boolean(datasetId),
    refetchInterval: 2500,
  });
}

export function usePrivateFundTracking(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-tracking", datasetId],
    queryFn: () => getPrivateFundTrackingOverview(datasetId!),
    enabled: Boolean(datasetId),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => ["queued", "running"].includes(job.status))
        ? 2000
        : 30_000,
  });
}

export function usePrivateFundValuationTracking(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-valuation-tracking", datasetId],
    queryFn: () => getPrivateFundValuationTrackingOverview(datasetId!),
    enabled: Boolean(datasetId),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => ["queued", "running"].includes(job.status))
        ? 2000
        : 30_000,
  });
}

export function usePrivateFundProject(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-project", datasetId],
    queryFn: () => getPrivateFundProject(datasetId!),
    enabled: Boolean(datasetId),
    refetchInterval: (query) => {
      const status = query.state.data?.project.latestJob?.status;
      return status === "queued" || status === "running" ? 2500 : false;
    },
  });
}

export function usePrivateFundPipelineJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["private-fund-pipeline-job", jobId],
    queryFn: () => getPrivateFundPipelineJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}
