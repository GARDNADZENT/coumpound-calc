import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DerivAPIClient,
  DerivAccountInfo,
  DerivTrade,
  DerivTransaction,
  ConnectionStatus,
} from '@/lib/deriv-api';

const TOKEN_STORAGE_KEY = 'deriv_api_token';

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
  balance: number | null;
  currency: string;
  recentTrades: DerivTrade[];
  recentTransactions: DerivTransaction[];
  todayPnL: TodayPnL;
  savedToken: string | null;
}

export function useDerivAccount() {
  const clientRef = useRef<DerivAPIClient | null>(null);

  const [state, setState] = useState<DerivAccountState>({
    status: 'disconnected',
    error: null,
    accountInfo: null,
    balance: null,
    currency: 'USD',
    recentTrades: [],
    recentTransactions: [],
    todayPnL: { totalProfit: 0, tradesCount: 0, wins: 0, losses: 0 },
    savedToken: typeof window !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) : null,
  });

  const computeTodayPnL = (trades: DerivTrade[]): TodayPnL => {
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
  };

  const connect = useCallback(async (token: string) => {
    // Clean up any existing connection
    clientRef.current?.disconnect();

    const client = new DerivAPIClient();
    clientRef.current = client;

    client.onStatusChange((status) => {
      setState((prev) => ({ ...prev, status, error: status === 'error' ? 'Connection failed' : prev.error }));
    });

    setState((prev) => ({ ...prev, error: null }));

    try {
      await client.connect();
      const accountInfo = await client.authorize(token);

      // Save token after successful auth
      localStorage.setItem(TOKEN_STORAGE_KEY, token);

      // Get initial balance
      const balanceData = await client.getBalance();

      // Get recent trades (profit table)
      let recentTrades: DerivTrade[] = [];
      try {
        recentTrades = await client.getProfitTable(100);
      } catch {
        // profit table may not be available on virtual accounts
      }

      const todayPnL = computeTodayPnL(recentTrades);

      setState((prev) => ({
        ...prev,
        accountInfo,
        balance: balanceData.balance,
        currency: balanceData.currency,
        recentTrades,
        todayPnL,
        savedToken: token,
        error: null,
      }));

      // Subscribe to live balance updates
      client.subscribeBalance((bal) => {
        setState((prev) => ({
          ...prev,
          balance: bal.balance,
          currency: bal.currency,
        }));
      });

      // Subscribe to live transactions
      client.subscribeTransactions((tx) => {
        setState((prev) => {
          const updated = [tx, ...prev.recentTransactions].slice(0, 100);
          return { ...prev, recentTransactions: updated };
        });

        // Refresh profit table to get updated trade data
        client.getProfitTable(100).then((trades) => {
          setState((prev) => ({
            ...prev,
            recentTrades: trades,
            todayPnL: computeTodayPnL(trades),
          }));
        }).catch(() => {/* ignore */});
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setState((prev) => ({ ...prev, status: 'error', error: msg }));
    }
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setState({
      status: 'disconnected',
      error: null,
      accountInfo: null,
      balance: null,
      currency: 'USD',
      recentTrades: [],
      recentTransactions: [],
      todayPnL: { totalProfit: 0, tradesCount: 0, wins: 0, losses: 0 },
      savedToken: null,
    });
  }, []);

  const clearSavedToken = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setState((prev) => ({ ...prev, savedToken: null }));
  }, []);

  // Reconnect with saved token on mount
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (saved) {
      connect(saved);
    }
    return () => {
      clientRef.current?.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    clearSavedToken,
  };
}
