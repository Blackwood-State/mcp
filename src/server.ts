import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import catalog from "./catalog.json" with { type: "json" };
import { Caller, type CatalogTool } from "./caller.js";
import { spentToday, type StateStore } from "./state.js";
import type { Config } from "./config.js";

export const VERSION = "0.2.0";
export const USER_AGENT = `blackwood-mcp/${VERSION}`;
export const TOOLS = catalog.tools as CatalogTool[];
export const MAIN_ORIGIN = catalog.origin;
const ACCOUNT_TOOL = "blackwood_account";

export { Caller, type CatalogTool } from "./caller.js";
export { readConfig, type Config } from "./config.js";
export { fileState, memoryState, type StateStore } from "./state.js";

/** The MCP server: every Blackwood State route as a tool, plus blackwood_account (credit, wallet, caps). */
export function createServer(config: Config, state: StateStore, fetchImpl: typeof fetch = fetch): Server {
  const caller = new Caller(config, state, MAIN_ORIGIN, USER_AGENT, fetchImpl);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const server = new Server({ name: "blackwood-state", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: `${t.description} Price: US$${t.priceUsd} per call. A small free demo credit covers the first calls; after that the tool returns the command that pays the call from your own wallet (AgentCash or Coinbase Agentic Wallet).`,
        inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
        // A chamada gasta dinheiro (crédito ou x402): não é somente leitura, para o cliente poder pedir aprovação.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      })),
      {
        name: ACCOUNT_TOOL,
        title: "Blackwood account",
        description: "Free. Shows the credit balance, the wallet that pays over x402 (if any), today's spend and the caps.",
        inputSchema: { type: "object" as const, properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const text = (value: unknown) => ({ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
    if (request.params.name === ACCOUNT_TOOL) {
      const key = await caller.ensureTrial();
      let balance: unknown = null;
      if (key) {
        const res = await fetchImpl(`${config.origin ?? MAIN_ORIGIN}/v1/credits`, { headers: { authorization: `Bearer ${key}`, "user-agent": USER_AGENT } });
        balance = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
      }
      return {
        content: [
          text({
            credit: key ? { keyPrefix: key.slice(0, 10), account: balance } : null,
            wallet: caller.walletAddress ?? null,
            spentTodayUsd: spentToday(state.read()),
            caps: { maxUsdPerCall: config.maxUsdPerCall, maxUsdPerDay: config.maxUsdPerDay },
          }),
        ],
      };
    }
    const tool = byName.get(request.params.name);
    if (!tool) return { content: [text(`Unknown tool: ${request.params.name}`)], isError: true };
    const result = await caller.call(tool, (request.params.arguments ?? {}) as Record<string, unknown>);
    // Without credit or a key: the commands that pay from the agent's own wallet, also as JSON for programs.
    if (!result.ok) return { content: [text(result.message), ...(result.payment ? [text({ payment: result.payment })] : []), ...(result.body ? [text(result.body)] : [])], isError: true };
    const paid = result.paidWith === "credit" ? `credit${result.balanceUsd ? `, balance US$${result.balanceUsd}` : ""}` : `x402 US$${result.chargedUsd ?? tool.priceUsd}`;
    return { content: [text(result.body)], _meta: { "blackwood/payment": paid } };
  });
  return server;
}
