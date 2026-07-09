import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

export interface Deposit {
  id: string;
  day: number;
  amount: number;
}

export interface DayData {
  day: number;
  date: Date;
  deposit: number;
  startBalance: number;
  dollarProfitTarget: number;
  requiredPct: number;
  endBalance: number;
  isLiveBalance: boolean;
}

export interface CalculatorState {
  initialBalance: number;
  tradingDays: number;
  baseRate: number; // e.g. 20 for 20%
  currentDay: number;
  deposits: Deposit[];
  startDate: Date;
}

export interface LiveBalanceOverride {
  day: number;
  balance: number;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Which cycle day corresponds to "today", given a fixed cycle start date. */
export function computeAutoDay(startDate: Date, tradingDays: number): number {
  const today = startOfDay(new Date());
  const start = startOfDay(startDate);
  const diffDays = Math.round((today.getTime() - start.getTime()) / 86_400_000);
  return Math.max(1, Math.min(tradingDays, diffDays + 1));
}

const DEFAULT_START_DATE = new Date(2026, 6, 1); // July 1, 2026

export function useCalculator(
  initialState?: Partial<CalculatorState>,
  /** Live Deriv account balance, if connected. Automatically rebase today's
   *  actual starting balance onto this real figure instead of the theoretical
   *  compounding chain, so the schedule reflects real progress. */
  liveBalance?: number | null,
) {
  const [state, setState] = useState<CalculatorState>(() => {
    const startDate = initialState?.startDate ?? DEFAULT_START_DATE;
    const tradingDays = Math.max(1, Math.min(365, initialState?.tradingDays ?? 30));
    return {
      initialBalance: initialState?.initialBalance ?? 2,
      tradingDays,
      baseRate: initialState?.baseRate ?? 20,
      currentDay: initialState?.currentDay ?? computeAutoDay(startDate, tradingDays),
      deposits: initialState?.deposits ?? [],
      startDate,
    };
  });

  // Track whether the user is following "today" automatically, or has manually
  // pinned the viewer to a different day in the schedule.
  const lastAutoDay = useRef(computeAutoDay(state.startDate, state.tradingDays));
  const followingToday = useRef(true);

  const updateState = (updates: Partial<CalculatorState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates };
      // Clamp tradingDays to a safe range
      next.tradingDays = Math.max(1, Math.min(365, next.tradingDays));
      // Keep currentDay within the new tradingDays bound
      next.currentDay = Math.max(1, Math.min(next.tradingDays, next.currentDay));
      // Remove deposits that fall outside the new tradingDays range
      next.deposits = next.deposits.filter((d) => d.day >= 1 && d.day <= next.tradingDays);

      // A manual currentDay edit stops auto-follow — unless the value the user
      // typed happens to equal today's real day, in which case follow stays on.
      // This keeps the "Auto" badge/jump-button visibility consistent with
      // whether midnight rollover will actually keep advancing the day.
      if ('currentDay' in updates) {
        const todaysDay = computeAutoDay(next.startDate, next.tradingDays);
        followingToday.current = next.currentDay === todaysDay;
        lastAutoDay.current = todaysDay;
      }

      return next;
    });
  };

  const jumpToToday = () => {
    const day = computeAutoDay(state.startDate, state.tradingDays);
    followingToday.current = true;
    lastAutoDay.current = day;
    setState((prev) => ({ ...prev, currentDay: day }));
  };

  // Auto-follow real calendar day: re-check periodically (covers a tab left open
  // across midnight) and whenever the cycle length/start date changes.
  useEffect(() => {
    const sync = () => {
      const day = computeAutoDay(state.startDate, state.tradingDays);
      if (day !== lastAutoDay.current) {
        lastAutoDay.current = day;
        if (followingToday.current) {
          setState((prev) => ({ ...prev, currentDay: day }));
        }
      }
    };
    sync();
    const interval = setInterval(sync, 60_000);
    return () => clearInterval(interval);
  }, [state.startDate, state.tradingDays]);

  const addDeposit = (day: number, amount: number) => {
    const newDeposit: Deposit = {
      id: Math.random().toString(36).substring(7),
      day,
      amount,
    };
    setState((prev) => ({
      ...prev,
      deposits: [...prev.deposits, newDeposit].sort((a, b) => a.day - b.day),
    }));
  };

  const removeDeposit = (id: string) => {
    setState((prev) => ({
      ...prev,
      deposits: prev.deposits.filter((d) => d.id !== id),
    }));
  };

  const autoCurrentDay = useMemo(
    () => computeAutoDay(state.startDate, state.tradingDays),
    [state.startDate, state.tradingDays],
  );

  const liveBalanceOverride: LiveBalanceOverride | null = useMemo(
    () => (liveBalance != null ? { day: autoCurrentDay, balance: liveBalance } : null),
    [liveBalance, autoCurrentDay],
  );

  const schedule = useMemo(() => {
    const { initialBalance, tradingDays, baseRate, deposits, startDate } = state;
    const rateDecimal = baseRate / 100;

    // Group deposits by day for easy lookup
    const depositsByDay = deposits.reduce((acc, dep) => {
      acc[dep.day] = (acc[dep.day] || 0) + dep.amount;
      return acc;
    }, {} as Record<number, number>);

    const scheduleData: DayData[] = [];
    const cycleStart = startOfDay(startDate);

    let actualEndPrev = 0;

    for (let i = 1; i <= tradingDays; i++) {
      // 1. Calculate original target (the ideal compounding curve)
      const originalStart = initialBalance * Math.pow(1 + rateDecimal, i - 1);
      const originalDollarProfit = originalStart * rateDecimal;

      // 2. Calculate actuals
      const depositToday = depositsByDay[i] || 0;

      let actualStart;
      if (i === 1) {
        actualStart = initialBalance + depositToday;
      } else {
        actualStart = actualEndPrev + depositToday;
      }

      // Rebase today's actual starting point on the live Deriv balance, so the
      // rest of the schedule reflects real progress instead of the theoretical
      // curve. Past days are left as originally projected (no historical feed).
      // A deposit logged for today is treated as planned/not-yet-reflected in
      // the live account, so it's added on top rather than discarded.
      let isLiveBalance = false;
      if (liveBalanceOverride && liveBalanceOverride.day === i) {
        actualStart = liveBalanceOverride.balance + depositToday;
        isLiveBalance = true;
      }

      const requiredPct = actualStart > 0 ? (originalDollarProfit / actualStart) * 100 : 0;
      const actualEnd = actualStart + originalDollarProfit;

      const currentDayDate = new Date(cycleStart);
      currentDayDate.setDate(cycleStart.getDate() + (i - 1));

      scheduleData.push({
        day: i,
        date: currentDayDate,
        deposit: depositToday,
        startBalance: actualStart,
        dollarProfitTarget: originalDollarProfit,
        requiredPct,
        endBalance: actualEnd,
        isLiveBalance,
      });

      actualEndPrev = actualEnd;
    }

    return scheduleData;
  }, [
    state.initialBalance,
    state.tradingDays,
    state.baseRate,
    state.deposits,
    state.startDate,
    liveBalanceOverride?.day,
    liveBalanceOverride?.balance,
  ]);

  const currentDayData = useMemo(() => {
    return schedule.find((d) => d.day === state.currentDay) || schedule[0];
  }, [schedule, state.currentDay]);

  const finalTarget = schedule.length > 0 ? schedule[schedule.length - 1].endBalance : 0;

  const exportToExcel = () => {
    const exportData = schedule.map((row) => ({
      Day: row.day,
      Date: row.date.toLocaleDateString(),
      'Start Balance': Number(row.startBalance.toFixed(2)),
      'Deposit': Number(row.deposit.toFixed(2)),
      'Dollar Profit Target': Number(row.dollarProfitTarget.toFixed(2)),
      'Required %': row.requiredPct / 100, // numeric fraction for Excel percent formatting
      'End Balance': Number(row.endBalance.toFixed(2)),
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Compound Schedule');

    // Apply percent number format to the Required % column (column F, index 5)
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const pctColIdx = 5; // 0-based: Day=0, Date=1, StartBal=2, Deposit=3, Profit=4, Req%=5, End=6
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c: pctColIdx });
      if (worksheet[cellAddr]) {
        worksheet[cellAddr].z = '0.00%';
      }
    }

    // Adjust column widths
    const cols = [
      { wch: 5 },  // Day
      { wch: 12 }, // Date
      { wch: 15 }, // Start Balance
      { wch: 15 }, // Deposit
      { wch: 20 }, // Dollar Profit
      { wch: 12 }, // Required %
      { wch: 15 }, // End Balance
    ];
    worksheet['!cols'] = cols;

    const fileName = `compound-schedule-${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  return {
    state,
    updateState,
    addDeposit,
    removeDeposit,
    schedule,
    currentDayData,
    finalTarget,
    exportToExcel,
    autoCurrentDay,
    isOnToday: state.currentDay === autoCurrentDay,
    jumpToToday,
  };
}
