#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./config.js";
import { createServer, TOOLS, VERSION } from "./server.js";
import { fileState } from "./state.js";

const HELP = `blackwood-mcp ${VERSION}: Blackwood State tools for AI agents over MCP (stdio).

${TOOLS.length} pay-per-call tools (USDC on Base over x402) plus blackwood_account.
The first calls use a free starting credit; after that, payment is built in.

Environment:
  BLACKWOOD_PRIVATE_KEY       Base wallet (0x...) that pays per call once the credit runs out (optional)
  BLACKWOOD_CREDITS_KEY       prepaid credit key (bwk_...) bought at /v1/credits/5 (optional)
  BLACKWOOD_MAX_USD_PER_CALL  cap per call, default 0.05
  BLACKWOOD_MAX_USD_PER_DAY   cap per UTC day for x402 payments, default 1
  BLACKWOOD_NO_TRIAL=1        do not ask for the free starting credit
  BLACKWOOD_HOME              state directory, default ~/.blackwood

Claude Code:  claude mcp add blackwood -- npx -y @blackwood-state/mcp
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const config = readConfig(process.env);
const server = createServer(config, fileState(config.home));
await server.connect(new StdioServerTransport());
// stdout is the MCP channel: anything else goes to stderr.
process.stderr.write(`blackwood-mcp ${VERSION}: ${TOOLS.length} tools ready${config.privateKey ? ", x402 wallet set" : ""}\n`);
