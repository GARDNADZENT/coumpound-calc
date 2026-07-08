/**
 * Deriv API client — WebSocket API (ws.derivws.com)
 *
 * Auth flow:
 *   1. Connect to wss://ws.derivws.com/websockets/v3?app_id={appId}
 *   2. Send { authorize: patToken }  → receive account info
 *   3. Subscribe balance, transactions; query profit_table
 *
 * Docs: https://api.deriv.com/
 */

const WS_BASE = 'wss://ws.derivws.com/websockets/v3';

type MessageHandler = (data: DerivMessage) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DerivMessage = Record<string, any>;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OptionsAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  currency: string;
  balance?: number;
  is_disabled?: boolean;
}

export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  is_virtual: boolean;
  account_type: 'demo' | 'real';
  fullname?: string;
  email?: string;
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

  // ── Connect + Authorize ─────────────────────────────────────────────────────

  connect(appId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');

      const url = `${WS_BASE}?app_id=${encodeURIComponent(appId)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onerror = () => {
        reject(new Error('WebSocket connection failed. Check your App ID is correct.'));
      };

      this.ws.onclose = (ev) => {
        this.setStatus('disconnected');
        const closeMsg = ev.reason ? ` (${ev.reason})` : '';
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error(`Connection closed${closeMsg}`));
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

  async authorize(token: string): Promise<DerivMessage> {
    const res = await this.send({ authorize: token });
    if (res.error) throw new Error(res.error.message as string);
    this.setStatus('authorized');
    return res.authorize as DerivMessage;
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

  // ── Balance ──────────────────────────────────────────────────────────────────

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

  // ── Transactions ─────────────────────────────────────────────────────────────

  subscribeTransactions(handler: (tx: DerivTransaction) => void): void {
    this.addSubscriptionHandler('transaction', (msg) => {
      if (msg.transaction) handler(msg.transaction as DerivTransaction);
    });
    this.send({ transaction: 1, subscribe: 1 }).catch(() => {/* ignore */});
  }

  // ── Profit table ─────────────────────────────────────────────────────────────

  async getProfitTable(limit = 50): Promise<DerivTrade[]> {
    const res = await this.send({
      profit_table: 1,
      description: 1,
      limit,
      sort: 'DESC',
    });
    return ((res.profit_table?.transactions as DerivTrade[]) ?? []);
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

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
