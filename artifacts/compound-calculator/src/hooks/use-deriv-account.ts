import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DerivAPIClient,
  DerivAccountInfo,
  DerivTrade,
  DerivTransaction,
  ConnectionStatus,
  OptionsAccount,
} from '@/lib/deriv-api';

export interface TodayPnL {
  totalProfit: number;
  tradesCount: number;
  wins: number;
  losses: number;
}

export interface DailyPnL {
  /** Calendar date string (YYYY-MM-DD) → net profit for that day. */
  [date: string]: number;
}

export interface AuthConfig {
  app_id: string | null;
  redirect_uri: string;
  configured: boolean;
}

export interface DerivAccountState {
  status: ConnectionStatus;
  error: string | null;
  tradeError: string | null;
  accountInfo: DerivAccountInfo | null;
  accounts: OptionsAccount[];
  selectedAccountId: string | null;
  balance: number | null;
  currency: string;
  recentTrades: DerivTrade[];
  recentTransactions: DerivTransaction[];
  todayPnL: TodayPnL;
  tradesByCalendarDate: DailyPnL;
  authenticated: boolean;
  authChecked: boolean;
  config: AuthConfig | null;
  authError: string | null;
}

function computeTodayPnL(trades: DerivTrade[]): TodayPnL {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = Math.floor(todayStart.getTime() / 1000);

  const todayTrades = trades.filter((t) => {
    if (t.sell_time == null || !Number.isFinite(t.sell_time)) return false;
    if (!Number.isFinite(t.profit)) return false;
    return t.sell_time >= todayTs;
  });

  return {
    totalProfit: todayTrades.reduce((sum, t) => sum + t.profit, 0),
    tradesCount: todayTrades.length,
    wins: todayTrades.filter((t) => t.profit > 0).length,
    losses: todayTrades.filter((t) => t.profit <= 0).length,
  };
}

const EMPTY_PNL: TodayPnL = { totalProfit: 0, tradesCount: 0, wins: 0, losses: 0 };

