import type { DatabaseSync } from "node:sqlite";

import { tenantIdentitySchema } from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowString,
} from "./rows.js";
import type { UserRecord } from "./types.js";

export interface CreateUserInput {
  readonly id?: string;
  readonly dataNamespace: string;
  readonly email?: string | null;
}

export interface UpsertCloudShadowInput {
  readonly userId: string;
  readonly dataNamespace: string;
  readonly email?: string | null;
}

function mapUser(row: SqlRow): UserRecord {
  return {
    id: rowString(row, "id"),
    dataNamespace: rowString(row, "dataNamespace"),
    email: rowNullableString(row, "email"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
  };
}

const USER_COLUMNS = `
  id,
  data_namespace AS dataNamespace,
  email,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export class UsersRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public create(input: CreateUserInput): UserRecord {
    const id = input.id ?? newId("user");
    tenantIdentitySchema.parse({
      userId: id,
      dataNamespace: input.dataNamespace,
    });

    if (this.findById(id) !== null) {
      throw new ConflictError(`User ${id} already exists`, "user_exists");
    }
    const namespaceOwner = this.findByNamespace(input.dataNamespace);
    if (namespaceOwner !== null) {
      throw new ConflictError(
        `Data namespace ${input.dataNamespace} is already assigned`,
        "namespace_exists",
      );
    }

    const now = isoNow(this.clock);
    this.database
      .prepare(
        `INSERT INTO users(id, data_namespace, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.dataNamespace, input.email ?? null, now, now);
    return this.getById(id);
  }

  public upsertCloudShadow(input: UpsertCloudShadowInput): UserRecord {
    tenantIdentitySchema.parse({
      userId: input.userId,
      dataNamespace: input.dataNamespace,
    });
    const existing = this.findById(input.userId);
    if (existing === null) {
      return this.create({
        id: input.userId,
        dataNamespace: input.dataNamespace,
        email: input.email ?? null,
      });
    }
    if (existing.dataNamespace !== input.dataNamespace) {
      throw new ConflictError(
        "A cloud user cannot change its local data namespace",
        "namespace_mismatch",
      );
    }

    if (input.email === undefined || input.email === existing.email) {
      return existing;
    }

    const now = isoNow(this.clock);
    this.database
      .prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?")
      .run(input.email, now, input.userId);
    return this.getById(input.userId);
  }

  public findById(id: string): UserRecord | null {
    const row = this.database
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .get(id);
    return row === undefined ? null : mapUser(row);
  }

  public getById(id: string): UserRecord {
    const user = this.findById(id);
    if (user === null) {
      throw new NotFoundError("User");
    }
    return user;
  }

  public findByNamespace(dataNamespace: string): UserRecord | null {
    const row = this.database
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE data_namespace = ?`)
      .get(dataNamespace);
    return row === undefined ? null : mapUser(row);
  }

  public getByNamespace(dataNamespace: string): UserRecord {
    const user = this.findByNamespace(dataNamespace);
    if (user === null) {
      throw new NotFoundError("Tenant");
    }
    return user;
  }
}
