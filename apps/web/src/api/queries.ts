import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createProject,
  createSession,
  deleteProject,
  fetchInfo,
  fetchMe,
  listDocuments,
  listProjects,
  listSessions,
  type Project,
} from "./client";
import { ApiError } from "./http";

export function useServerInfo() {
  return useQuery({ queryKey: ["info"], queryFn: fetchInfo, staleTime: 60_000 });
}

export function useMe(accountsEnabled: boolean) {
  return useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    enabled: accountsEnabled,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
      count < 2,
  });
}

export function useProjects(enabled = true) {
  return useQuery({ queryKey: ["projects"], queryFn: listProjects, enabled });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createProject,
    onSuccess: (project: Project) => {
      client.setQueryData<Project[]>(["projects"], (existing) =>
        existing ? [...existing, project] : [project],
      );
    },
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteProject,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useProjectDocuments(projectId: string | null, limit = 200) {
  return useQuery({
    queryKey: ["documents", projectId, limit],
    queryFn: () => listDocuments(projectId!, { limit }),
    enabled: projectId !== null,
  });
}

export function useProjectSessions(projectId: string | null) {
  return useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => listSessions(projectId!),
    enabled: projectId !== null,
    refetchInterval: 15_000,
  });
}

export function useCreateSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: (session) =>
      void client.invalidateQueries({ queryKey: ["sessions", session.projectId] }),
  });
}
