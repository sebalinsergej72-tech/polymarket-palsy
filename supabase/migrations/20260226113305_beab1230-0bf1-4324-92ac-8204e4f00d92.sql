
-- Positions tracking per market (persistent across restarts)
CREATE TABLE public.bot_positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id TEXT NOT NULL UNIQUE,
  market_name TEXT,
  token_id TEXT,
  net_position NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.bot_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bot_positions"
ON public.bot_positions FOR ALL
USING (true)
WITH CHECK (true);

-- Daily P&L tracking (persistent)
CREATE TABLE public.bot_daily_pnl (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE UNIQUE,
  realized_pnl NUMERIC DEFAULT 0,
  total_capital NUMERIC DEFAULT 1000,
  trade_count INTEGER DEFAULT 0,
  circuit_breaker_triggered BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.bot_daily_pnl ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bot_daily_pnl"
ON public.bot_daily_pnl FOR ALL
USING (true)
WITH CHECK (true);

-- Trade log for full history
CREATE TABLE public.bot_trade_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT now(),
  market_name TEXT,
  market_id TEXT,
  action TEXT NOT NULL,
  side TEXT,
  price NUMERIC,
  size NUMERIC,
  paper BOOLEAN DEFAULT true,
  notes TEXT
);

ALTER TABLE public.bot_trade_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bot_trade_log"
ON public.bot_trade_log FOR ALL
USING (true)
WITH CHECK (true);

-- Cumulative P&L view
CREATE OR REPLACE VIEW public.bot_cumulative_pnl AS
SELECT 
  date,
  realized_pnl,
  total_capital,
  trade_count,
  circuit_breaker_triggered,
  SUM(realized_pnl) OVER (ORDER BY date) as cumulative_pnl
FROM public.bot_daily_pnl
ORDER BY date DESC;
