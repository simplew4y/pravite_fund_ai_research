import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import { systemClock } from "@private-fund/core";

import { OperationsRepository } from "./operations-repository.js";
import { ProjectsRepository } from "./projects-repository.js";
import { SessionEventsRepository } from "./session-events-repository.js";
import { SessionJournalRepository } from "./session-journal-repository.js";
import { SessionResourcesRepository } from "./session-resources-repository.js";
import { SessionsRepository } from "./sessions-repository.js";
import { UploadsRepository } from "./uploads-repository.js";
import { UsersRepository } from "./users-repository.js";

export interface ControlRepositories {
  readonly users: UsersRepository;
  readonly projects: ProjectsRepository;
  readonly sessions: SessionsRepository;
  readonly sessionEvents: SessionEventsRepository;
  readonly sessionJournal: SessionJournalRepository;
  readonly sessionResources: SessionResourcesRepository;
  readonly operations: OperationsRepository;
  readonly uploads: UploadsRepository;
}

export function createControlRepositories(
  database: DatabaseSync,
  clock: Clock = systemClock,
): ControlRepositories {
  return {
    users: new UsersRepository(database, clock),
    projects: new ProjectsRepository(database, clock),
    sessions: new SessionsRepository(database, clock),
    sessionEvents: new SessionEventsRepository(database, clock),
    sessionJournal: new SessionJournalRepository(database, clock),
    sessionResources: new SessionResourcesRepository(database, clock),
    operations: new OperationsRepository(database, clock),
    uploads: new UploadsRepository(database, clock),
  };
}
