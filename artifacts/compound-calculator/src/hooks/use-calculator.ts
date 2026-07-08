import { useMemo, useState } from 'react';
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
}

export interface CalculatorState {
  initialBalance: number;
  tradingDays: number;
  baseRate: number; // e.g. 20 for 20%
  currentDay: number;
  deposits: Deposit[];
}

export function useCalculator(initialState?: Partial<CalculatorState>) {
  const [state, setState] = useState<CalculatorState>({
    initialBalance: initialState?.initialBalance ?? 1000,
    tradingDays: initialState?.tradingDays ?? 30,
    baseRate: initialState?.baseRate ?? 20,
    currentDay: initialState?.currentDay ?? 1,
    deposits: initialState?.deposits ?? [],
  });

  const updateState = (updates: Partial<CalculatorState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates };
      // Clamp tradingDays to a safe range
      next.tradingDays = Math.max(1, Math.min(365, next.tradingDays));
      // Keep currentDay within the new tradingDays bound
      next.currentDay = Math.max(1, Math.min(next.tradingDays, next.currentDay));
      // Remove deposits that fall outside the new tradingDays range
      next.deposits = next.deposits.filter((d) => d.day >= 1 && d.day <= next.tradingDays);
      return next;
    });
  };

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

  const schedule = useMemo(() => {
    const { initialBalance, tradingDays, baseRate, deposits } = state;
    const rateDecimal = baseRate / 100;
    
    // Group deposits by day for easy lookup
    const depositsByDay = deposits.reduce((acc, dep) => {
      acc[dep.day] = (acc[dep.day] || 0) + dep.amount;
      return acc;
    }, {} as Record<number, number>);

    const scheduleData: DayData[] = [];
    
    // Use today as starting point for dates
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);

    let actualEndPrev = 0;

    for (let i = 1; i <= tradingDays; i++) {
      // 1. Calculate original target
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

      const requiredPct = actualStart > 0 ? (originalDollarProfit / actualStart) * 100 : 0;
      const actualEnd = actualStart + originalDollarProfit;

      const currentDayDate = new Date(startDate);
      currentDayDate.setDate(startDate.getDate() + (i - 1));

      scheduleData.push({
        day: i,
        date: currentDayDate,
        deposit: depositToday,
        startBalance: actualStart,
        dollarProfitTarget: originalDollarProfit,
        requiredPct,
        endBalance: actualEnd,
      });

      actualEndPrev = actualEnd;
    }

    return scheduleData;
  }, [state.initialBalance, state.tradingDays, state.baseRate, state.deposits]);

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
  };
}
