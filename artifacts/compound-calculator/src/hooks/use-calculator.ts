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
  expectedStartBalance: number;
  dollarProfitTarget: number;
  requiredPct: number;
  endBalance: number;
  actualStartBalance?: number;
  actualEndBalance?: number;
  totalDeficitAdvantage?: number;
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
  liveBalance?: number | null,
  /** Daily trade P&L grouped by calendar date YYYY-MM-DD, used to reconstruct
   *  actual end-of-day balances from the 1st of the month through today. */
  tradesByCalendarDate?: Record<string, number> | null,
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
      acc[dep.day] = (dep.amount || 0);
      return acc;
    }, {} as Record<number, number>);

    const scheduleData: DayData[] = [];
    const cycleStart = startOfDay(startDate);

    // Reconstruct actual balances from trade P&L history (keyed by date string)
    const dailyPnL = tradesByCalendarDate || {};

    // Build the expected compounding schedule first
    let expectedPrevEnd = initialBalance;
    const expectedStarts: number[] = [];
    const expectedEnds: number[] = [];
    const expectedProfits: number[] = [];

    for (let i = 1; i <= tradingDays; i++) {
      const depositToday = depositsByDay[i] || 0;
      const expectedStart = expectedPrevEnd + depositToday;
      const expectedProfit = expectedStart * rateDecimal;
      const expectedEnd = expectedStart + expectedProfit;

      expectedStarts.push(expectedStart);
      expectedEnds.push(expectedEnd);
      expectedProfits.push(expectedProfit);

      expectedPrevEnd = expectedEnd;
    }

    // Reconstruct actual balance history by walking the trade P&L chain
    let actualBalance = initialBalance;
    const actualEnds: (number | undefined)[] = new Array(tradingDays).fill(undefined);

    for (let i = 0; i < tradingDays; i++) {
      const dayNum = i + 1;
      const depositToday = depositsByDay[dayNum] || 0;
      actualBalance += depositToday;

      const currentDayDate = new Date(cycleStart);
      currentDayDate.setDate(cycleStart.getDate() + i);
      const dateKey = `${currentDayDate.getFullYear()}-${String(currentDayDate.getMonth() + 1).padStart(2, '0')}-${String(currentDayDate.getDate()).padStart(2, '0')}`;
      const dayPnL = dailyPnL[dateKey];

      if (dayPnL != null && Number.isFinite(dayPnL)) {
        actualBalance += dayPnL;
        actualEnds[i] = actualBalance;
      }

      // If no trade data for this day, actual end = undefined (will fall back to expected)
      // unless it's today with live balance override
    }

    // Override today's actual end with live Derive balance if available
    if (liveBalanceOverride) {
      const todayIdx = liveBalanceOverride.day - 1;
      actualEnds[todayIdx] = liveBalanceOverride.balance;
      // Also recalculate actual start for today from live balance - today's P&L
      const todayPnL = dailyPnL[(() => {
        const d = new Date(cycleStart);
        d.setDate(cycleStart.getDate() + todayIdx);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })()] || 0;
      actualBalance = liveBalanceOverride.balance - todayPnL;
    }

    // Build schedule rows with both expected and actual balances
    for (let i = 0; i < tradingDays; i++) {
      const dayNum = i + 1;
      const depositToday = depositsByDay[dayNum] || 0;
      const currentDayDate = new Date(cycleStart);
      currentDayDate.setDate(cycleStart.getDate() + i);

      const expectedStart = expectedStarts[i];
      const expectedEnd = expectedEnds[i];
      const actualEnd = actualEnds[i];
      const actualStart = actualEnd != null && Number.isFinite(actualEnd) ? expectedStart : undefined;

      const totalDeficitAdvantage = actualEnd != null && Number.isFinite(expectedEnd)
        ? actualEnd - expectedEnd
        : undefined;

      scheduleData.push({
        day: dayNum,
        date: currentDayDate,
        deposit: depositToday,
        startBalance: expectedStart,
        expectedStartBalance: expectedStart,
        dollarProfitTarget: expectedProfits[i],
        requiredPct: expectedStart > 0 ? (expectedProfits[i] / expectedStart) * 100 : 0,
        endBalance: expectedEnd,
        actualStartBalance: actualStart,
        actualEndBalance: actualEnd,
        totalDeficitAdvantage,
        isLiveBalance: false,
      });
    }

    return scheduleData;
  }, [
    state.initialBalance,
    state.tradingDays,
    state.baseRate,
    state.deposits,
    state.startDate,
    tradesByCalendarDate,
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
      'Expected Start': Number(row.expectedStartBalance.toFixed(2)),
      'Profit Target': Number(row.dollarProfitTarget.toFixed(2)),
      'Required %': row.requiredPct / 100,
      'End Balance': Number(row.endBalance.toFixed(2)),
      'Actual Balance': row.actualEndBalance != null ? Number(row.actualEndBalance.toFixed(2)) : undefined,
      'Total Deficit/Advantage': row.totalDeficitAdvantage != null ? Number(row.totalDeficitAdvantage.toFixed(2)) : undefined,
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Compound Schedule');

    // Apply percent number format to the Required % column
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const pctColIdx = 4; // 0-based: Day=0, Date=1, ExpectedStart=2, ProfitTarget=3, Req%=4
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
