import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DerivAPIClient,
  DerivAccountInfo,
  DerivTrade,
  DerivTransaction,
  ConnectionStatus,
  OptionsAccount,
} from '@/lib/deriv-api';

const PAT_KEY = 'deriv_pat_token';
const APP_ID_KEY = 'deriv_app_id';

export interface TodayPnL {
  totalProfit: number;
  tradesCount: number;
  wins: number;
  losses: number;
}

export interface DerivAccountState {
  status: ConnectionStatus;
  error: string | null;
  accountInfo: DerivAccountInfo | null;
  accounts: OptionsAccount[];
  selectedAccountId: string | null;
  balance: number | null;
  currency: string;
  recentTrades: DerivTrade[];
  recentTransactions: DerivTransaction[];
  todayPnL: TodayPnL;
  savedPat: string | null;
  savedAppId: string | null;
}

function computeTodayPnL(trades: DerivTrade[]): TodayPnL {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;

  const todayTrades = trades.filter(
    (t) => t.is_sold && t.sell_time != null && t.sell_time >= todayTs,
  );

  return {
    totalProfit: todayTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0),
    tradesCount: todayTrades.length,
    wins: todayTrades.filter((t) => (t.profit ?? 0) > 0).length,
    losses: todayTrades.filter((t) => (t.profit ?? 0) <= 0).length,
  };
}

const EMPTY_PNL: TodayPnL = { totalProfit: 0, tradesCount: 0, wins: 0, losses: 0 };

const INITIAL_STATE: DerivAccountState = {
  status: 'disconnected',
  error: null,
  accountInfo: null,
  accounts: [],
  selectedAccountId: null,
  balance: null,
  currency: 'USD',
  recentTrades: [],
  recentTransactions: [],
  todayPnL: EMPTY_PNL,
  savedPat: typeof window !== 'undefined' ? localStorage.getItem(PAT_KEY) : null,
  savedAppId: typeof window !== 'undefined' ? localStorage.getItem(APP_ID_KEY) : null,
};

export function useDerivAccount() {
  const clientRef = useRef<DerivAPIClient | null>(null);
  const attemptRef = useRef(0);

  const [state, setState] = useState<DerivAccountState>(INITIAL_STATE);

  const connect = useCallback(async (patToken: string, appId: string, accountId?: string) => {
    const attempt = ++attemptRef.current;
    const current = () => attempt === attemptRef.current;

    clientRef.current?.disconnect();
    const client = new DerivAPIClient();
    clientRef.current = client;

    // Wire status changes from client (e.g. unexpected socket close) into state
    client.onStatusChange((status) => {
      if (!current()) return;
      if (status === 'disconnected') {
        setState((prev) =>
          prev.status === 'authorized' || prev.status === 'connected'
            ? { ...prev, status: 'disconnected', error: 'Connection lost. Refresh to reconnect.' }
            : prev,
        );
      }
    });

    setState((prev) => ({ ...prev, error: null, status: 'connecting' }));

    try {
      // ── Step 1: list accounts via REST ────────────────────────────────────
      const accounts = await client.getAccounts(patToken, appId);
      if (!current()) return;

      if (accounts.length === 0) {
        throw new Error('No Options trading accounts found for this token. Log in at home.deriv.com to get your default demo account.');
      }

      const activeAccounts = accounts.filter((a) => a.status === 'active');
      if (activeAccounts.length === 0) {
        throw new Error('No active Options trading accounts found for this token.');
      }

      // Explicit account requested (e.g. via switchAccount) — fail if it's missing or inactive.
      if (accountId) {
        const requested = activeAccounts.find((a) => a.account_id === accountId);
        if (!requested) {
          throw new Error(`Account ${accountId} is not available or inactive.`);
        }
      }

      // Pick the requested account, or prefer real → demo among active accounts
      const target =
        (accountId ? activeAccounts.find((a) => a.account_id === accountId) : null) ??
        activeAccounts.find((a) => a.account_type === 'real') ??
        activeAccounts[0];

      setState((prev) => ({ ...prev, accounts, selectedAccountId: target.account_id }));

      // ── Step 2: get OTP WebSocket URL via REST ──────────────────────────────
      const wsUrl = await client.getOTPWebSocketUrl(patToken, appId, target.account_id);
      if (!current()) return;

      // ── Step 3: connect to WebSocket (OTP already authenticates) ────────────
      await client.connect(wsUrl);
      if (!current()) return;

      // Persist credentials after successful connection
      localStorage.setItem(PAT_KEY, patToken);
      localStorage.setItem(APP_ID_KEY, appId);

      // ── Step 4: get initial balance ───────────────────────────────────────────
      const balanceData = await client.getBalance();
      if (!current()) return;

      // ── Step 5: get recent trades ─────────────────────────────────────────────
      let recentTrades: DerivTrade[] = [];
      try {
        recentTrades = await client.getProfitTable(100);
      } catch {
        // profit table may be unavailable on some account types
      }
      if (!current()) return;

      const accountInfo: DerivAccountInfo = {
        loginid: target.account_id,
        currency: target.currency ?? balanceData.currency,
        is_virtual: target.account_type === 'demo',
        account_type: target.account_type,
      };

      setState((prev) => ({
        ...prev,
        status: 'authorized',
        accountInfo,
        balance: balanceData.balance,
        currency: balanceData.currency,
        recentTrades,
        todayPnL: computeTodayPnL(recentTrades),
        savedPat: patToken,
        savedAppId: appId,
        error: null,
      }));

      // ── Step 6: live subscriptions ─────────────────────────────────────────────
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
        // Refresh profit table on each trade close
        client.getProfitTable(100).then((trades) => {
          if (!current()) return;
          setState((prev) => ({
            ...prev,
            recentTrades: trades,
            todayPnL: computeTodayPnL(trades),
          }));
        }).catch(() => {/* ignore */});
      });

    } catch (err) {
      if (!current()) return;
      client.disconnect();
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setState((prev) => ({ ...prev, status: 'error', error: msg }));
    }
  }, []);

  const switchAccount = useCallback((accountId: string) => {
    // Read current credentials from state without causing a state update side-effect.
    setState((prev) => {
      if (prev.savedPat && prev.savedAppId) {
        // Schedule outside the updater to avoid side effects during render/commit.
        queueMicrotask(() => connect(prev.savedPat!, prev.savedAppId!, accountId));
      }
      return prev;
    });
  }, [connect]);

  const disconnect = useCallback(() => {
    ++attemptRef.current; // invalidate any in-flight attempt
    clientRef.current?.disconnect();
    clientRef.current = null;
    localStorage.removeItem(PAT_KEY);
    localStorage.removeItem(APP_ID_KEY);
    setState({ ...INITIAL_STATE, savedPat: null, savedAppId: null });
  }, []);

  const clearSavedCredentials = useCallback(() => {
    localStorage.removeItem(PAT_KEY);
    localStorage.removeItem(APP_ID_KEY);
    setState((prev) => ({ ...prev, savedPat: null, savedAppId: null, error: null }));
  }, []);

  // Auto-reconnect on mount if credentials are saved
  useEffect(() => {
    const pat = localStorage.getItem(PAT_KEY);
    const appId = localStorage.getItem(APP_ID_KEY);
    if (pat && appId) {
      connect(pat, appId);
    }
    return () => {
      ++attemptRef.current;
      clientRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    switchAccount,
    clearSavedCredentials,
  };
}
