/**
 * Deriv API client — Options trading platform (api.derivws.com)
 *
 * Confirmed against official docs (developers.deriv.com):
 *   1. REST  GET  /trading/v1/options/accounts           → list accounts
 *              headers: Deriv-App-ID, Authorization: Bearer <PAT>
 *   2. REST  POST /trading/v1/options/accounts/{id}/otp  → { data: { url } }
 *              url = wss://api.derivws.com/trading/v1/options/ws/{demo|real}?otp=...
 *   3. WS    connect directly to that url — OTP embedded, no further auth needed
 *   4. WS    message protocol: balance, portfolio, profit_table, statement, transaction
 *
 * Docs: https://developers.deriv.com/docs/intro/api-overview/
 */

const REST_BASE = 'https://api.derivws.com';

type MessageHandler = (data: DerivMessage) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DerivMessage = Record<string, any>;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OptionsAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  currency: string;
  balance: number;
  group: string;
  status: 'active' | 'inactive';
}

export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  is_virtual: boolean;
  account_type: 'demo' | 'real';
}

export interface DerivBalance {
  balance: number;
  currency: string;
  loginid?: string;
}

export interface DerivTrade {
  transaction_id: number;
  contract_id: number;
  buy_price: number;
  sell_price: number | null;
  profit: number;
  profit_percentage: number;
  contract_type: string;
  shortcode: string;
  duration_type: string;
  purchase_time: number;
  sell_time: number | null;
  app_id: number;
  underlying_symbol: string;
  payout: number;
  is_sold: number;
}

export interface DerivTransaction {
  action: string;
  amount: number;
  balance: number;
  contract_id: number | null;
  currency: string;
  id: string;
  longcode: string;
  purchase_time: number | null;
  symbol: string | null;
  transaction_id: number;
  transaction_time: number;
  reference_id: number | null;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'authorized' | 'error';

// ─── REST helpers ─────────────────────────────────────────────────────────────

async function restRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  patToken: string,
  appId: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${REST_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${patToken}`,
        'Deriv-App-ID': appId,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    throw new Error(`Could not reach Deriv API (${REST_BASE}${path}). Check your network connection.`);
  }

  let json: Record<string, unknown>;
  try {
    json = await res.json() as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected response from Deriv API (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    // Try the documented { errors: [{ message }] } shape first, then fall back to
    // other common API error envelopes so failures are never a bare "HTTP 401".
    const errors = json.errors as Array<{ message?: string; code?: string }> | undefined;
    const msg =
      errors?.[0]?.message ??
      (json.message as string | undefined) ??
      (json.error as string | undefined) ??
      (typeof json.error === 'object' ? (json.error as { message?: string })?.message : undefined) ??
      `HTTP ${res.status} ${res.statusText || ''}`.trim();
    throw new Error(msg);
  }
  return json as T;
}

// ─── Client class ─────────────────────────────────────────────────────────────

export class DerivAPIClient {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: DerivMessage) => void; reject: (e: Error) => void }
  >();
  private subscriptionHandlers = new Map<string, MessageHandler[]>();
  private statusHandler: ((status: ConnectionStatus) => void) | null = null;

  private get nextReqId() {
    return ++this.reqId;
  }

  onStatusChange(handler: (status: ConnectionStatus) => void) {
    this.statusHandler = handler;
  }

  private setStatus(status: ConnectionStatus) {
    this.statusHandler?.(status);
  }

  // ── REST: list all Options accounts ─────────────────────────────────────────

  async getAccounts(patToken: string, appId: string): Promise<OptionsAccount[]> {
    const res = await restRequest<{ data: OptionsAccount[] }>(
      'GET',
      '/trading/v1/options/accounts',
      patToken,
      appId,
    );
    return res.data ?? [];
  }

  // ── REST: get a short-lived OTP WebSocket URL ────────────────────────────────

  async getOTPWebSocketUrl(patToken: string, appId: string, accountId: string): Promise<string> {
    const res = await restRequest<{ data: { url: string } }>(
      'POST',
      `/trading/v1/options/accounts/${accountId}/otp`,
      patToken,
      appId,
    );
    return res.data.url;
  }

  // ── WebSocket: connect using the OTP URL (already authenticated) ────────────

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');
      this.ws = new WebSocket(wsUrl);

      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };

      this.ws.onopen = () => {
        settled = true;
        this.setStatus('authorized'); // OTP already authenticates — no separate authorize step
        resolve();
      };

      this.ws.onerror = () => {
        // no detail here; onclose carries the code/reason
      };

      this.ws.onclose = (ev) => {
        this.setStatus('disconnected');
        const detail = ev.reason
          ? `${ev.reason} (code ${ev.code})`
          : ev.code
          ? `close code ${ev.code}`
          : 'connection refused';
        fail(`WebSocket connection failed: ${detail}. The OTP may have expired — try connecting again.`);
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error(`Connection closed: ${detail}`));
        }
        this.pendingRequests.clear();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: DerivMessage = JSON.parse(event.data as string);
          const reqId = msg.req_id as number | undefined;

          if (reqId && this.pendingRequests.has(reqId)) {
            const pending = this.pendingRequests.get(reqId)!;
            this.pendingRequests.delete(reqId);
            if (msg.error) {
              pending.reject(new Error(msg.error.message as string));
            } else {
              pending.resolve(msg);
            }
          }

          const msgType = msg.msg_type as string | undefined;
          if (msgType && this.subscriptionHandlers.has(msgType)) {
            for (const h of this.subscriptionHandlers.get(msgType)!) {
              h(msg);
            }
          }
        } catch {
          // ignore parse errors
        }
      };
    });
  }

  private send(payload: DerivMessage): Promise<DerivMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = this.nextReqId;
      payload.req_id = id;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  private addSubscriptionHandler(msgType: string, handler: MessageHandler) {
    if (!this.subscriptionHandlers.has(msgType)) {
      this.subscriptionHandlers.set(msgType, []);
    }
    this.subscriptionHandlers.get(msgType)!.push(handler);
  }

  // ── WebSocket: balance ───────────────────────────────────────────────────────

  async getBalance(): Promise<DerivBalance> {
    const res = await this.send({ balance: 1 });
    return res.balance as DerivBalance;
  }

  subscribeBalance(handler: (balance: DerivBalance) => void): void {
    this.addSubscriptionHandler('balance', (msg) => {
      if (msg.balance) handler(msg.balance as DerivBalance);
    });
    this.send({ balance: 1, subscribe: 1 }).catch(() => {/* ignore */});
  }

  // ── WebSocket: transactions ───────────────────────────────────────────────────

  subscribeTransactions(handler: (tx: DerivTransaction) => void): void {
    this.addSubscriptionHandler('transaction', (msg) => {
      if (msg.transaction) handler(msg.transaction as DerivTransaction);
    });
    this.send({ transaction: 1, subscribe: 1 }).catch(() => {/* ignore */});
  }

  // ── WebSocket: profit table ────────────────────────────────────────────────────

  async getProfitTable(limit = 50): Promise<DerivTrade[]> {
    const res = await this.send({
      profit_table: 1,
      description: 1,
      limit,
      sort: 'DESC',
    });
    return ((res.profit_table?.transactions as DerivTrade[]) ?? []);
  }

  // ── Teardown ───────────────────────────────────────────────────────────────────

  disconnect() {
    for (const [, p] of this.pendingRequests) {
      p.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.subscriptionHandlers.clear();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
