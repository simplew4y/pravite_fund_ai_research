import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import { systemClock } from "@private-fund/core";

import { AssetContextRepository } from "./asset-context-repository.js";
import { ProjectDatabase } from "./database.js";
import { DocumentsRepository } from "./documents-repository.js";
import { EvidenceRepository } from "./evidence-repository.js";
import { ResearchAssetsRepository } from "./research-assets-repository.js";
import { SourceFoldersRepository } from "./source-folders-repository.js";

export class ResearchStore {
  public readonly documents: DocumentsRepository;
  public readonly evidence: EvidenceRepository;
  public readonly assets: ResearchAssetsRepository;
  public readonly assetContext: AssetContextRepository;
  public readonly sourceFolders: SourceFoldersRepository;

  public constructor(
    public readonly database: ProjectDatabase | DatabaseSync,
    clock: Clock = systemClock,
  ) {
    this.documents = new DocumentsRepository(database, clock);
    this.evidence = new EvidenceRepository(database, clock);
    this.assets = new ResearchAssetsRepository(database, clock);
    this.assetContext = new AssetContextRepository(database, clock);
    this.sourceFolders = new SourceFoldersRepository(database, clock);
  }
}

export function createResearchStore(
  database: ProjectDatabase | DatabaseSync,
  clock: Clock = systemClock,
): ResearchStore {
  return new ResearchStore(database, clock);
}
