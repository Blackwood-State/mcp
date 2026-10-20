import { homedir } from "node:os";
import { join } from "node:path";

/** Configuration from the environment. Every value has a safe default. */
export interface Config {
  /** Base wallet that pays per call over x402 once the free credit runs out (optional). */
  privateKey?: `0x${string}`;
  /** Prepaid credit key (bwk_...) bought at /v1/credits/5; overrides the free starting credit. */
  creditsKey?: string;
  maxUsdPerCall: number;
  maxUsdPerDay: number;
  /** Ask for the free starting credit on the first call (BLACKWOOD_NO_TRIAL=1 turns it off). */
  trial: boolean;
  home: string;
  /** Overrides the origin of every tool (testing or a self-hosted gateway). */
  origin?: string;
}

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const key = env.BLACKWOOD_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("BLACKWOOD_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key");
  return {
    ...(key ? { privateKey: key as `0x${string}` } : {}),
    ...(env.BLACKWOOD_CREDITS_KEY ? { creditsKey: env.BLACKWOOD_CREDITS_KEY.trim() } : {}),
    maxUsdPerCall: number(env.BLACKWOOD_MAX_USD_PER_CALL, 0.05),
    maxUsdPerDay: number(env.BLACKWOOD_MAX_USD_PER_DAY, 1),
    trial: env.BLACKWOOD_NO_TRIAL !== "1",
    home: env.BLACKWOOD_HOME ?? join(homedir(), ".blackwood"),
    ...(env.BLACKWOOD_ORIGIN ? { origin: env.BLACKWOOD_ORIGIN.replace(/\/+$/, "") } : {}),
  };
}
