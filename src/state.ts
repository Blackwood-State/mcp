import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the package keeps between runs: the credit key and today's x402 spend. Never the wallet key. */
export interface StateData {
  creditsKey?: string;
  /** UTC day the free starting credit was last requested (one request per day). */
  trialDay?: string;
  spend?: { day: string; usd: number };
}

export interface StateStore {
  read(): StateData;
  write(data: StateData): void;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** JSON file readable only by the user (0600), in a directory only the user can open (0700). */
export function fileState(home: string): StateStore {
  const path = join(home, "state.json");
  return {
    read() {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StateData) : {};
      } catch {
        return {};
      }
    },
    write(data) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* Windows ignores POSIX modes */
      }
    },
  };
}

export function memoryState(initial: StateData = {}): StateStore {
  let data = { ...initial };
  return { read: () => ({ ...data }), write: (next) => void (data = { ...next }) };
}

export function spentToday(state: StateData, now = Date.now()): number {
  return state.spend?.day === today(now) ? state.spend.usd : 0;
}
