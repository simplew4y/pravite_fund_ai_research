import { useQuery } from "@tanstack/react-query";
import {
  getPrivateFundPipelineJob,
  getPrivateFundProject,
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
