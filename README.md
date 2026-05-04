# billcom-spend-mcp-server

MCP server for BILL Spend & Expense (formerly Divvy) v3 API. Exposes transactions, budgets, cards, reimbursements, and receipt uploads to Claude Code as tools.

## Setup

1. Clone and install:

   ```bash
   git clone https://github.com/tbarsness/billcom-spend-mcp-server.git
   cd billcom-spend-mcp-server
   ```

2. Install and build:

   ```bash
   npm install
   npm run build
   ```

3. Get a Spend & Expense API token. In production, the user generating the token must have the **ADMIN** role.

   - Production: BILL Help Center → "Generate an API token in BILL Spend & Expense"
   - Sandbox: register at <https://app-dev-bdc-stg.divvy.co/create-sandbox-company>

4. Set environment variables (copy `.env.example` to `.env`):

   ```
   BILLCOM_SPEND_API_TOKEN=<your-token>
   BILLCOM_ENVIRONMENT=sandbox    # or "production"
   ```

## Register with Claude Code

```bash
claude mcp add billcom-spend node /path/to/billcom-spend-mcp-server/dist/index.js \
  -e BILLCOM_SPEND_API_TOKEN=<your-token> \
  -e BILLCOM_ENVIRONMENT=sandbox
```

Or add to `.mcp.json` / settings directly:

```json
{
  "mcpServers": {
    "billcom-spend": {
      "command": "node",
      "args": ["/path/to/billcom-spend-mcp-server/dist/index.js"],
      "env": {
        "BILLCOM_SPEND_API_TOKEN": "<your-token>",
        "BILLCOM_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

## Tools

### Transactions
- `search_transactions` — list with filters (cardId, merchantName, userId, budgetId, amount, occurredTime, etc.)
- `get_transaction` — fetch by UUID
- `tag_transaction_custom_fields` — set custom field values (categorization, GL coding)
- `attach_receipt_to_transaction` — upload local file and attach to a transaction (3-step flow handled internally)

### Budgets
- `search_budgets`
- `get_budget`
- `create_budget`

### Cards
- `search_cards`
- `get_card`
- `create_virtual_card`
- `freeze_card`
- `unfreeze_card`

### Reimbursements
- `search_reimbursements`
- `get_reimbursement`
- `create_reimbursement` — accepts `receiptFilePaths` to upload local files in one shot
- `approve_reimbursement`
- `deny_reimbursement`

## API surface

- Base URL (prod): `https://gateway.bill.com/connect/v3/spend`
- Base URL (sandbox): `https://gateway.stage.bill.com/connect/v3/spend`
- Auth: `apiToken` header
- Rate limit: 60 calls/token/minute

## Filter syntax

List endpoints accept `filters` and `sort` strings:

- `filters`: `field:op:value` comma-separated. Ops: `eq, ne, lt, le, gt, ge, in, nin, sw, ew, ct`.
  Example: `filters=budgetIds:eq:abc-123,amount:gt:100`
- `sort`: `field:asc` or `field:desc`.
- Pagination: `max` (1-100; transactions cap at 50), `nextPage`, `prevPage`.

## Notes

- Receipt upload uses BILL's 3-step flow: `POST /transactions/receipt-upload-url` → `PUT` binary to that URL → `POST /transactions/{id}/receipts`. The `attach_receipt_to_transaction` and `create_reimbursement` (with `receiptFilePaths`) tools handle all three steps for you.
- Sandbox cards are always frozen; you cannot test card transactions there.
- Card PAN/CVV retrieval (`/cards/{id}/pan-jwt`) is intentionally not exposed. Add it later if needed.
