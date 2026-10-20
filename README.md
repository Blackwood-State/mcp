# @blackwood-state/mcp

Blackwood State tools for AI agents over MCP. The package gives 33 pay-per-call tools, paid in USDC on Base over x402:
- onchain data: token prices, wallet balances and portfolio value, ENS, gas fees, new token pools;
- ECB exchange rates;
- text utilities: summarize, translate, sentiment;
- and more.

The server holds no wallet by default: when a call needs payment, it hands the agent the command that pays it from the wallet the agent already has (AgentCash or the Coinbase Agentic Wallet), capped at the price of that call.

```bash
claude mcp add blackwood -- npx -y @blackwood-state/mcp
```

Any MCP client over stdio:

```json
{ "mcpServers": { "blackwood": { "command": "npx", "args": ["-y", "@blackwood-state/mcp"] } } }
```

## How payment works

1. **Free demo credit.** On first use, the server asks for US$0.05 of credit (one per IP per day) and keeps the key in `~/.blackwood/state.json`. Set `BLACKWOOD_NO_TRIAL=1` to skip it.
2. **Then the wallet you already have.** Without credit, a paid tool returns its live price and two ready commands, and nothing is charged:
   - AgentCash: `npx -y agentcash@0.17.1 fetch '<url>' -m POST -b '<json>' --max-amount <usd>`
   - Coinbase Agentic Wallet, after `npx awal auth login`: `npx -y awal@2.12.2 x402 pay '<url>' -X POST -d '<json>' --max-amount <atomic>`
   The agent should ask the user before paying, unless the user already approved a budget.
3. **Other ways:**
   - **Prepaid credit:** `BLACKWOOD_CREDITS_KEY`, a key bought at `/v1/credits/5`.
   - **Advanced mode:** `BLACKWOOD_PRIVATE_KEY`, a Base wallet that this server signs x402 payments with, only for Base USDC and only within the caps. Use a dedicated wallet that holds only what you plan to spend.
4. **Never charged for failures.** A call that fails or rejects the input costs nothing.

| Variable | Default | |
|---|---|---|
| `BLACKWOOD_CREDITS_KEY` | none | prepaid credit key (`bwk_...`) |
| `BLACKWOOD_PRIVATE_KEY` | none | advanced mode: Base wallet that pays per call over x402 |
| `BLACKWOOD_MAX_USD_PER_CALL` | `0.05` | cap per call in advanced mode |
| `BLACKWOOD_MAX_USD_PER_DAY` | `1` | cap per UTC day in advanced mode |
| `BLACKWOOD_NO_TRIAL` | unset | `1` skips the free demo credit |
| `BLACKWOOD_HOME` | `~/.blackwood` | state directory |

`blackwood_account` (free) shows the credit left, the paying wallet (advanced mode), today's spend and the caps.

The same routes are plain HTTP endpoints. Each one answers 402 with its price; see the OpenAPI at https://x402-gateway.blackwoodstate8.workers.dev/openapi.json. A skill for Agent Skills clients ships in `skills/blackwood-state/SKILL.md`.

Source: https://github.com/Blackwood-State/mcp. MIT license.
