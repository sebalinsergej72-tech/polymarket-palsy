
DROP VIEW IF EXISTS public.bot_cumulative_pnl;
CREATE OR REPLACE VIEW public.bot_cumulative_pnl
WITH (security_invoker = true) AS
SELECT 
  date,
  realized_pnl,
  total_capital,
  trade_count,
  circuit_breaker_triggered,
  SUM(realized_pnl) OVER (ORDER BY date) as cumulative_pnl
FROM public.bot_daily_pnl
ORDER BY date DESC;
