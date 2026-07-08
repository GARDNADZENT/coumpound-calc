import { useState, useRef } from 'react';
import { useCalculator } from '@/hooks/use-calculator';
import { useDerivAccount } from '@/hooks/use-deriv-account';
import { formatCurrency, formatPercentage } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Plus, Trash2, Download, TrendingUp, DollarSign, Calendar, Target,
  Wifi, WifiOff, RefreshCw, LogOut, Eye, EyeOff, ChevronDown, ChevronUp,
  ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full shrink-0',
        status === 'authorized' && 'bg-emerald-500 shadow-[0_0_6px_#10b981]',
        status === 'connected' && 'bg-yellow-400',
        status === 'connecting' && 'bg-yellow-400 animate-pulse',
        status === 'error' && 'bg-red-500',
        status === 'disconnected' && 'bg-muted-foreground/40',
      )}
    />
  );
}

export default function Home() {
  const {
    state,
    updateState,
    addDeposit,
    removeDeposit,
    schedule,
    currentDayData,
    finalTarget,
    exportToExcel,
  } = useCalculator();

  const deriv = useDerivAccount();

  const [newDepositDay, setNewDepositDay] = useState('');
  const [newDepositAmount, setNewDepositAmount] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [showTrades, setShowTrades] = useState(true);

  const isDerivConnected = deriv.status === 'authorized';

  const handleAddDeposit = () => {
    const day = parseInt(newDepositDay, 10);
    const amount = parseFloat(newDepositAmount);
    if (day > 0 && day <= state.tradingDays && amount > 0) {
      addDeposit(day, amount);
      setNewDepositDay('');
      setNewDepositAmount('');
    }
  };

  const handleConnectDeriv = () => {
    const t = tokenInput.trim();
    if (!t) return;
    // Don't clear input yet — keep it visible so the user can retry on failure.
    // We clear it below once status flips to 'authorized'.
    deriv.connect(t);
  };

  // Clear the token input once successfully authorized.
  const prevStatus = useRef(deriv.status);
  if (prevStatus.current !== deriv.status) {
    prevStatus.current = deriv.status;
    if (deriv.status === 'authorized' && tokenInput) {
      setTokenInput('');
    }
  }

  const handleSyncBalance = () => {
    if (deriv.balance != null) {
      updateState({ initialBalance: deriv.balance });
    }
  };

  // Progress toward today's dollar target based on Deriv P&L
  const todayTarget = currentDayData?.dollarProfitTarget ?? 0;
  const todayProgress = isDerivConnected ? Math.min(deriv.todayPnL.totalProfit, todayTarget) : 0;
  const progressPct = todayTarget > 0 ? Math.max(0, Math.min(100, (todayProgress / todayTarget) * 100)) : 0;

  const formatTradeSymbol = (shortcode: string) => {
    const parts = shortcode?.split('_') ?? [];
    return parts[1] ?? shortcode ?? '—';
  };

  const formatTradeType = (type: string) =>
    type?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? type;

  const formatTradeTime = (ts: number | null) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between max-w-7xl">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
              <TrendingUp size={18} />
            </div>
            <h1 className="font-semibold text-lg tracking-tight">Compound Pro</h1>
            {isDerivConnected && (
              <Badge
                variant="outline"
                className="hidden sm:flex items-center gap-1.5 text-emerald-400 border-emerald-500/30 bg-emerald-500/10 text-xs"
                data-testid="badge-deriv-connected"
              >
                <StatusDot status="authorized" />
                {deriv.accountInfo?.loginid}
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:flex gap-2 text-muted-foreground hover:text-foreground border-border"
            onClick={exportToExcel}
            data-testid="button-export-header"
          >
            <Download size={14} />
            Export Schedule
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* LEFT PANEL */}
          <div className="lg:col-span-4 space-y-6">

            {/* Deriv Connection Card */}
            <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    {isDerivConnected ? <Wifi size={16} className="text-emerald-400" /> : <WifiOff size={16} className="text-muted-foreground" />}
                    Deriv Account
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={deriv.status} />
                    <span className="text-xs text-muted-foreground capitalize">
                      {deriv.status === 'authorized' ? 'live' : deriv.status}
                    </span>
                  </div>
                </div>
                {!isDerivConnected && (
                  <CardDescription className="text-xs">
                    Connect to read your live balance and track trades automatically.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {isDerivConnected && deriv.accountInfo ? (
                  /* Connected state */
                  <div className="space-y-3">
                    {/* Account info */}
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Account</span>
                        <span className="text-xs font-mono font-medium">{deriv.accountInfo.loginid}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Name</span>
                        <span className="text-xs font-medium truncate max-w-[140px]">{deriv.accountInfo.fullname || deriv.accountInfo.email}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Type</span>
                        <Badge variant="outline" className="text-xs py-0 h-5">
                          {deriv.accountInfo.is_virtual ? 'Demo' : 'Real'}
                        </Badge>
                      </div>
                    </div>

                    {/* Live balance */}
                    <div className="rounded-md border border-border/40 bg-background/50 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">Live Balance</span>
                        <Badge variant="outline" className="text-xs py-0 h-5 text-muted-foreground">{deriv.currency}</Badge>
                      </div>
                      <div className="flex items-end justify-between gap-2">
                        <span className="text-2xl font-mono font-bold text-foreground" data-testid="text-deriv-balance">
                          {deriv.balance != null ? formatCurrency(deriv.balance) : '—'}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1 shrink-0"
                          onClick={handleSyncBalance}
                          data-testid="button-sync-balance"
                          title="Use this balance as the calculator's initial balance"
                        >
                          <RefreshCw size={11} />
                          Sync
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        Sync sets this as your calculator starting balance.
                      </p>
                    </div>

                    {/* Today P&L */}
                    <div className="rounded-md border border-border/40 bg-background/50 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">Today's P&L</span>
                        <span className={cn(
                          'text-sm font-mono font-semibold',
                          deriv.todayPnL.totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400',
                        )} data-testid="text-today-pnl">
                          {deriv.todayPnL.totalProfit >= 0 ? '+' : ''}{formatCurrency(deriv.todayPnL.totalProfit)}
                        </span>
                      </div>
                      {/* Progress bar toward daily target */}
                      <div>
                        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                          <span>Target: {formatCurrency(todayTarget)}</span>
                          <span>{progressPct.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-500',
                              progressPct >= 100 ? 'bg-emerald-400' : progressPct > 50 ? 'bg-yellow-400' : 'bg-primary',
                            )}
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-3 text-[10px] text-muted-foreground">
                        <span>{deriv.todayPnL.tradesCount} trades</span>
                        <span className="text-emerald-400/80">{deriv.todayPnL.wins}W</span>
                        <span className="text-red-400/80">{deriv.todayPnL.losses}L</span>
                      </div>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
                      onClick={deriv.disconnect}
                      data-testid="button-disconnect-deriv"
                    >
                      <LogOut size={12} />
                      Disconnect &amp; clear token
                    </Button>
                  </div>
                ) : (
                  /* Disconnected / error state */
                  <div className="space-y-3">
                    {deriv.status === 'error' && deriv.error ? (
                      <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400 flex items-start gap-2">
                        <span className="shrink-0 mt-0.5">✕</span>
                        <span>
                          <span className="font-medium block mb-0.5">Connection failed</span>
                          {deriv.error}
                          {deriv.savedToken && (
                            <button
                              className="block mt-1 underline text-muted-foreground hover:text-foreground"
                              onClick={deriv.clearSavedToken}
                            >
                              Clear saved token
                            </button>
                          )}
                        </span>
                      </div>
                    ) : deriv.savedToken && deriv.status === 'connecting' ? (
                      <div className="rounded-md border border-border/30 bg-muted/20 p-3 text-xs text-muted-foreground flex items-center gap-2">
                        <RefreshCw size={12} className="animate-spin shrink-0" />
                        Reconnecting with saved token…
                      </div>
                    ) : null}

                    {deriv.status === 'connecting' ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                        <RefreshCw size={14} className="animate-spin" />
                        Connecting…
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="deriv-token" className="text-xs text-muted-foreground uppercase tracking-wider">
                          Deriv API Token
                        </Label>
                        <div className="relative">
                          <Input
                            id="deriv-token"
                            type={showToken ? 'text' : 'password'}
                            placeholder="Paste your API token…"
                            className="pr-10 font-mono text-sm bg-background/50"
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleConnectDeriv(); }}
                            data-testid="input-deriv-token"
                          />
                          <button
                            type="button"
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setShowToken((v) => !v)}
                            tabIndex={-1}
                          >
                            {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        <Button
                          className="w-full gap-2 text-sm"
                          onClick={handleConnectDeriv}
                          disabled={!tokenInput.trim()}
                          data-testid="button-connect-deriv"
                        >
                          <Wifi size={14} />
                          Connect to Deriv
                        </Button>
                        <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                          Get your token at{' '}
                          <a
                            href="https://app.deriv.com/account/api-token"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-muted-foreground"
                          >
                            app.deriv.com/account/api-token
                          </a>
                          . Only Read scope is needed. Your token is saved locally in your browser.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Trading Parameters */}
            <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Trading Parameters</CardTitle>
                <CardDescription>Set your baseline compounding rules.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="initial-balance" className="text-xs text-muted-foreground uppercase tracking-wider">
                    Initial Balance ($)
                    {isDerivConnected && (
                      <span className="ml-2 text-emerald-400/70 normal-case font-normal text-[10px]">
                        — use Sync to pull from Deriv
                      </span>
                    )}
                  </Label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
                    <Input
                      id="initial-balance"
                      type="number"
                      min="0"
                      className="pl-9 font-mono bg-background/50"
                      value={state.initialBalance || ''}
                      onChange={(e) => updateState({ initialBalance: parseFloat(e.target.value) || 0 })}
                      data-testid="input-initial-balance"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="trading-days" className="text-xs text-muted-foreground uppercase tracking-wider">Days</Label>
                    <Input
                      id="trading-days"
                      type="number"
                      min="1"
                      max="365"
                      className="font-mono bg-background/50"
                      value={state.tradingDays || ''}
                      onChange={(e) => updateState({ tradingDays: parseInt(e.target.value, 10) || 1 })}
                      data-testid="input-trading-days"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="base-rate" className="text-xs text-muted-foreground uppercase tracking-wider">Base Rate (%)</Label>
                    <Input
                      id="base-rate"
                      type="number"
                      min="0"
                      step="0.1"
                      className="font-mono bg-background/50"
                      value={state.baseRate || ''}
                      onChange={(e) => updateState({ baseRate: parseFloat(e.target.value) || 0 })}
                      data-testid="input-base-rate"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Mid-Cycle Deposits */}
            <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Mid-Cycle Deposits</CardTitle>
                <CardDescription>Add capital to reduce required percentage.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2 items-end">
                  <div className="space-y-2 flex-1">
                    <Label htmlFor="deposit-day" className="text-xs text-muted-foreground uppercase tracking-wider">Day #</Label>
                    <Input
                      id="deposit-day"
                      type="number"
                      min="1"
                      max={state.tradingDays}
                      placeholder="e.g. 15"
                      className="font-mono bg-background/50"
                      value={newDepositDay}
                      onChange={(e) => setNewDepositDay(e.target.value)}
                      data-testid="input-deposit-day"
                    />
                  </div>
                  <div className="space-y-2 flex-1">
                    <Label htmlFor="deposit-amount" className="text-xs text-muted-foreground uppercase tracking-wider">Amount ($)</Label>
                    <Input
                      id="deposit-amount"
                      type="number"
                      min="0"
                      placeholder="e.g. 500"
                      className="font-mono bg-background/50"
                      value={newDepositAmount}
                      onChange={(e) => setNewDepositAmount(e.target.value)}
                      data-testid="input-deposit-amount"
                    />
                  </div>
                  <Button
                    onClick={handleAddDeposit}
                    disabled={!newDepositDay || !newDepositAmount}
                    size="icon"
                    className="shrink-0"
                    data-testid="button-add-deposit"
                  >
                    <Plus size={16} />
                  </Button>
                </div>
                {state.deposits.length > 0 && (
                  <div className="border border-border rounded-md overflow-hidden">
                    <div className="bg-muted/30 px-3 py-2 border-b border-border flex justify-between items-center text-xs font-medium text-muted-foreground">
                      <span>Day</span>
                      <span>Amount</span>
                      <span className="w-8" />
                    </div>
                    <ul className="divide-y divide-border/50 max-h-[200px] overflow-auto">
                      {state.deposits.map((dep) => (
                        <li key={dep.id} className="flex justify-between items-center px-3 py-2 text-sm bg-background/50 hover:bg-muted/30 transition-colors">
                          <span className="font-mono">Day {dep.day}</span>
                          <span className="font-mono text-emerald-400">{formatCurrency(dep.amount)}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => removeDeposit(dep.id)}
                            data-testid={`button-remove-deposit-${dep.id}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* RIGHT PANEL */}
          <div className="lg:col-span-8 space-y-6">

            {/* Dashboard */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex flex-col">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <Calendar className="text-primary h-5 w-5" />
                    Today's Target
                  </h2>
                  {currentDayData && (
                    <span className="text-sm text-muted-foreground ml-7">
                      {currentDayData.date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="current-day" className="text-sm text-muted-foreground">Current Day:</Label>
                  <Input
                    id="current-day"
                    type="number"
                    min="1"
                    max={state.tradingDays}
                    className="w-20 h-8 font-mono text-right bg-card border-border/50"
                    value={state.currentDay || ''}
                    onChange={(e) => updateState({ currentDay: parseInt(e.target.value, 10) || 1 })}
                    data-testid="input-current-day"
                  />
                </div>
              </div>

              {currentDayData && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                  <Card className="bg-card/40 border-border/40">
                    <CardContent className="p-4 flex flex-col justify-center">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Start Balance</span>
                      <span className="text-xl font-mono font-semibold" data-testid="text-today-start">
                        {formatCurrency(currentDayData.startBalance)}
                      </span>
                    </CardContent>
                  </Card>

                  <Card className="bg-primary/10 border-primary/20 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-2 opacity-10">
                      <Target size={40} />
                    </div>
                    <CardContent className="p-4 flex flex-col justify-center relative z-10">
                      <span className="text-xs text-primary/80 font-medium uppercase tracking-wider mb-1">Dollar Profit</span>
                      <span className="text-xl font-mono font-bold text-primary" data-testid="text-today-profit">
                        {formatCurrency(currentDayData.dollarProfitTarget)}
                      </span>
                    </CardContent>
                  </Card>

                  <Card className={cn(
                    'bg-card/40 border-border/40 relative overflow-hidden',
                    currentDayData.requiredPct < state.baseRate ? 'border-emerald-500/30 bg-emerald-500/5' : '',
                  )}>
                    <CardContent className="p-4 flex flex-col justify-center relative z-10">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Required %</span>
                      <div className="flex items-baseline gap-2">
                        <span className={cn(
                          'text-xl font-mono font-semibold',
                          currentDayData.requiredPct < state.baseRate ? 'text-emerald-400' : '',
                        )} data-testid="text-today-req-pct">
                          {formatPercentage(currentDayData.requiredPct)}
                        </span>
                        {currentDayData.requiredPct < state.baseRate && (
                          <span className="text-[10px] text-emerald-400/80 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-1">
                            <TrendingUp size={10} /> Reduced
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-card/40 border-border/40">
                    <CardContent className="p-4 flex flex-col justify-center">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">End Balance</span>
                      <span className="text-xl font-mono font-semibold" data-testid="text-today-end">
                        {formatCurrency(currentDayData.endBalance)}
                      </span>
                    </CardContent>
                  </Card>

                  {isDerivConnected && deriv.balance != null ? (
                    <>
                      <Card className="bg-card/40 border-emerald-500/20">
                        <CardContent className="p-4 flex flex-col justify-center">
                          <span className="text-xs text-emerald-400/70 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                            <Wifi size={10} /> Live Balance
                          </span>
                          <span className="text-xl font-mono font-semibold text-emerald-400" data-testid="text-live-balance">
                            {formatCurrency(deriv.balance)}
                          </span>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/40 border-border/40">
                        <CardContent className="p-4 flex flex-col justify-center">
                          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Day {state.tradingDays} Target</span>
                          <span className="text-xl font-mono font-semibold text-foreground/80" data-testid="text-final-target">
                            {formatCurrency(finalTarget)}
                          </span>
                        </CardContent>
                      </Card>
                    </>
                  ) : (
                    <Card className="bg-card/40 border-border/40 col-span-1">
                      <CardContent className="p-4 flex flex-col justify-center">
                        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Day {state.tradingDays} Target</span>
                        <span className="text-xl font-mono font-semibold text-foreground/80" data-testid="text-final-target">
                          {formatCurrency(finalTarget)}
                        </span>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* Today progress bar when Deriv is connected */}
              {isDerivConnected && todayTarget > 0 && (
                <div className="rounded-md border border-border/40 bg-card/30 px-4 py-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                    <span className="font-medium">Today's Progress</span>
                    <span>
                      <span className={cn('font-mono font-semibold', deriv.todayPnL.totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {deriv.todayPnL.totalProfit >= 0 ? '+' : ''}{formatCurrency(deriv.todayPnL.totalProfit)}
                      </span>
                      <span className="mx-1 text-border">/</span>
                      <span className="font-mono text-foreground/70">{formatCurrency(todayTarget)}</span>
                    </span>
                  </div>
                  <div className="h-2 bg-muted/40 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-700',
                        progressPct >= 100 ? 'bg-emerald-400' : progressPct >= 50 ? 'bg-yellow-400' : 'bg-primary',
                      )}
                      style={{ width: `${Math.max(progressPct, deriv.todayPnL.totalProfit < 0 ? 0 : progressPct)}%` }}
                    />
                  </div>
                  {progressPct >= 100 && (
                    <p className="text-xs text-emerald-400 mt-1.5 font-medium">Target reached!</p>
                  )}
                </div>
              )}
            </div>

            {/* Schedule Table */}
            <Card className="border-border/50 shadow-sm bg-card flex flex-col h-[500px] overflow-hidden">
              <div className="p-4 border-b border-border/50 flex items-center justify-between bg-card/80 backdrop-blur-sm shrink-0">
                <CardTitle className="text-lg">Master Schedule</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="sm:hidden gap-2"
                  onClick={exportToExcel}
                >
                  <Download size={14} /> Export
                </Button>
              </div>
              <div className="flex-1 overflow-auto relative">
                <Table>
                  <TableHeader className="sticky top-0 bg-card/95 backdrop-blur z-10 shadow-sm after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[1px] after:bg-border/50">
                    <TableRow className="border-none hover:bg-transparent">
                      <TableHead className="w-[60px] text-center">Day</TableHead>
                      <TableHead className="text-right">Start Bal</TableHead>
                      <TableHead className="text-right">Deposit</TableHead>
                      <TableHead className="text-right">Profit Tgt</TableHead>
                      <TableHead className="text-right">Req %</TableHead>
                      <TableHead className="text-right">End Bal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schedule.map((row) => {
                      const isCurrentDay = row.day === state.currentDay;
                      const hasDeposit = row.deposit > 0;
                      const reducedPct = row.requiredPct < state.baseRate;
                      return (
                        <TableRow
                          key={row.day}
                          className={cn(
                            'group transition-colors',
                            isCurrentDay && 'bg-primary/5 hover:bg-primary/10 border-primary/20 relative',
                            !isCurrentDay && hasDeposit && 'bg-emerald-500/5 hover:bg-emerald-500/10',
                            !isCurrentDay && !hasDeposit && 'hover:bg-muted/30 border-border/40',
                          )}
                          data-testid={`row-day-${row.day}`}
                        >
                          <TableCell className="font-mono text-center relative">
                            {isCurrentDay && (
                              <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary rounded-r-full" />
                            )}
                            <span className={cn(isCurrentDay ? 'text-primary font-bold' : 'text-muted-foreground')}>{row.day}</span>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatCurrency(row.startBalance)}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {hasDeposit ? (
                              <span className="text-emerald-400 inline-flex items-center gap-1 font-medium bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                                +{formatCurrency(row.deposit)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-primary/90 font-medium">
                            {formatCurrency(row.dollarProfitTarget)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            <span className={cn(reducedPct ? 'text-emerald-400 font-semibold' : 'text-foreground')}>
                              {formatPercentage(row.requiredPct)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">{formatCurrency(row.endBalance)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* Live Trades (only shown when Deriv is connected) */}
            {isDerivConnected && (
              <Card className="border-border/50 shadow-sm bg-card overflow-hidden">
                <div
                  className="p-4 border-b border-border/50 flex items-center justify-between bg-card/80 backdrop-blur-sm cursor-pointer select-none"
                  onClick={() => setShowTrades((v) => !v)}
                  data-testid="button-toggle-trades"
                >
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">Live Trades</CardTitle>
                    {deriv.todayPnL.tradesCount > 0 && (
                      <Badge variant="outline" className="text-xs text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
                        {deriv.todayPnL.tradesCount} today
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {deriv.recentTrades.length} closed trades
                    </span>
                    {showTrades ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
                  </div>
                </div>

                {showTrades && (
                  <div className="overflow-auto max-h-[400px]">
                    {deriv.recentTrades.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground text-sm">
                        No closed trades yet. Trades will appear here as you trade on Deriv.
                      </div>
                    ) : (
                      <Table>
                        <TableHeader className="sticky top-0 bg-card/95 backdrop-blur z-10">
                          <TableRow className="border-none hover:bg-transparent">
                            <TableHead>Contract</TableHead>
                            <TableHead className="hidden sm:table-cell">Symbol</TableHead>
                            <TableHead className="text-right hidden md:table-cell">Buy</TableHead>
                            <TableHead className="text-right hidden md:table-cell">Sell</TableHead>
                            <TableHead className="text-right">Profit</TableHead>
                            <TableHead className="text-right hidden sm:table-cell">Time</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deriv.recentTrades.map((trade) => {
                            const isWin = (trade.profit ?? 0) > 0;
                            return (
                              <TableRow
                                key={trade.transaction_id}
                                className="hover:bg-muted/20 border-border/40"
                                data-testid={`row-trade-${trade.transaction_id}`}
                              >
                                <TableCell className="text-sm">
                                  <span className="font-medium">{formatTradeType(trade.contract_type)}</span>
                                </TableCell>
                                <TableCell className="hidden sm:table-cell font-mono text-xs text-muted-foreground">
                                  {formatTradeSymbol(trade.shortcode)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm hidden md:table-cell">
                                  {formatCurrency(trade.buy_price)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm hidden md:table-cell">
                                  {trade.sell_price != null ? formatCurrency(trade.sell_price) : '—'}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  <span className={cn(
                                    'inline-flex items-center gap-0.5',
                                    isWin ? 'text-emerald-400' : 'text-red-400',
                                  )} data-testid={`text-trade-profit-${trade.transaction_id}`}>
                                    {isWin
                                      ? <ArrowUpRight size={12} />
                                      : <ArrowDownRight size={12} />}
                                    {isWin ? '+' : ''}{formatCurrency(trade.profit)}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right text-xs text-muted-foreground hidden sm:table-cell">
                                  {formatTradeTime(trade.sell_time)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                )}
              </Card>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
