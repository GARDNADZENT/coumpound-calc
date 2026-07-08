/**
 * Deriv API client — new platform (home.deriv.com)
 *
 * Auth flow:
 *   1. REST  GET  /trading/v1/options/accounts           → list accounts
 *   2. REST  POST /trading/v1/options/accounts/{id}/otp  → get WS URL
 *   3. WS    connect to that URL (OTP embedded)
 *   4. WS    subscribe balance, profit_table, transactions (same protocol)
 *
 * Docs: https://developers.deriv.com/docs/intro/api-overview/
 */

const REST_BASE = 'https://api.derivws.com';

type MessageHandler = (data: DerivMessage) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DerivMessage = Record<string, any>;

// ─── Public types ────────────────────────────────────────────────────────────

export interface OptionsAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  currency: string;
  balance?: number;
  is_disabled?: boolean;
  // The API may also return 'id' depending on version — we normalise below.
  id?: string;
}

export interface DerivAccountInfo {
  loginid: string;     // account_id
  currency: string;
  is_virtual: boolean; // true for demo
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

async function restGet<T>(
  path: string,
  patToken: string,
  appId: string,
): Promise<T> {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${patToken}`,
      'Deriv-App-ID': appId,
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errors = (json.errors as Array<{ message: string }> | undefined) ?? [];
    const msg = errors[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

async function restPost<T>(
  path: string,
  patToken: string,
  appId: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${patToken}`,
      'Deriv-App-ID': appId,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errors = (json.errors as Array<{ message: string }> | undefined) ?? [];
    const msg = errors[0]?.message ?? `HTTP ${res.status}`;
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

  // ── REST: list all Options accounts ────────────────────────────────────────

  async getAccounts(
    patToken: string,
    appId: string,
  ): Promise<OptionsAccount[]> {
    const res = await restGet<{ data: OptionsAccount[] }>(
      '/trading/v1/options/accounts',
      patToken,
      appId,
    );
    // Normalise: some API versions may return 'id' instead of 'account_id'.
    return (res.data ?? []).map((a) => ({
      ...a,
      account_id: a.account_id ?? (a.id as string),
    }));
  }

  // ── REST: get a short-lived OTP WebSocket URL ────────────────────────────

  async getOTPWebSocketUrl(
    patToken: string,
    appId: string,
    accountId: string,
  ): Promise<string> {
    const res = await restPost<{ data: { url: string } }>(
      `/trading/v1/options/accounts/${accountId}/otp`,
      patToken,
      appId,
    );
    return res.data.url;
  }

  // ── WebSocket: connect using the OTP URL ────────────────────────────────

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setStatus('authorized'); // authenticated by OTP — skip old authorize step
        resolve();
      };

      this.ws.onerror = () => {
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error('Connection closed'));
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

  // ── WebSocket: balance ───────────────────────────────────────────────────

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

  // ── WebSocket: transactions ──────────────────────────────────────────────

  subscribeTransactions(handler: (tx: DerivTransaction) => void): void {
    this.addSubscriptionHandler('transaction', (msg) => {
      if (msg.transaction) handler(msg.transaction as DerivTransaction);
    });
    this.send({ transaction: 1, subscribe: 1 }).catch(() => {/* ignore */});
  }

  // ── WebSocket: profit table ──────────────────────────────────────────────

  async getProfitTable(limit = 50): Promise<DerivTrade[]> {
    const res = await this.send({
      profit_table: 1,
      description: 1,
      limit,
      sort: 'DESC',
    });
    return ((res.profit_table?.transactions as DerivTrade[]) ?? []);
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

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
