/**
 * Deriv WebSocket API client
 * Docs: https://api.deriv.com/
 */

const DERIV_WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

type MessageHandler = (data: DerivMessage) => void;

export interface DerivAccountInfo {
  loginid: string;
  email: string;
  fullname: string;
  currency: string;
  balance: number;
  is_virtual: number;
  landing_company_fullname: string;
}

export interface DerivBalance {
  balance: number;
  currency: string;
  loginid: string;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DerivMessage = Record<string, any>;

export class DerivAPIClient {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pendingRequests = new Map<number, { resolve: (v: DerivMessage) => void; reject: (e: Error) => void }>();
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

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');
      this.ws = new WebSocket(DERIV_WS_URL);

      this.ws.onopen = () => {
        this.setStatus('connected');
        resolve();
      };

      this.ws.onerror = () => {
        this.setStatus('error');
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: DerivMessage = JSON.parse(event.data as string);
          const reqId = msg.req_id as number | undefined;

          // Resolve one-shot requests
          if (reqId && this.pendingRequests.has(reqId)) {
            const pending = this.pendingRequests.get(reqId)!;
            this.pendingRequests.delete(reqId);
            if (msg.error) {
              pending.reject(new Error(msg.error.message as string));
            } else {
              pending.resolve(msg);
            }
          }

          // Route subscription messages
          const msgType = msg.msg_type as string | undefined;
          if (msgType && this.subscriptionHandlers.has(msgType)) {
            for (const handler of this.subscriptionHandlers.get(msgType)!) {
              handler(msg);
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

  async authorize(token: string): Promise<DerivAccountInfo> {
    const res = await this.send({ authorize: token });
    if (res.error) throw new Error(res.error.message as string);
    this.setStatus('authorized');
    return res.authorize as DerivAccountInfo;
  }

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

  subscribeTransactions(handler: (tx: DerivTransaction) => void): void {
    this.addSubscriptionHandler('transaction', (msg) => {
      if (msg.transaction) handler(msg.transaction as DerivTransaction);
    });
    this.send({ transaction: 1, subscribe: 1 }).catch(() => {/* ignore */});
  }

  async getProfitTable(limit = 50): Promise<DerivTrade[]> {
    const res = await this.send({
      profit_table: 1,
      description: 1,
      limit,
      sort: 'DESC',
    });
    return ((res.profit_table?.transactions as DerivTrade[]) ?? []);
  }

  async getStatement(limit = 50): Promise<DerivTransaction[]> {
    const res = await this.send({
      statement: 1,
      description: 1,
      limit,
    });
    return ((res.statement?.transactions as DerivTransaction[]) ?? []);
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.pendingRequests.clear();
    this.subscriptionHandlers.clear();
  }
}
