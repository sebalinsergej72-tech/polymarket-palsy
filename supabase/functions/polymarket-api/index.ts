import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ClobClient } from "npm:@polymarket/clob-client@4.22.8";
import { Wallet } from "npm:ethers@5.7.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const GAMMA_API = "https://gamma-api.polymarket.com";

let cachedCreds: { apiKey: string; secret: string; passphrase: string } | null = null;
let cachedClient: any = null;

// ─── Supabase Admin Client ───
function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ─── Trading Client ───
async function getTradingClient() {
  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  if (cachedClient) return cachedClient;

  const signer = new Wallet(privateKey);
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  cachedCreds = creds;
  cachedClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);
  return cachedClient;
}

// ─── Gamma API: Fetch markets with rewards data ───
async function getMarkets(limit: number) {
  const res = await fetch(
    `${GAMMA_API}/markets?limit=${Math.min(limit * 3, 100)}&active=true&closed=false&order=volume24hr&ascending=false`
  );
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
  return await res.json();
}

// ─── Mid-price with fallback chain ───
async function getMidPrice(client: any, tokenId: string): Promise<{ mid: number; source: string; range1h: number }> {
  try {
    const book = await client.getOrderBook(tokenId);
    const hasBids = book?.bids?.length > 0;
    const hasAsks = book?.asks?.length > 0;

    if (hasBids && hasAsks) {
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk = parseFloat(book.asks[0].price);
      // Calculate 1h price range approximation from spread
      const range1h = (bestAsk - bestBid) / ((bestBid + bestAsk) / 2) * 100;
      return { mid: (bestBid + bestAsk) / 2, source: "orderbook", range1h };
    }

    // Fallback: use last trade price if available
    if (book?.market?.lastTradePrice) {
      return { mid: parseFloat(book.market.lastTradePrice), source: "last_trade", range1h: 0 };
    }

    // Fallback: use best available side
    if (hasBids) return { mid: parseFloat(book.bids[0].price), source: "bid_only", range1h: 0 };
    if (hasAsks) return { mid: parseFloat(book.asks[0].price), source: "ask_only", range1h: 0 };
  } catch {
    // silent
  }
  return { mid: 0.5, source: "fallback", range1h: 0 };
}

// ─── Fetch external oracle price for crypto markets ───
async function getExternalPrice(marketQuestion: string): Promise<number | null> {
  const cryptoMap: Record<string, string> = {
    BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
    DOGE: "DOGEUSDT", XRP: "XRPUSDT", ADA: "ADAUSDT",
  };
  for (const [symbol, pair] of Object.entries(cryptoMap)) {
    if (marketQuestion.toUpperCase().includes(symbol)) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
        if (res.ok) {
          const data = await res.json();
          return parseFloat(data.price);
        }
      } catch { /* silent */ }
    }
  }
  return null;
}

// ─── Score market for sponsor rewards prioritization ───
function scoreMarket(market: any): number {
  const volume24h = parseFloat(market.volume24hr || market.volume || "0");
  const sponsorPool = parseFloat(market.rewardsDaily || market.rewardPoolSize || market.liquidityRewards || "0");
  return volume24h * (sponsorPool / 1000 + 1);
}

// ─── Dynamic spread calculation ───
function calcDynamicSpread(baseBp: number, sponsorPool: number, range1h: number): number {
  let spread = baseBp;
  // Reduce spread for high-reward markets (more competitive)
  if (sponsorPool > 2000) spread *= 0.5;
  else if (sponsorPool > 1000) spread *= 0.7;
  // Increase spread for volatile markets
  if (range1h > 4) spread *= 1.4;
  else if (range1h > 2) spread *= 1.2;
  // Clamp
  return Math.max(5, Math.min(60, Math.round(spread)));
}

