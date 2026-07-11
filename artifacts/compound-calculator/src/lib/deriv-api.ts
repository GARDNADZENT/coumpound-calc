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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Token is provided lazily so it can be re-fetched (refreshed) on reconnect.
  private getToken: (() => Promise<string>) | null = null;
  private appId = '';

  setAuth(getToken: () => Promise<string>, appId: string) {
    this.getToken = getToken;
    this.appId = appId;
  }

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

  async getAccounts(): Promise<OptionsAccount[]> {
    if (!this.getToken) throw new Error('Not authenticated');
    const token = await this.getToken();
    const res = await restRequest<{ data: OptionsAccount[] }>(
      'GET',
      '/trading/v1/options/accounts',
      token,
      this.appId,
    );
    return res.data ?? [];
  }

  // ── REST: get a short-lived OTP WebSocket URL ────────────────────────────────

  async getOTPWebSocketUrl(accountId: string): Promise<string> {
    if (!this.getToken) throw new Error('Not authenticated');
    const token = await this.getToken();
    const res = await restRequest<{ data: { url: string } }>(
      'POST',
      `/trading/v1/options/accounts/${accountId}/otp`,
      token,
      this.appId,
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
        this.startHeartbeat();
        resolve();
      };

      this.ws.onerror = () => {
        // no detail here; onclose carries the code/reason
      };

      this.ws.onclose = (ev) => {
        this.stopHeartbeat();
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

  async getProfitTable(): Promise<DerivTrade[]> {
    const res = await this.send({
      profit_table: 1,
      description: 1,
      sort: 'DESC',
    });
    const raw = (res.profit_table?.transactions as Array<Record<string, unknown>>) ?? [];
    return raw.map(normalizeTrade);
  }

  // ── Teardown ───────────────────────────────────────────────────────────────────

  private startHeartbeat() {
    this.stopHeartbeat();
    // Send a ping every 20s to keep the connection alive and detect dead sockets.
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ ping: 1 }));
        } catch {
          // ignore — onclose will trigger reconnect
        }
      }
    }, 20_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.stopHeartbeat();
    for (const [, p] of this.pendingRequests) {
      p.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.subscriptionHandlers.clear();
    try {
      if (this.ws) this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

// ─── Trade normalizer ─────────────────────────────────────────────────────────
// The Deriv profit_table API sends numeric fields as strings or may leave
// `profit` unset/null. We parse everything as numbers and derive profit from
// buy/sell prices when it's missing.

function asNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeTrade(raw: Record<string, unknown>): DerivTrade {
  const buyPrice = asNum(raw.buy_price);
  const sellPriceRaw = raw.sell_price;
  const sellPrice = sellPriceRaw != null ? asNum(sellPriceRaw) : NaN;
  const profitFromApi = asNum(raw.profit, NaN);
  const profit =
    Number.isFinite(profitFromApi) && profitFromApi !== 0
      ? profitFromApi
      : Number.isFinite(sellPrice)
        ? sellPrice - buyPrice
        : 0;

  return {
    transaction_id: asNum(raw.transaction_id),
    contract_id: asNum(raw.contract_id),
    buy_price: buyPrice,
    sell_price: Number.isFinite(sellPrice) ? sellPrice : null,
    profit,
    profit_percentage: asNum(raw.profit_percentage),
    contract_type: String(raw.contract_type ?? ''),
    shortcode: String(raw.shortcode ?? ''),
    duration_type: String(raw.duration_type ?? ''),
    purchase_time: asNum(raw.purchase_time),
    sell_time: raw.sell_time != null ? asNum(raw.sell_time) : null,
    app_id: asNum(raw.app_id),
    underlying_symbol: String(raw.underlying_symbol ?? ''),
    payout: asNum(raw.payout),
    is_sold: asNum(raw.is_sold),
  };
}
