import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";
import { spentToday, today, type StateStore } from "./state.js";

export interface CatalogTool {
  name: string;
  service: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: string;
  method: "GET" | "POST";
  route: string;
  kind: "sync" | "async";
  pollRoute?: string;
  priceUsd: string;
  scheme: string;
}

/** How to pay one call with a wallet the agent already has (AgentCash or the Coinbase Agentic Wallet). */
export interface WalletPayment {
  priceUsd: string;
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  agentcash: string;
  awal: string;
}

export type CallResult =
  | { ok: true; body: unknown; paidWith: "credit" | "x402"; chargedUsd?: number; balanceUsd?: string }
  | { ok: false; status: number; message: string; body?: unknown; payment?: WalletPayment };

const NETWORK = "eip155:8453";
const POLL_MS = 2_000;
const POLL_DEADLINE_MS = 120_000;
/** Pinned so the command an agent runs is the one that was reviewed. */
export const AGENTCASH_CLI = "agentcash@0.17.1";
export const AWAL_CLI = "awal@2.12.2";

/** POSIX single quotes: the JSON body goes to the shell as one literal argument. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The live price from the 402 (PAYMENT-REQUIRED header, base64 JSON), Base USDC only; undefined when unreadable. */
export function livePriceUsd(res: Response): string | undefined {
  const header = res.headers.get("payment-required");
  if (!header) return undefined;
  try {
    const required = JSON.parse(atob(header)) as { accepts?: { network?: string; scheme?: string; amount?: string }[] };
    const accepts = (required.accepts ?? []).filter((a) => a.network === NETWORK && /^\d+$/.test(a.amount ?? ""));
    const pick = accepts.find((a) => a.scheme === "exact") ?? accepts[0];
    return pick ? String(Number(pick.amount) / 1e6) : undefined;
  } catch {
    return undefined;
  }
}