function buildDailyPnL(trades: DerivTrade[]): DailyPnL {
  const map: DailyPnL = {};
  for (const t of trades) {
    if (t.sell_time == null || !Number.isFinite(t.sell_time)) continue;
    if (!Number.isFinite(t.profit)) continue;
    const d = new Date(t.sell_time * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    map[key] = (map[key] || 0) + t.profit;
  }
  return map;
}

const INITIAL_STATE: DerivAccountState = {
  status: 'disconnected',
  error: null,
  tradeError: null,
  accountInfo: null,
  accounts: [],
  selectedAccountId: null,
  balance: null,
  currency: 'USD',
  recentTrades: [],
  recentTransactions: [],
  todayPnL: EMPTY_PNL,
  tradesByCalendarDate: {},
  authenticated: false,
  authChecked: true,
  config: null,
  authError: null,
};

export function useDerivAccount() {
  const clientRef = useRef<DerivAPIClient | null>(null);
  const attemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const configRef = useRef<AuthConfig | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [state, setState] = useState<DerivAccountState>(INITIAL_STATE);
  const loginIdRef = useRef<string | null>(null);

  // Fetch a fresh access token from the backend session (auto-refreshes if expired).
  const fetchToken = useCallback(async (): Promise<{ access_token: string; app_id: string }> => {
    const res = await fetch('/api/auth/token');
    if (!res.ok) {
      throw new Error('Session expired. Please log in again.');
    }
    return res.json();
  }, []);

  const connect = useCallback(
    async (accountId?: string) => {
      const attempt = ++attemptRef.current;
      const current = () => attempt === attemptRef.current;

      intentionalDisconnectRef.current = false;
      reconnectAttemptsRef.current = 0;
      clientRef.current?.disconnect();
      const client = new DerivAPIClient();
      clientRef.current = client;

      client.onStatusChange((status) => {
        if (!current()) return;
        if (status === 'disconnected') {
          setState((prev) =>
            prev.status === 'authorized' || prev.status === 'connected'
              ? { ...prev, status: 'disconnected', error: 'Connection lost. Reconnecting…' }
              : prev,
          );
          // Keep the session alive: auto-reconnect (bounded) unless the user logged out.
          if (!intentionalDisconnectRef.current && reconnectAttemptsRef.current < 5) {
            reconnectAttemptsRef.current += 1;
            setTimeout(() => {
              if (current()) connect(accountId);
            }, 2000 * reconnectAttemptsRef.current);
          }
        }
      });

      setState((prev) => ({ ...prev, error: null, status: 'connecting' }));

      try {
        // Step 1: get a fresh OAuth access token from the backend session.
        const { access_token, app_id } = await fetchToken();
        if (!current()) return;

        client.setAuth(() => fetchToken().then((t) => t.access_token), app_id);

        // Step 2: list accounts via REST.
        const accounts = await client.getAccounts();
        if (!current()) return;

        if (accounts.length === 0) {
          throw new Error('No Options trading accounts found. Log in at home.deriv.com to get your default demo account.');
        }

        const isReal = (a: OptionsAccount) => a.account_type === 'real';
        const realAccounts = accounts.filter(isReal);
        const target =
          (accountId ? accounts.find((a) => a.account_id === accountId) : null) ??
          realAccounts[0] ??
          accounts[0];

        if (!target) {
          throw new Error('No suitable account found.');
        }

        setState((prev) => ({ ...prev, accounts, selectedAccountId: target.account_id }));

        // Step 3: get OTP WebSocket URL via REST (token re-fetched if needed).
        const wsUrl = await client.getOTPWebSocketUrl(target.account_id);
        if (!current()) return;

        // Step 4: connect to WebSocket (OTP already authenticates).
        await client.connect(wsUrl);
        if (!current()) return;

        // Step 5: get initial balance.
        const balanceData = await client.getBalance();
        if (!current()) return;

        let initialTrades: DerivTrade[] = [];
        let initialTradeError: string | null = null;
        try {
          initialTrades = await client.getProfitTable();
        } catch (e: unknown) {
          initialTradeError = e instanceof Error ? e.message : 'Failed to load trades';
        }
        if (!current()) return;

        const fetchTrades = () =>
          client
            .getProfitTable()
            .then((trades) => {
              if (!current()) return;
              setState((prev) => ({
                ...prev,
                recentTrades: trades,
                todayPnL: computeTodayPnL(trades),
                tradesByCalendarDate: buildDailyPnL(trades),
                tradeError: null,
              }));
            })
            .catch((e: unknown) => {
              if (!current()) return;
              const msg = e instanceof Error ? e.message : 'Failed to load trades';
              setState((prev) => ({ ...prev, tradeError: msg }));
            });

        const accountInfo: DerivAccountInfo = {
          loginid: target.account_id,
          currency: target.currency ?? balanceData.currency,
          is_virtual: target.account_type === 'demo',
          account_type: target.account_type,
        };
        loginIdRef.current = target.account_id;
        setState((prev) => ({
          ...prev,
          status: 'authorized',
          accountInfo,
          balance: balanceData.balance,
          currency: balanceData.currency,
          recentTrades: initialTrades,
          todayPnL: computeTodayPnL(initialTrades),
          tradeError: initialTradeError,
          authenticated: true,
          error: null,
        }));

        // Step 7: live subscriptions.
        client.subscribeBalance((bal) => {
          if (!current()) return;
          setState((prev) => ({ ...prev, balance: bal.balance, currency: bal.currency }));
        });

        client.subscribeTransactions((tx) => {
          if (!current()) return;
          setState((prev) => ({
            ...prev,
            recentTransactions: [tx, ...prev.recentTransactions].slice(0, 100),
          }));
          fetchTrades();
        });

        // Poll the profit table every 15s so trades taken on another device
        // (or before this session opened) still sync without a transaction event.
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(() => {
          if (current()) fetchTrades();
        }, 15_000);
      } catch (err) {
        if (!current()) return;
        client.disconnect();
        const msg = err instanceof Error ? err.message : 'Connection failed';
        const loggedOut = /Session expired/i.test(msg);
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: msg,
          authenticated: loggedOut ? false : prev.authenticated,
        }));
      }
    },
    [fetchToken],
  );

  const switchAccount = useCallback(
    (accountId: string) => {
      setState((prev) => {
        if (prev.authenticated) {
          queueMicrotask(() => connect(accountId));
        }
        return prev;
      });
    },
    [connect],
  );

  const logout = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    ++attemptRef.current; // invalidate any in-flight attempt
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    reconnectAttemptsRef.current = 0;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore network errors — local state is cleared regardless
    }
    setState((prev) => ({ ...INITIAL_STATE, authenticated: false, authChecked: true, config: configRef.current }));
  }, []);

  // On mount: load public config + check session, then auto-connect if authenticated.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfgRes = await fetch('/api/auth/config');
        const cfg: AuthConfig = await cfgRes.json();
        if (cancelled) return;
        configRef.current = cfg;
        setState((prev) => ({ ...prev, config: cfg }));

        const meRes = await fetch('/api/auth/me');
        const me = (await meRes.json()) as { authenticated: boolean };
        if (cancelled) return;
        setState((prev) => ({ ...prev, authenticated: me.authenticated, authChecked: true }));
        if (me.authenticated) {
          connect();
        }
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, authChecked: true }));
      }
    })();

    return () => {
      cancelled = true;
      ++attemptRef.current;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      clientRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    connect,
    logout,
    switchAccount,
  };
}