// ─── Skew adjustment ───
function applySkew(
  buyPrice: number, sellPrice: number, orderSize: number,
  netPos: number, maxPos: number, baseBp: number
): { buyPrice: number; sellPrice: number; buySize: number; sellSize: number; pauseBuy: boolean; pauseSell: boolean } {
  const spreadDecimal = baseBp / 10000;
  let buySize = orderSize;
  let sellSize = orderSize;
  let pauseBuy = false;
  let pauseSell = false;

  const threshold = maxPos * 0.6;

  if (netPos > threshold) {
    // Long heavy → discourage buys, encourage sells
    buyPrice -= spreadDecimal * 0.5; // widen buy
    sellPrice -= spreadDecimal * 0.3; // tighten sell
    buySize = Math.max(1, Math.round(orderSize * 0.5));
  } else if (netPos < -threshold) {
    // Short heavy → discourage sells, encourage buys
    sellPrice += spreadDecimal * 0.5;
    buyPrice += spreadDecimal * 0.3;
    sellSize = Math.max(1, Math.round(orderSize * 0.5));
  }

  if (netPos > maxPos) pauseBuy = true;
  if (netPos < -maxPos) pauseSell = true;

  buyPrice = Math.max(0.01, buyPrice);
  sellPrice = Math.min(0.99, sellPrice);

  return { buyPrice, sellPrice, buySize, sellSize, pauseBuy, pauseSell };
}

// ─── DB helpers ───
async function getNetPosition(sb: any, marketId: string): Promise<number> {
  const { data } = await sb.from("bot_positions").select("net_position").eq("market_id", marketId).maybeSingle();
  return data?.net_position ? parseFloat(data.net_position) : 0;
}

async function updateNetPosition(sb: any, marketId: string, marketName: string, tokenId: string, delta: number) {
  const current = await getNetPosition(sb, marketId);
  await sb.from("bot_positions").upsert({
    market_id: marketId,
    market_name: marketName,
    token_id: tokenId,
    net_position: current + delta,
    updated_at: new Date().toISOString(),
  }, { onConflict: "market_id" });
}

async function logTrade(sb: any, entry: Record<string, unknown>) {
  await sb.from("bot_trade_log").insert(entry);
}

async function getDailyPnl(sb: any): Promise<any> {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await sb.from("bot_daily_pnl").select("*").eq("date", today).maybeSingle();
  return data;
}

async function upsertDailyPnl(sb: any, pnl: number, totalCapital: number, tradeCount: number, circuitBreaker: boolean) {
  const today = new Date().toISOString().split("T")[0];
  const existing = await getDailyPnl(sb);
  await sb.from("bot_daily_pnl").upsert({
    date: today,
    realized_pnl: (existing?.realized_pnl || 0) + pnl,
    total_capital: totalCapital,
    trade_count: (existing?.trade_count || 0) + tradeCount,
    circuit_breaker_triggered: circuitBreaker || existing?.circuit_breaker_triggered || false,
    updated_at: new Date().toISOString(),
  }, { onConflict: "date" });
}

// ─── Check if order price is within tolerance ───
function isWithinTolerance(existingPrice: number, targetPrice: number, toleranceBp: number = 0.5): boolean {
  const diff = Math.abs(existingPrice - targetPrice);
  return diff <= toleranceBp / 10000;
}