/** The two commands that pay this call from an existing wallet, capped at the price of the call. */
export function walletPayment(tool: CatalogTool, input: Record<string, unknown>, origin: string, priceUsd: string): WalletPayment {
  const base = `${origin}${tool.route}`;
  const atomic = Math.round(Number(priceUsd) * 1e6);
  if (tool.method === "GET") {
    const url = new URL(base);
    for (const [k, v] of Object.entries(input)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return {
      priceUsd,
      method: "GET",
      url: url.toString(),
      agentcash: `npx -y ${AGENTCASH_CLI} fetch ${quote(url.toString())} --max-amount ${priceUsd}`,
      awal: `npx -y ${AWAL_CLI} x402 pay ${quote(base)}${Object.keys(input).length ? ` -q ${quote(JSON.stringify(input))}` : ""} --max-amount ${atomic}`,
    };
  }
  const body = JSON.stringify(input);
  return {
    priceUsd,
    method: "POST",
    url: base,
    body: input,
    agentcash: `npx -y ${AGENTCASH_CLI} fetch ${quote(base)} -m POST -b ${quote(body)} --max-amount ${priceUsd}`,
    awal: `npx -y ${AWAL_CLI} x402 pay ${quote(base)} -X POST -d ${quote(body)} --max-amount ${atomic}`,
  };
}

/**
 * Pays our own routes: the credit key first (the free starting credit, a demo, or credits bought at /v1/credits/5).
 * Without credit, the default is to hand the agent the command that pays the call from a wallet it already has
 * (AgentCash or the Coinbase Agentic Wallet). Advanced mode: with BLACKWOOD_PRIVATE_KEY, x402 from that Base wallet,
 * only within the per-call and per-day caps. Nothing is charged on errors.
 */
export class Caller {
  private readonly fetchImpl: typeof fetch;
  private readonly paidFetch?: typeof fetch;

  constructor(
    private readonly config: Config,
    private readonly state: StateStore,
    private readonly mainOrigin: string,
    private readonly userAgent: string,
    fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.fetchImpl = fetchImpl;
    if (config.privateKey) {
      const capAtomic = BigInt(Math.round(config.maxUsdPerCall * 1_000_000));
      const client = new x402Client().register(NETWORK as never, new ExactEvmScheme(privateKeyToAccount(config.privateKey) as never));
      // Only Base USDC requirements at or under the per-call cap are ever signed.
      client.registerPolicy((_version, requirements) => requirements.filter((r) => r.network === NETWORK && BigInt(r.amount ?? "0") <= capAtomic));
      this.paidFetch = wrapFetchWithPayment(fetchImpl, client);
    }
  }

  get walletAddress(): string | undefined {
    return this.config.privateKey ? privateKeyToAccount(this.config.privateKey).address : undefined;
  }

  creditsKey(): string | undefined {
    return this.config.creditsKey ?? this.state.read().creditsKey;
  }

  /** The free starting credit: asked once per UTC day at most, kept in the local state file. */
  async ensureTrial(now = Date.now()): Promise<string | undefined> {
    const existing = this.creditsKey();
    if (existing || !this.config.trial) return existing;
    const state = this.state.read();
    if (state.trialDay === today(now)) return undefined;
    this.state.write({ ...state, trialDay: today(now) });
    try {
      const res = await this.fetchImpl(`${this.config.origin ?? this.mainOrigin}/v1/credits/trial`, { method: "POST", headers: { "user-agent": this.userAgent } });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { apiKey?: string };
      if (!body.apiKey) return undefined;
      this.state.write({ ...this.state.read(), creditsKey: body.apiKey });
      return body.apiKey;
    } catch {
      return undefined;
    }
  }

  private request(tool: CatalogTool, input: Record<string, unknown>, headers: Record<string, string>) {
    const url = new URL(`${this.config.origin ?? tool.origin}${tool.route}`);
    if (tool.method === "GET") for (const [k, v] of Object.entries(input)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return {
      url: url.toString(),
      init: {
        method: tool.method,
        headers: { "content-type": "application/json", "user-agent": this.userAgent, ...headers },
        body: tool.method === "POST" ? JSON.stringify(input) : undefined,
      } satisfies RequestInit,
    };
  }

  async call(tool: CatalogTool, input: Record<string, unknown>, now = Date.now()): Promise<CallResult> {
    // 1. Credit key (free starting credit or bought credits): no signature per call.
    const key = (await this.ensureTrial(now)) ?? this.creditsKey();
    let challenge: Response | undefined;
    if (key) {
      const { url, init } = this.request(tool, input, { authorization: `Bearer ${key}` });
      const res = await this.fetchImpl(url, init);
      if (res.status === 401) this.state.write({ ...this.state.read(), creditsKey: undefined });
      else if (res.status !== 402) return this.finish(tool, res, "credit");
      else challenge = res;
      // 402 with a key: the credit ran out; the route asks for x402 as usual.
    }
    // 2. Default: the command that pays from a wallet the agent already has. Nothing is signed here.
    if (!this.paidFetch) return this.walletCommands(tool, input, challenge);
    // 3. Advanced mode: x402 from BLACKWOOD_PRIVATE_KEY, within the caps.
    const price = Number(tool.priceUsd);
    if (price > this.config.maxUsdPerCall) return { ok: false, status: 402, message: `${tool.title} costs US$${tool.priceUsd}, above BLACKWOOD_MAX_USD_PER_CALL (US$${this.config.maxUsdPerCall}).` };
    const spent = spentToday(this.state.read(), now);
    if (spent + price > this.config.maxUsdPerDay + 1e-9) {
      return { ok: false, status: 402, message: `Daily cap reached: US$${spent.toFixed(4)} spent today of BLACKWOOD_MAX_USD_PER_DAY (US$${this.config.maxUsdPerDay}).` };
    }
    const { url, init } = this.request(tool, input, {});
    const res = await this.paidFetch(url, init);
    const charged = Number(res.headers.get("x-charge-amount") ?? "") / 1e6 || price;
    if (res.ok) {
      const s = this.state.read();
      this.state.write({ ...s, spend: { day: today(now), usd: Math.round((spentToday(s, now) + charged) * 1e6) / 1e6 } });
    }
    return this.finish(tool, res, "x402", res.ok ? charged : undefined);
  }

  /** Reads the live price from the route's 402 (unpaid request, free) and returns the wallet commands for it. */
  private async walletCommands(tool: CatalogTool, input: Record<string, unknown>, challenge?: Response): Promise<CallResult> {
    let res = challenge;
    if (!res) {
      try {
        const { url, init } = this.request(tool, input, {});
        res = await this.fetchImpl(url, init);
      } catch {
        res = undefined;
      }
    }
    // Anything but a 402 (bad input, route down) is answered as is, and nothing is owed.
    if (res && res.status !== 402) return this.finish(tool, res, "x402");
    const priceUsd = (res && livePriceUsd(res)) ?? tool.priceUsd;
    const payment = walletPayment(tool, input, this.config.origin ?? tool.origin, priceUsd);
    return {
      ok: false,
      status: 402,
      payment,
      message: [
        `${tool.title} costs US$${priceUsd} per call, paid in USDC on Base over x402. No free credit is left here, and this server holds no wallet.`,
        "Ask the user before paying, unless they already approved a budget for these calls. Then run one of these commands with the wallet you already have; --max-amount caps the payment at this price:",
        `- AgentCash: ${payment.agentcash}`,
        `- Coinbase Agentic Wallet (after npx awal auth login): ${payment.awal}`,
        ...(tool.kind === "async" ? ["This route runs as a job: the paid answer carries pollUrl; GET it (free, no payment) until done is true and read output."] : []),
        `Other ways: prepaid credits at ${this.mainOrigin}/v1/credits/5 (set BLACKWOOD_CREDITS_KEY), or advanced mode with BLACKWOOD_PRIVATE_KEY, a Base wallet that this server signs with (capped at US$${this.config.maxUsdPerCall} per call and US$${this.config.maxUsdPerDay} per day).`,
      ].join("\n"),
    };
  }

  private async finish(tool: CatalogTool, res: Response, paidWith: "credit" | "x402", chargedUsd?: number): Promise<CallResult> {
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { ok: false, status: res.status, message: `${tool.title} answered HTTP ${res.status} (not charged).`, body };
    const balanceUsd = res.headers.get("x-credit-balance") ?? undefined;
    const credit = paidWith === "credit" ? Number(res.headers.get("x-credit-charged") ?? "") || undefined : chargedUsd;
    if (tool.kind !== "async") return { ok: true, body, paidWith, ...(credit ? { chargedUsd: credit } : {}), ...(balanceUsd ? { balanceUsd } : {}) };
    // Async job: the result is polled for free until it is done.
    const ticket = body as { pollUrl?: string };
    if (!ticket.pollUrl) return { ok: true, body, paidWith };
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      const poll = (await (await this.fetchImpl(ticket.pollUrl, { headers: { "user-agent": this.userAgent } })).json()) as { done?: boolean; status?: string; output?: unknown; error?: unknown };
      if (poll.done) {
        return poll.status === "complete"
          ? { ok: true, body: poll.output, paidWith, ...(credit ? { chargedUsd: credit } : {}) }
          : { ok: false, status: 500, message: `${tool.title} job ended as ${poll.status}.`, body: poll.error };
      }
      await this.sleep(POLL_MS);
    }
    return { ok: true, body: ticket, paidWith };
  }
}
