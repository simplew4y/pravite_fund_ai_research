import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deletePrivateFundFiles,
  deletePrivateFundProject,
  getPrivateFundAssets,
  getPrivateFundPipelineJob,
  getPrivateFundProject,
  getPrivateFundTrackingOverview,
  getPrivateFundWorkflow,
  listPrivateFundProjects,
} from "@/lib/privateFundApi";

export const privateFundProjectsQueryKey = ["private-fund-projects"] as const;

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
      ]);
    },
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