// ═══════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, ...params } = await req.json();

    switch (action) {
      case "get_markets": {
        const markets = await getMarkets(params.limit || 5);
        return new Response(JSON.stringify({ markets }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "derive_creds": {
        const client = await getTradingClient();
        const apiKey = cachedCreds?.apiKey || cachedCreds?.key || "unknown";
        return new Response(
          JSON.stringify({ ok: true, address: String(apiKey).slice(0, 12) + "..." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "get_stats": {
        const client = await getTradingClient();
        const sb = getSupabase();
        const stats: Record<string, unknown> = {
          balance: 0, openPositions: 0, totalValue: 0,
          openOrders: 0, pnl: 0, cumulativePnl: 0,
          positions: [], circuitBreaker: false,
        };

        try {
          const orders = await client.getOpenOrders();
          stats.openOrders = orders?.length || 0;
          let ordersValue = 0;
          if (orders?.length > 0) {
            for (const order of orders) {
              ordersValue += parseFloat(order.original_size || order.size || "0") * parseFloat(order.price || "0");
            }
          }
          stats.totalValue = parseFloat(ordersValue.toFixed(2));
        } catch (e) {
          console.error("Error fetching orders:", e.message);
        }

        // Get positions from DB
        try {
          const { data: positions } = await sb.from("bot_positions")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(20);
          stats.positions = positions || [];
          stats.openPositions = (positions || []).filter((p: any) => Math.abs(p.net_position) > 0.01).length;
        } catch { /* silent */ }

        // Get daily & cumulative P&L
        try {
          const daily = await getDailyPnl(sb);
          stats.pnl = daily?.realized_pnl || 0;
          stats.circuitBreaker = daily?.circuit_breaker_triggered || false;

          const { data: cumData } = await sb.from("bot_cumulative_pnl").select("cumulative_pnl").limit(1);
          stats.cumulativePnl = cumData?.[0]?.cumulative_pnl || 0;
        } catch { /* silent */ }

        return new Response(
          JSON.stringify({ ok: true, stats }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "cancel_all": {
        const client = await getTradingClient();
        const result = await client.cancelAll();
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get_pnl_history": {
        const sb = getSupabase();
        const { data } = await sb.from("bot_cumulative_pnl")
          .select("*")
          .order("date", { ascending: true })
          .limit(30);
        return new Response(
          JSON.stringify({ ok: true, history: data || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "get_positions": {
        const sb = getSupabase();
        const { data } = await sb.from("bot_positions")
          .select("*")
          .order("updated_at", { ascending: false });
        return new Response(
          JSON.stringify({ ok: true, positions: data || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "run_cycle": {
        // ═══ PRODUCTION MARKET-MAKING CYCLE ═══
        const client = await getTradingClient();
        const sb = getSupabase();
        const logs: string[] = [];

        const maxMarkets = params.maxMarkets || 5;
        const baseBp = params.spread || 15;
        const orderSize = params.orderSize || 50;
        const paperTrading = params.paperTrading ?? true;
        const maxPosition = params.maxPosition || 250;
        const minSponsorPool = params.minSponsorPool || 300;
        const totalCapital = params.totalCapital || 1000;
        const useExternalOracle = params.useExternalOracle || false;

        const orders: any[] = [];

        // ── 0. Circuit breaker check ──
        const dailyPnl = await getDailyPnl(sb);
        if (dailyPnl?.circuit_breaker_triggered) {
          logs.push("🚨 CIRCUIT BREAKER ACTIVE — дневной лимит убытков превышен. Переключено в Paper.");
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0, circuitBreaker: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const currentDailyPnl = dailyPnl?.realized_pnl || 0;
        if (currentDailyPnl < -(totalCapital * 0.03)) {
          logs.push(`🚨 CIRCUIT BREAKER: дневной P&L ${currentDailyPnl.toFixed(2)} < -3% от капитала (${totalCapital})`);
          await upsertDailyPnl(sb, 0, totalCapital, 0, true);
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0, circuitBreaker: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ── 1. Fetch & score markets ──
        logs.push(`📊 Загрузка рынков (мин. спонсор: $${minSponsorPool})...`);
        const allMarkets = await getMarkets(maxMarkets);

        // Score and filter by sponsor rewards
        const scored = allMarkets.map((m: any) => ({
          ...m,
          sponsorPool: parseFloat(m.rewardsDaily || m.rewardPoolSize || m.liquidityRewards || "0"),
          score: scoreMarket(m),
        }));

        // Sort by score, prefer sponsored markets
        scored.sort((a: any, b: any) => b.score - a.score);

        // Filter: only sponsored markets if enough, otherwise fall back to volume
        let selectedMarkets = scored.filter((m: any) => m.sponsorPool >= minSponsorPool);
        if (selectedMarkets.length < maxMarkets) {
          // Fill remaining slots with top volume markets
          const remaining = scored.filter((m: any) => !selectedMarkets.includes(m));
          selectedMarkets = [...selectedMarkets, ...remaining].slice(0, maxMarkets);
        } else {
          selectedMarkets = selectedMarkets.slice(0, maxMarkets);
        }

        logs.push(`✅ Выбрано ${selectedMarkets.length} рынков (${selectedMarkets.filter((m: any) => m.sponsorPool > 0).length} со спонсорами)`);

        // ── 2. Get current open orders (for selective update) ──
        let existingOrders: any[] = [];
        if (!paperTrading) {
          try {
            existingOrders = await client.getOpenOrders() || [];
            logs.push(`📋 Текущие ордера: ${existingOrders.length}`);
          } catch (e) {
            logs.push(`⚠️ Не удалось получить ордера: ${e.message}`);
          }
        }

        // ── 3. Process each market ──
        for (const market of selectedMarkets) {
          if (!market.clobTokenIds || market.clobTokenIds.length === 0) {
            logs.push(`⏭️ ${(market.question || "").slice(0, 40)}... — нет tokenId`);
            continue;
          }

          const tokenId = market.clobTokenIds[0];
          const negRisk = market.negRisk ?? false;
          const marketId = market.conditionId || market.id || tokenId;
          const marketName = (market.question || "Unknown").slice(0, 50);

          // Get mid price with fallback chain
          let { mid: midPrice, source: priceSource, range1h } = await getMidPrice(client, tokenId);

          // Optional external oracle for crypto
          if (useExternalOracle) {
            const extPrice = await getExternalPrice(market.question || "");
            if (extPrice !== null) {
              logs.push(`  🔮 Внешний оракул: ${extPrice} (${priceSource} mid: ${midPrice.toFixed(4)})`);
              // Use external as reference, don't override polymarket mid
            }
          }

          // Dynamic spread
          const dynamicBp = calcDynamicSpread(baseBp, market.sponsorPool || 0, range1h);

          // Get net position for skew
          const netPos = await getNetPosition(sb, marketId);

          // Calculate base prices
          const spreadDecimal = dynamicBp / 10000;
          let buyPrice = midPrice - spreadDecimal;
          let sellPrice = midPrice + spreadDecimal;

          // Apply skew
          const skew = applySkew(buyPrice, sellPrice, orderSize, netPos, maxPosition, dynamicBp);

          const sponsorLabel = market.sponsorPool > 0 ? ` 🏆$${market.sponsorPool}` : "";
          logs.push(`📈 ${marketName}: mid=${midPrice.toFixed(4)} (${priceSource}) spread=${dynamicBp}bp${sponsorLabel}`);
          if (Math.abs(netPos) > 0.01) {
            logs.push(`  📊 Позиция: ${netPos.toFixed(2)} USDC | Skew: buy=${skew.buySize}, sell=${skew.sellSize}`);
          }

          if (paperTrading) {
            // ── Paper mode ──
            if (!skew.pauseBuy) {
              logs.push(`  📝 [PAPER] BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
              // Simulate partial fill (50% chance)
              if (Math.random() > 0.5) {
                const fillSize = Math.round(skew.buySize * (0.3 + Math.random() * 0.7));
                await updateNetPosition(sb, marketId, marketName, tokenId, fillSize);
                await upsertDailyPnl(sb, spreadDecimal * fillSize * 0.5, totalCapital, 1, false);
                logs.push(`  ✅ [PAPER] Частичное исполнение BUY: ${fillSize} USDC`);
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ [PAPER] BUY пропущен (макс. позиция)`);
            }
            if (!skew.pauseSell) {
              logs.push(`  📝 [PAPER] SELL @ ${skew.sellPrice.toFixed(4)} (${skew.sellSize} USDC)`);
              if (Math.random() > 0.5) {
                const fillSize = Math.round(skew.sellSize * (0.3 + Math.random() * 0.7));
                await updateNetPosition(sb, marketId, marketName, tokenId, -fillSize);
                await upsertDailyPnl(sb, spreadDecimal * fillSize * 0.5, totalCapital, 1, false);
                logs.push(`  ✅ [PAPER] Частичное исполнение SELL: ${fillSize} USDC`);
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ [PAPER] SELL пропущен (макс. позиция)`);
            }
          } else {
            // ── LIVE mode: Selective Order Update ──
            const myBuys = existingOrders.filter(
              (o: any) => o.asset_id === tokenId && (o.side === "BUY" || o.side === "buy")
            );
            const mySells = existingOrders.filter(
              (o: any) => o.asset_id === tokenId && (o.side === "SELL" || o.side === "sell")
            );

            // ── BUY side ──
            if (!skew.pauseBuy) {
              const existingBuy = myBuys[0];
              if (existingBuy && isWithinTolerance(parseFloat(existingBuy.price), skew.buyPrice)) {
                logs.push(`  ♻️ BUY @ ${parseFloat(existingBuy.price).toFixed(4)} в пределах допуска — оставлен`);
              } else {
                // Cancel existing if any
                if (existingBuy) {
                  try {
                    await client.cancelOrder(existingBuy.id);
                    logs.push(`  🗑️ Отменён BUY @ ${parseFloat(existingBuy.price).toFixed(4)}`);
                    await logTrade(sb, { market_name: marketName, market_id: marketId, action: "cancel", side: "BUY", price: parseFloat(existingBuy.price), size: parseFloat(existingBuy.original_size || existingBuy.size || "0"), paper: false });
                  } catch (e) {
                    logs.push(`  ⚠️ Ошибка отмены BUY: ${e.message}`);
                  }
                }
                // Place new
                try {
                  const buyOrder = await client.createAndPostOrder(
                    { tokenID: tokenId, price: parseFloat(skew.buyPrice.toFixed(2)), size: skew.buySize, side: "BUY" },
                    { tickSize: "0.01", negRisk },
                    "GTC"
                  );
                  logs.push(`  ✅ BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
                  orders.push(buyOrder);
                  await logTrade(sb, { market_name: marketName, market_id: marketId, action: "place", side: "BUY", price: skew.buyPrice, size: skew.buySize, paper: false });
                } catch (e) {
                  logs.push(`  ❌ BUY failed: ${e.message}`);
                }
              }
              // Cancel extra buys
              for (const extra of myBuys.slice(1)) {
                try { await client.cancelOrder(extra.id); } catch { /* silent */ }
              }
            } else {
              logs.push(`  ⏸️ BUY пропущен (макс. позиция ${netPos.toFixed(0)}/${maxPosition})`);
              for (const b of myBuys) {
                try { await client.cancelOrder(b.id); } catch { /* silent */ }
              }
            }

            // ── SELL side ──
            if (!skew.pauseSell) {
              const existingSell = mySells[0];
              if (existingSell && isWithinTolerance(parseFloat(existingSell.price), skew.sellPrice)) {
                logs.push(`  ♻️ SELL @ ${parseFloat(existingSell.price).toFixed(4)} в пределах допуска — оставлен`);
              } else {
                if (existingSell) {
                  try {
                    await client.cancelOrder(existingSell.id);
                    logs.push(`  🗑️ Отменён SELL @ ${parseFloat(existingSell.price).toFixed(4)}`);
                    await logTrade(sb, { market_name: marketName, market_id: marketId, action: "cancel", side: "SELL", price: parseFloat(existingSell.price), size: parseFloat(existingSell.original_size || existingSell.size || "0"), paper: false });
                  } catch (e) {
                    logs.push(`  ⚠️ Ошибка отмены SELL: ${e.message}`);
                  }
                }
                try {
                  const sellOrder = await client.createAndPostOrder(
                    { tokenID: tokenId, price: parseFloat(skew.sellPrice.toFixed(2)), size: skew.sellSize, side: "SELL" },
                    { tickSize: "0.01", negRisk },
                    "GTC"
                  );
                  logs.push(`  ✅ SELL @ ${skew.sellPrice.toFixed(4)} (${skew.sellSize} USDC)`);
                  orders.push(sellOrder);
                  await logTrade(sb, { market_name: marketName, market_id: marketId, action: "place", side: "SELL", price: skew.sellPrice, size: skew.sellSize, paper: false });
                } catch (e) {
                  logs.push(`  ❌ SELL failed: ${e.message}`);
                }
              }
              for (const extra of mySells.slice(1)) {
                try { await client.cancelOrder(extra.id); } catch { /* silent */ }
              }
            } else {
              logs.push(`  ⏸️ SELL пропущен (макс. позиция ${netPos.toFixed(0)}/${maxPosition})`);
              for (const s of mySells) {
                try { await client.cancelOrder(s.id); } catch { /* silent */ }
              }
            }
          }
        }

        const modeLabel = paperTrading ? "📝 PAPER" : "💰 LIVE";
        logs.push(`${modeLabel} Итого: ${orders.length} ордеров ${paperTrading ? "симулировано" : "размещено/обновлено"}`);

        return new Response(
          JSON.stringify({ ok: true, logs, ordersPlaced: orders.length }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
