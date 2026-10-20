import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Caller, type CatalogTool } from "../src/caller.js";
import { readConfig } from "../src/config.js";
import { createServer, TOOLS } from "../src/server.js";
import { memoryState } from "../src/state.js";

const ORIGIN = "https://gateway.example.test";
const tool: CatalogTool = {
  name: "blackwood_token_price",
  service: "token-price",
  title: "Token price on Base",
  description: "Token price.",
  inputSchema: { type: "object", properties: { token: { type: "string" } } },
  origin: ORIGIN,
  method: "POST",
  route: "/v1/token-price",
  kind: "sync",
  priceUsd: "0.002",
  scheme: "exact",
};
const NOW = Date.UTC(2026, 9, 19, 12);

/** Gateway falso: crédito grátis, saldo e as rotas, contando os pedidos. */
function gateway(opts: { trial?: number; route?: (auth: string | null) => Response }) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (url.endsWith("/v1/credits/trial")) return opts.trial === 200 ? Response.json({ apiKey: "bwk_trial_key_0123456789abcdef0123456789" }) : new Response("{}", { status: opts.trial ?? 429 });
    if (url.endsWith("/v1/credits")) return Response.json({ balanceUsd: "0.048" });
    return opts.route ? opts.route(auth) : Response.json({ priceUsd: 3000 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("pacote Blackwood: quem paga e quanto (corte de 18/10/2026 22:50, item 1)", () => {
  it("primeira chamada: pede o crédito grátis uma vez e paga com ele, sem x402", async () => {
    const state = memoryState();
    const { fetchImpl, calls } = gateway({ trial: 200, route: (auth) => (auth ? new Response(JSON.stringify({ priceUsd: 3000 }), { headers: { "x-credit-charged": "0.002", "x-credit-balance": "0.048" } }) : new Response("{}", { status: 402 })) });
    const caller = new Caller(readConfig({ BLACKWOOD_HOME: "/tmp/x" }), state, ORIGIN, "test", fetchImpl);
    const result = await caller.call(tool, { token: "WETH" }, NOW);
    expect(result).toMatchObject({ ok: true, paidWith: "credit", chargedUsd: 0.002, balanceUsd: "0.048" });
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/v1/credits/trial`, `${ORIGIN}/v1/token-price`]);
    expect(state.read()).toMatchObject({ creditsKey: "bwk_trial_key_0123456789abcdef0123456789", trialDay: "2026-10-19" });
  });

  it("crédito acabou e sem carteira: não cobra e explica como continuar; o crédito grátis não é pedido de novo no dia", async () => {
    const state = memoryState({ trialDay: "2026-10-19" });
    const { fetchImpl, calls } = gateway({ trial: 429, route: () => new Response("{}", { status: 402 }) });
    const caller = new Caller(readConfig({}), state, ORIGIN, "test", fetchImpl);
    const result = await caller.call(tool, { token: "WETH" }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("BLACKWOOD_PRIVATE_KEY");
      expect(result.message).toContain("Ask the user before paying");
      // v0.2: o comando que paga pela carteira que o agente já tem, com teto no preço da chamada.
      expect(result.payment?.agentcash).toBe(`npx -y agentcash@0.17.1 fetch '${ORIGIN}/v1/token-price' -m POST -b '{"token":"WETH"}' --max-amount 0.002`);
      expect(result.payment?.awal).toBe(`npx -y awal@2.12.2 x402 pay '${ORIGIN}/v1/token-price' -X POST -d '{"token":"WETH"}' --max-amount 2000`);
    }
    expect(calls.some((c) => c.url.endsWith("/trial"))).toBe(false);
  });

  it("v0.2: preço vivo do 402, aspas do shell e rota GET com query", async () => {
    const required = btoa(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000" }] }));
    const { fetchImpl, calls } = gateway({ route: () => new Response("{}", { status: 402, headers: { "payment-required": required } }) });
    const caller = new Caller(readConfig({ BLACKWOOD_NO_TRIAL: "1" }), memoryState(), ORIGIN, "test", fetchImpl);
    const result = await caller.call(tool, { token: "it's" }, NOW);
    expect(calls.map((c) => c.auth)).toEqual([null]);
    expect(result.ok === false && result.payment).toMatchObject({ priceUsd: "0.003", method: "POST" });
    if (!result.ok) expect(result.payment?.agentcash).toBe(`npx -y agentcash@0.17.1 fetch '${ORIGIN}/v1/token-price' -m POST -b '{"token":"it'\\''s"}' --max-amount 0.003`);

    const get = await caller.call({ ...tool, method: "GET", route: "/v1/fx" }, { base: "EUR" }, NOW);
    if (!get.ok) {
      expect(get.payment?.agentcash).toBe(`npx -y agentcash@0.17.1 fetch '${ORIGIN}/v1/fx?base=EUR' --max-amount 0.003`);
      expect(get.payment?.awal).toBe(`npx -y awal@2.12.2 x402 pay '${ORIGIN}/v1/fx' -q '{"base":"EUR"}' --max-amount 3000`);
    } else throw new Error("esperava 402");

    // Entrada inválida (400) volta como está, sem comando de pagamento.
    const bad = gateway({ route: () => new Response('{"error":"invalid_input"}', { status: 400 }) });
    const invalid = await new Caller(readConfig({ BLACKWOOD_NO_TRIAL: "1" }), memoryState(), ORIGIN, "test", bad.fetchImpl).call(tool, {}, NOW);
    expect(invalid).toMatchObject({ ok: false, status: 400 });
    expect(invalid.ok === false && invalid.payment).toBeUndefined();
  });

  it("tetos: acima do teto por chamada ou do teto do dia, nada é assinado", async () => {
    const key = `0x${"1".repeat(64)}`;
    const { fetchImpl, calls } = gateway({ route: () => new Response("{}", { status: 402 }) });
    const tight = new Caller(readConfig({ BLACKWOOD_PRIVATE_KEY: key, BLACKWOOD_MAX_USD_PER_CALL: "0.001", BLACKWOOD_NO_TRIAL: "1" }), memoryState(), ORIGIN, "test", fetchImpl);
    const over = await tight.call(tool, {}, NOW);
    expect(over.ok === false && over.message).toContain("BLACKWOOD_MAX_USD_PER_CALL");
    const spent = memoryState({ spend: { day: "2026-10-19", usd: 0.999 } });
    const daily = new Caller(readConfig({ BLACKWOOD_PRIVATE_KEY: key, BLACKWOOD_NO_TRIAL: "1" }), spent, ORIGIN, "test", fetchImpl);
    const capped = await daily.call(tool, {}, NOW);
    expect(capped.ok === false && capped.message).toContain("Daily cap reached");
    expect(calls).toEqual([]);
  });

  it("chave de crédito recusada (401) é descartada do estado", async () => {
    const state = memoryState({ creditsKey: "bwk_old_key_0123456789abcdef0123456789", trialDay: "2026-10-19" });
    const { fetchImpl } = gateway({ route: (auth) => new Response("{}", { status: auth ? 401 : 402 }) });
    await new Caller(readConfig({}), state, ORIGIN, "test", fetchImpl).call(tool, {}, NOW);
    expect(state.read().creditsKey).toBeUndefined();
  });

  it("servidor MCP: as rotas do catálogo e blackwood_account, com preço na descrição", async () => {
    const { fetchImpl } = gateway({ trial: 200 });
    const server = createServer(readConfig({ BLACKWOOD_NO_TRIAL: "1" }), memoryState(), fetchImpl);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length + 1);
    expect(tools.find((t) => t.name === "blackwood_account")).toBeDefined();
    const price = tools.find((t) => t.name === TOOLS[0]!.name)!;
    expect(price.description).toContain(`US$${TOOLS[0]!.priceUsd} per call`);
    const account = await client.callTool({ name: "blackwood_account", arguments: {} });
    expect(JSON.stringify(account.content)).toContain("maxUsdPerDay");
    await client.close();
  });
});
