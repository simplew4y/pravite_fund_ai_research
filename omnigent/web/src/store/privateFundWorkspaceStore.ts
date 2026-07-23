import { create } from "zustand";

export type PrivateFundDocumentPreviewRequest = {
  requestId: number;
  datasetId: string;
  fileName: string;
};

type PrivateFundWorkspaceState = {
  documentPreviewRequest: PrivateFundDocumentPreviewRequest | null;
  openDocumentPreview: (datasetId: string, fileName: string) => void;
  clearDocumentPreview: (requestId: number) => void;
};

let nextPreviewRequestId = 1;

export const usePrivateFundWorkspaceStore = create<PrivateFundWorkspaceState>((set) => ({
  documentPreviewRequest: null,
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
}));
