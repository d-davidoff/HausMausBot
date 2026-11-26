import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { OwnedFile } from "../atomic.ts";

export interface TasksPreferencesStore {
  selectedAccount(userId: string): string | undefined;
  saveAccount(userId: string, accountId: string | undefined): void;
}

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), z.string().min(1).max(128)),
});

export function openTasksPreferencesStore(path = ":memory:"): TasksPreferencesStore {
  const memoryOnly = path === ":memory:";
  const file = memoryOnly ? null : new OwnedFile(path, { mode: 0o600 });
  const accounts: Record<string, string> = {};

  if (file) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = fileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          Object.assign(accounts, parsed.data.accounts);
          file.loaded(raw);
        }
      } catch {}
    }
  }

  return {
    selectedAccount(userId) {
      return accounts[userId];
    },
    saveAccount(userId, accountId) {
      const next = { ...accounts };
      if (!accountId) {
        delete next[userId];
      } else {
        next[userId] = accountId;
      }
      if (file) {
        file.write(`${JSON.stringify({ version: 1, accounts: next }, null, 2)}\n`);
      }
      for (const key of Object.keys(accounts)) delete accounts[key];
      Object.assign(accounts, next);
    },
  };
}
