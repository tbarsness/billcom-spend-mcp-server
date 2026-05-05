import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillSpendClient, buildListQuery } from "./client.js";

const PaginationShape = {
  max: z.number().int().min(1).max(100).optional().describe("Results per page (1-100, default 20). Transactions cap at 50."),
  nextPage: z.string().optional().describe("Pagination token for the next page."),
  prevPage: z.string().optional().describe("Pagination token for the previous page."),
  sort: z
    .string()
    .optional()
    .describe('Sort spec, format "field:asc" or "field:desc".'),
  filters: z
    .string()
    .optional()
    .describe(
      'Filters, format "field:op:value" comma-separated (ops: eq, ne, lt, le, gt, ge, in, nin, sw, ew, ct).'
    ),
};

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function registerTools(server: McpServer, client: BillSpendClient): void {
  // -- Transactions ----------------------------------------------------------

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "List Spend & Expense card transactions with optional filters. Filterable fields include cardId, merchantName, userId, budgetId, transactionIds, customFields, receiptStatus, type, occurredTime, authorizedTime, updatedTime, locked, completed, amount, reviewStatus, syncStatus.",
      inputSchema: {
        ...PaginationShape,
        showCustomFieldIds: z
          .string()
          .optional()
          .describe("Comma-separated custom field IDs to include in the response."),
        includeReceipts: z
          .boolean()
          .optional()
          .describe("Include receipt data in each transaction."),
      },
    },
    async (input) => ok(await client.request("GET", "/transactions", { query: buildListQuery(input) }))
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description: "Fetch a single Spend & Expense transaction by UUID.",
      inputSchema: {
        transactionId: z.string().describe("Transaction UUID."),
      },
    },
    async ({ transactionId }) =>
      ok(await client.request("GET", `/transactions/${encodeURIComponent(transactionId)}`))
  );

  server.registerTool(
    "tag_transaction_custom_fields",
    {
      title: "Tag transaction with custom fields",
      description:
        "Set or update custom field values on a transaction (used for categorization, GL coding, memos exposed as custom fields). Pass each custom field UUID with its selected value UUID(s). The MCP fetches the transaction to translate UUIDs to BILL's internal IDs before sending.",
      inputSchema: {
        transactionId: z.string().describe("Transaction UUID."),
        customFields: z
          .array(
            z.object({
              customFieldUuid: z.string().describe("UUID (tty_…) or base64 id of the custom field."),
              selectedValueUuids: z
                .array(z.string())
                .optional()
                .describe(
                  "UUIDs (tvl_…) or base64 ids of selected values. Multi-value fields not yet supported by BILL's API; only the first value is sent."
                ),
              value: z
                .string()
                .optional()
                .describe("Free-text value, for non-selection custom fields (e.g. Notes)."),
            })
          )
          .describe("Custom field values to apply."),
      },
    },
    async ({ transactionId, customFields }) => {
      // BILL's PUT /transactions/{id}/custom-fields has two surprises:
      //   1. The body field is named `customFieldId` (not `customFieldUuid`).
      //   2. `selectedValues` is a single STRING (a base64 id), not an array.
      //   3. The `tty_…` / `tvl_…` UUIDs returned by GET are silently rejected
      //      (the API returns SUCCESS but the update is dropped). BILL only
      //      applies the update when given the base64 `id` form.
      // We accept either form from callers and look up the base64 id by
      // re-reading the transaction.
      type CFEntry = {
        id: string;
        uuid: string;
        selectedValues?: { id: string; uuid: string; value?: string }[];
      };
      const tx = await client.request<{ customFields?: CFEntry[] }>(
        "GET",
        `/transactions/${encodeURIComponent(transactionId)}`
      );
      const fieldByKey = new Map<string, CFEntry>();
      for (const cf of tx.customFields ?? []) {
        if (cf.id) fieldByKey.set(cf.id, cf);
        if (cf.uuid) fieldByKey.set(cf.uuid, cf);
      }
      const resolveFieldId = (key: string): string => {
        const cf = fieldByKey.get(key);
        if (!cf) {
          throw new Error(
            `customFieldUuid "${key}" not found on transaction ${transactionId}. ` +
              "Pass the field's `uuid` (tty_…) or `id` (base64) as returned by get_transaction."
          );
        }
        return cf.id;
      };
      const translated = customFields.map((f) => {
        const customFieldId = resolveFieldId(f.customFieldUuid);
        const out: Record<string, unknown> = { customFieldId };
        if (f.selectedValueUuids && f.selectedValueUuids.length > 0) {
          // BILL's API takes a single base64 id string here, not an array.
          // The MCP can't translate value UUIDs (`tvl_…`) → ids without a
          // catalog endpoint, so callers must pass the base64 id form
          // (the `id` field on a prior transaction's selectedValues).
          // Passing a UUID returns SUCCESS but silently drops the update.
          out.selectedValues = f.selectedValueUuids[0];
        }
        if (f.value !== undefined) out.value = f.value;
        return out;
      });
      return ok(
        await client.request("PUT", `/transactions/${encodeURIComponent(transactionId)}/custom-fields`, {
          body: { customFields: translated },
        })
      );
    }
  );

  server.registerTool(
    "attach_receipt_to_transaction",
    {
      title: "Attach receipt to transaction",
      description:
        "Upload a receipt image from a local file path and attach it to a transaction. Runs the full 3-step BILL flow: get upload URL, PUT image, attach to transaction.",
      inputSchema: {
        transactionId: z.string().describe("Transaction UUID."),
        filePath: z.string().describe("Absolute path to the receipt image file (jpg, png, pdf)."),
      },
    },
    async ({ transactionId, filePath }) => {
      const { uploadUrl, filename } = await client.uploadReceiptFile(filePath);
      // BILL's POST /transactions/{id}/receipts expects field name `url`,
      // not `uploadUrl`. Send `url` (and keep `uploadUrl` for backward compat
      // in case the API ever accepts either).
      const attached = await client.request(
        "POST",
        `/transactions/${encodeURIComponent(transactionId)}/receipts`,
        { body: { url: uploadUrl, filename } }
      );
      return ok({ uploadUrl, filename, attached });
    }
  );

  // -- Budgets ---------------------------------------------------------------

  server.registerTool(
    "search_budgets",
    {
      title: "Search budgets",
      description:
        "List budgets. Filterable fields: isBudgetGroup, budgetIds, parentBudgetId, name, retired. Sortable: name, assigned, limit, spent.",
      inputSchema: { ...PaginationShape },
    },
    async (input) => ok(await client.request("GET", "/budgets", { query: buildListQuery(input) }))
  );

  server.registerTool(
    "get_budget",
    {
      title: "Get budget",
      description: "Fetch a single budget by UUID.",
      inputSchema: { budgetId: z.string().describe("Budget UUID.") },
    },
    async ({ budgetId }) =>
      ok(await client.request("GET", `/budgets/${encodeURIComponent(budgetId)}`))
  );

  server.registerTool(
    "create_budget",
    {
      title: "Create budget",
      description:
        "Create a new budget. Required: name, owners (user UUIDs), recurringInterval. Optional knobs include limit/recurringLimit, expirationDate (yyyy-MM-dd), receiptRequired, maxTxSize, carryOver, parentBudgetId, budgetGroup, shareFunds.",
      inputSchema: {
        name: z.string().min(1),
        owners: z.array(z.string()).min(1).describe("User UUIDs of budget owners."),
        recurringInterval: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
        description: z.string().optional(),
        members: z.array(z.string()).optional(),
        observers: z.array(z.string()).optional(),
        expirationDate: z.string().optional().describe("yyyy-MM-dd"),
        recurMonth: z.number().int().min(1).max(12).optional(),
        timezone: z.string().optional().describe('Format "US/{zone}".'),
        autoAddUsers: z.boolean().optional(),
        receiptRequired: z.boolean().optional(),
        maxTxSize: z.number().optional(),
        carryOver: z.boolean().optional(),
        parentBudgetId: z.string().optional(),
        budgetGroup: z.boolean().optional(),
        limitlessOverspend: z.boolean().optional(),
        limit: z.number().optional(),
        recurringLimit: z.number().optional(),
        limitlessGoal: z.number().optional(),
        overspendBuffer: z.number().optional(),
        shareFunds: z.enum(["DO_NOT_SHARE", "SHARE_MANUALLY"]).optional(),
      },
    },
    async (body) => ok(await client.request("POST", "/budgets", { body }))
  );

  // -- Cards -----------------------------------------------------------------

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description:
        "List cards. Filterable: status, budgetIds, cardIds, userIds, types. Sortable: name, lastFour, status.",
      inputSchema: { ...PaginationShape },
    },
    async (input) => ok(await client.request("GET", "/cards", { query: buildListQuery(input) }))
  );

  server.registerTool(
    "get_card",
    {
      title: "Get card",
      description: "Fetch a single card by UUID.",
      inputSchema: { cardId: z.string().describe("Card UUID.") },
    },
    async ({ cardId }) => ok(await client.request("GET", `/cards/${encodeURIComponent(cardId)}`))
  );

  server.registerTool(
    "create_virtual_card",
    {
      title: "Create virtual card",
      description:
        "Issue a new virtual card. Required: name, userUuid, budgetUuid. Either set a `limit` or set `shareBudgetFunds: true` to share full budget funds.",
      inputSchema: {
        name: z.string().min(1),
        userUuid: z.string().describe("User UUID who will hold the card."),
        budgetUuid: z.string().describe("Budget UUID to fund the card."),
        limit: z.number().optional().describe("Spend limit assigned to the card."),
        shareBudgetFunds: z
          .boolean()
          .optional()
          .describe("Share all budget funds with the card instead of a fixed limit."),
      },
    },
    async (body) => ok(await client.request("POST", "/cards", { body }))
  );

  server.registerTool(
    "freeze_card",
    {
      title: "Freeze card",
      description: "Freeze a card so it can no longer be used for new transactions.",
      inputSchema: { cardId: z.string().describe("Card UUID.") },
    },
    async ({ cardId }) =>
      ok(await client.request("POST", `/cards/${encodeURIComponent(cardId)}/freeze`))
  );

  server.registerTool(
    "unfreeze_card",
    {
      title: "Unfreeze card",
      description: "Unfreeze a previously frozen card.",
      inputSchema: { cardId: z.string().describe("Card UUID.") },
    },
    async ({ cardId }) =>
      ok(await client.request("POST", `/cards/${encodeURIComponent(cardId)}/unfreeze`))
  );

  // -- Reimbursements --------------------------------------------------------

  server.registerTool(
    "search_reimbursements",
    {
      title: "Search reimbursements",
      description:
        "List reimbursement requests. Filterable: reimbursementIds, budgetIds, userIds, customFieldValueIds, type (PURCHASE/MILEAGE), submittedTime, retired.",
      inputSchema: { ...PaginationShape },
    },
    async (input) =>
      ok(await client.request("GET", "/reimbursements", { query: buildListQuery(input) }))
  );

  server.registerTool(
    "get_reimbursement",
    {
      title: "Get reimbursement",
      description: "Fetch a single reimbursement by UUID.",
      inputSchema: { reimbursementId: z.string().describe("Reimbursement UUID.") },
    },
    async ({ reimbursementId }) =>
      ok(await client.request("GET", `/reimbursements/${encodeURIComponent(reimbursementId)}`))
  );

  server.registerTool(
    "create_reimbursement",
    {
      title: "Create reimbursement",
      description:
        "Submit a reimbursement request. Optionally pass `receiptFilePaths` to upload local files first; they are attached to the request automatically. Otherwise pass `receipts` directly with already-uploaded URLs.",
      inputSchema: {
        budgetUuid: z.string(),
        userUuid: z.string(),
        amount: z.number(),
        merchantName: z.string(),
        occurredDate: z.string().describe("yyyy-MM-dd"),
        note: z.string(),
        type: z.enum(["PURCHASE", "MILEAGE"]).optional(),
        receipts: z
          .array(z.object({ url: z.string(), filename: z.string() }))
          .optional()
          .describe("Pre-uploaded receipt URLs."),
        receiptFilePaths: z
          .array(z.string())
          .optional()
          .describe("Local file paths to upload as receipts before creating the reimbursement."),
      },
    },
    async ({ receiptFilePaths, receipts, ...rest }) => {
      const uploaded = receipts ? [...receipts] : [];
      if (receiptFilePaths?.length) {
        for (const path of receiptFilePaths) {
          const { uploadUrl, filename } = await client.uploadReceiptFile(path);
          uploaded.push({ url: uploadUrl, filename });
        }
      }
      const body = { ...rest, receipts: uploaded.length ? uploaded : undefined };
      return ok(await client.request("POST", "/reimbursements", { body }));
    }
  );

  server.registerTool(
    "approve_reimbursement",
    {
      title: "Approve reimbursement",
      description: "Approve a pending reimbursement request.",
      inputSchema: {
        reimbursementId: z.string().describe("Reimbursement UUID."),
        note: z.string().optional().describe("Optional approval note."),
      },
    },
    async ({ reimbursementId, note }) =>
      ok(
        await client.request(
          "POST",
          `/reimbursements/${encodeURIComponent(reimbursementId)}/action`,
          { body: { action: "APPROVE", note } }
        )
      )
  );

  server.registerTool(
    "deny_reimbursement",
    {
      title: "Deny reimbursement",
      description: "Deny a pending reimbursement request.",
      inputSchema: {
        reimbursementId: z.string().describe("Reimbursement UUID."),
        note: z.string().optional().describe("Optional denial reason."),
      },
    },
    async ({ reimbursementId, note }) =>
      ok(
        await client.request(
          "POST",
          `/reimbursements/${encodeURIComponent(reimbursementId)}/action`,
          { body: { action: "DENY", note } }
        )
      )
  );
}
