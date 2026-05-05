import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const PROD_BASE = "https://gateway.prod.bill.com/connect/v3/spend";
const SANDBOX_BASE = "https://gateway.stage.bill.com/connect/v3/spend";

export class BillSpendClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor() {
    const token = process.env.BILLCOM_SPEND_API_TOKEN;
    if (!token) {
      throw new Error(
        "BILLCOM_SPEND_API_TOKEN is required. Set it in your environment or .env file."
      );
    }
    this.token = token;
    const env = (process.env.BILLCOM_ENVIRONMENT ?? "sandbox").toLowerCase();
    this.baseUrl = env === "production" ? PROD_BASE : SANDBOX_BASE;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apiToken: this.token,
      Accept: "application/json",
      ...extra,
    };
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    const init: RequestInit = {
      method,
      headers: this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Error(`BILL ${method} ${path} failed: ${res.status} ${res.statusText} — ${detail}`);
    }
    return parsed as T;
  }

  async putBinary(uploadUrl: string, filePath: string): Promise<void> {
    const data = await readFile(filePath);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      body: data,
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Receipt PUT to upload URL failed: ${res.status} ${res.statusText} — ${detail}`);
    }
  }

  /**
   * Receipt upload flow:
   *   1. POST /transactions/receipt-upload-url  → { uploadUrl, ... }
   *   2. PUT  uploadUrl  (binary body)
   *   3. caller decides: attach to transaction or include in reimbursement body
   *
   * Returns { uploadUrl, filename } so callers can either attach (transaction)
   * or pass to a reimbursement create payload.
   */
  async uploadReceiptFile(filePath: string): Promise<{ uploadUrl: string; filename: string }> {
    const filename = basename(filePath);
    const presigned = await this.request<{ uploadUrl?: string; upload_url?: string; url?: string }>(
      "POST",
      "/transactions/receipt-upload-url",
      { body: { filename } }
    );
    const uploadUrl = presigned.uploadUrl ?? presigned.upload_url ?? presigned.url;
    if (!uploadUrl) {
      throw new Error(
        `Receipt upload URL not present in response: ${JSON.stringify(presigned)}`
      );
    }
    await this.putBinary(uploadUrl, filePath);
    return { uploadUrl, filename };
  }
}

export function buildListQuery(input: {
  max?: number;
  nextPage?: string;
  prevPage?: string;
  sort?: string;
  filters?: string;
  showCustomFieldIds?: string;
  includeReceipts?: boolean;
}): Record<string, string | number | boolean | undefined> {
  return {
    max: input.max,
    nextPage: input.nextPage,
    prevPage: input.prevPage,
    sort: input.sort,
    filters: input.filters,
    showCustomFieldIds: input.showCustomFieldIds,
    includeReceipts: input.includeReceipts,
  };
}
