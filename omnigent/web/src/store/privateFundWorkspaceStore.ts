import { create } from "zustand";

export type PrivateFundDocumentPreviewRequest = {
  requestId: number;
  datasetId: string;
  fileName: string;
};

type PrivateFundWorkspaceState = {
  documentPreviewRequest: PrivateFundDocumentPreviewRequest | null;
  selectedSourceDocumentIdsByDataset: Record<string, string[]>;
  openDocumentPreview: (datasetId: string, fileName: string) => void;
  clearDocumentPreview: (requestId: number) => void;
  setSelectedSourceDocumentIds: (datasetId: string, documentIds: string[]) => void;
};

let nextPreviewRequestId = 1;

export const usePrivateFundWorkspaceStore = create<PrivateFundWorkspaceState>((set) => ({
  documentPreviewRequest: null,
  selectedSourceDocumentIdsByDataset: {},
  openDocumentPreview: (datasetId, fileName) =>
    set({
      documentPreviewRequest: {
        requestId: nextPreviewRequestId++,
        datasetId,
        fileName,
      },
    }),
  clearDocumentPreview: (requestId) =>
    set((state) => ({
      documentPreviewRequest:
        state.documentPreviewRequest?.requestId === requestId ? null : state.documentPreviewRequest,
    })),
  setSelectedSourceDocumentIds: (datasetId, documentIds) =>
    set((state) => {
      const nextIds = [...new Set(documentIds.filter(Boolean))].sort();
      const currentIds = state.selectedSourceDocumentIdsByDataset[datasetId] ?? [];
      if (
        currentIds.length === nextIds.length &&
        currentIds.every((documentId, index) => documentId === nextIds[index])
      ) {
        return state;
      }
      return {
        selectedSourceDocumentIdsByDataset: {
          ...state.selectedSourceDocumentIdsByDataset,
          [datasetId]: nextIds,
        },
      };
    }),
}));
