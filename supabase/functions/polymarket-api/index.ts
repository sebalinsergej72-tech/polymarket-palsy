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

// ─── Gamma API: Fetch top active markets by 24h volume ───
async function getMarkets(limit: number) {
  const url = `${GAMMA_API}/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=${Math.min(limit, 100)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
  const events = await res.json();
  // Flatten events → markets
  const markets: any[] = [];
  for (const event of events) {
    if (event.markets && Array.isArray(event.markets)) {
      for (const m of event.markets) {
        markets.push({ ...m, eventSlug: event.slug });
      }
    } else {
      markets.push(event);
    }
  }
  return markets;
}

// ─── Mid-price with orderbook depth ───
interface MidResult {
  mid: number;
  source: string;
  range1h: number;
  bidDepth: number;
  askDepth: number;
}

async function getMidPrice(client: any, tokenId: string): Promise<MidResult> {
  try {
    const book = await client.getOrderBook(tokenId);
    const hasBids = book?.bids?.length > 0;
    const hasAsks = book?.asks?.length > 0;

    if (hasBids && hasAsks) {
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk = parseFloat(book.asks[0].price);
      const bestBidSize = parseFloat(book.bids[0].size || "0");
      const bestAskSize = parseFloat(book.asks[0].size || "0");
      const range1h = (bestAsk - bestBid) / ((bestBid + bestAsk) / 2) * 100;
      return { mid: (bestBid + bestAsk) / 2, source: "orderbook", range1h, bidDepth: bestBidSize, askDepth: bestAskSize };
    }

    // Fallback: use last trade price if available
    if (book?.market?.lastTradePrice) {
      return { mid: parseFloat(book.market.lastTradePrice), source: "last_trade", range1h: 0, bidDepth: 0, askDepth: 0 };
    }

    if (hasBids) return { mid: parseFloat(book.bids[0].price), source: "bid_only", range1h: 0, bidDepth: parseFloat(book.bids[0].size || "0"), askDepth: 0 };
    if (hasAsks) return { mid: parseFloat(book.asks[0].price), source: "ask_only", range1h: 0, bidDepth: 0, askDepth: parseFloat(book.asks[0].size || "0") };
  } catch {
    // silent
  }
  return { mid: 0, source: "empty", range1h: 0, bidDepth: 0, askDepth: 0 };
}

// ─── Fetch external oracle price for crypto markets ───
const CRYPTO_KEYWORDS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "Up or Down", "5m"];

function isCryptoMarket(question: string): boolean {
  const upper = question.toUpperCase();
  return CRYPTO_KEYWORDS.some(k => upper.includes(k.toUpperCase()));
}

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

// ─── Fetch sponsor/rewards data from CLOB ───
async function getSponsorPool(conditionId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB_HOST}/rewards?conditionId=${conditionId}`);
    if (res.ok) {
      const data = await res.json();
      return parseFloat(data?.rewardsAmount || data?.daily_reward_amount || data?.rewards_daily_rate || "0");
    }
  } catch { /* silent */ }
  return 0;
}

// ─── Score market for sponsor rewards prioritization ───
function scoreMarket(volume24h: number, sponsorPool: number, liquidityDepth: number): number {
  return volume24h * (sponsorPool / 1000 + 1) + liquidityDepth * 0.1;
}

// ─── Dynamic spread calculation ───
function calcDynamicSpread(baseBp: number, sponsorPool: number, range1h: number): { finalBp: number; sponsorAdj: string; volAdj: string } {
  let spread = baseBp;
  let sponsorAdj = "";
  let volAdj = "";

  // Reduce spread for high-reward markets
  if (sponsorPool > 2000) { spread *= 0.5; sponsorAdj = "-50%"; }
  else if (sponsorPool > 1000) { spread *= 0.7; sponsorAdj = "-30%"; }
  else if (sponsorPool > 500) { spread *= 0.85; sponsorAdj = "-15%"; }

  // Increase spread for volatile markets
  if (range1h > 4) { spread *= 1.4; volAdj = "+40%"; }
  else if (range1h > 2) { spread *= 1.2; volAdj = "+20%"; }

  const finalBp = Math.max(5, Math.min(60, Math.round(spread)));
  return { finalBp, sponsorAdj, volAdj };
}

// ─── Skew adjustment ───
function applySkew(
  buyPrice: number, sellPrice: number, orderSize: number,
  netPos: number, maxPos: number, baseBp: number
): { buyPrice: number; sellPrice: number; buySize: number; sellSize: number; pauseBuy: boolean; pauseSell: boolean; skewLabel: string } {
  const spreadDecimal = baseBp / 10000;
  let buySize = orderSize;
  let sellSize = orderSize;
  let pauseBuy = false;
  let pauseSell = false;
  let skewLabel = "none";

  const threshold = maxPos * 0.6;

  if (netPos > threshold) {
    buyPrice -= spreadDecimal * 0.5;
    sellPrice -= spreadDecimal * 0.3;
    buySize = Math.max(1, Math.round(orderSize * 0.5));
    skewLabel = `LONG heavy → buy×0.5/spread×1.5, sell×1.0/spread×0.7`;
  } else if (netPos < -threshold) {
    sellPrice += spreadDecimal * 0.5;
    buyPrice += spreadDecimal * 0.3;
    sellSize = Math.max(1, Math.round(orderSize * 0.5));
    skewLabel = `SHORT heavy → sell×0.5/spread×1.5, buy×1.0/spread×0.7`;
  }

  if (netPos > maxPos) { pauseBuy = true; skewLabel = `PAUSED BUY (pos=${netPos.toFixed(0)}>${maxPos})`; }
  if (netPos < -maxPos) { pauseSell = true; skewLabel = `PAUSED SELL (pos=${netPos.toFixed(0)}<-${maxPos})`; }

  buyPrice = Math.max(0.01, buyPrice);
  sellPrice = Math.min(0.99, sellPrice);

  return { buyPrice, sellPrice, buySize, sellSize, pauseBuy, pauseSell, skewLabel };
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
          sponsoredMarkets: 0, totalMarkets: 0, avgSponsor: 0,
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

        const maxMarkets = params.maxMarkets || 30;
        const baseBp = params.spread || 15;
        const orderSize = params.orderSize || 50;
        const paperTrading = params.paperTrading ?? true;
        const maxPosition = params.maxPosition || 250;
        const minSponsorPool = params.minSponsorPool ?? 0;
        const minLiquidityDepth = params.minLiquidityDepth || 300;
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

        // ── 1. Fetch top 100 active markets from Gamma API ──
        logs.push(`📊 Загрузка рынков (мин. спонсор: $${minSponsorPool}, мин. глубина: $${minLiquidityDepth})...`);
        let allMarkets: any[];
        try {
          allMarkets = await getMarkets(100);
        } catch (e) {
          logs.push(`❌ Ошибка загрузки рынков: ${e.message}`);
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ── 2. Enrich each market with sponsor pool & orderbook depth ──
        const enriched: any[] = [];
        for (const m of allMarkets) {
          if (!m.clobTokenIds || m.clobTokenIds.length === 0) continue;
          const tokenId = m.clobTokenIds[0];

          // Get sponsor pool
          const conditionId = m.conditionId || m.id || "";
          const gammaReward = parseFloat(m.rewardsDaily || m.rewardPoolSize || m.liquidityRewards || "0");
          let sponsorPool = gammaReward;
          if (sponsorPool === 0 && conditionId) {
            sponsorPool = await getSponsorPool(conditionId);
          }

          // Get orderbook depth (quick check)
          const { mid, source, range1h, bidDepth, askDepth } = await getMidPrice(client, tokenId);
          const liquidityDepth = bidDepth + askDepth;

          const volume24h = parseFloat(m.volume24hr || m.volume || "0");
          const score = scoreMarket(volume24h, sponsorPool, liquidityDepth);

          enriched.push({
            ...m,
            tokenId,
            conditionId,
            sponsorPool,
            volume24h,
            liquidityDepth,
            mid,
            midSource: source,
            range1h,
            bidDepth,
            askDepth,
            score,
          });
        }

        // ── 3. Filter & select top-N ──
        // Skip markets with empty orderbook / fallback mid
        const validMarkets = enriched.filter(m => {
          if (m.mid === 0 || m.midSource === "empty") {
            return false;
          }
          return true;
        });

        // Apply filters
        const filtered = validMarkets.filter(m => {
          if (m.sponsorPool < minSponsorPool) return false;
          if (m.liquidityDepth < minLiquidityDepth) return false;
          return true;
        });

        filtered.sort((a, b) => b.score - a.score);
        const selectedMarkets = filtered.slice(0, maxMarkets);

        const sponsoredCount = selectedMarkets.filter(m => m.sponsorPool > 0).length;
        const totalSponsor = selectedMarkets.reduce((s, m) => s + m.sponsorPool, 0);
        const avgSponsor = selectedMarkets.length > 0 ? totalSponsor / selectedMarkets.length : 0;

        logs.push(`✅ Найдено ${validMarkets.length} рынков с ордербуками, ${enriched.filter(m => m.sponsorPool > 0).length} со спонсорами, ${filtered.length} прошли фильтр`);
        logs.push(`🎯 Выбрано ${selectedMarkets.length} рынков (${sponsoredCount} со спонсорами, avg=$${avgSponsor.toFixed(0)})`);

        // ── Log full market list ──
        for (const m of selectedMarkets) {
          const name = (m.question || "Unknown").slice(0, 45);
          logs.push(`  📋 ${name} | vol=$${m.volume24h.toFixed(0)} | sponsor=$${m.sponsorPool.toFixed(0)} | depth=$${m.liquidityDepth.toFixed(0)} | score=${m.score.toFixed(0)}`);
        }

        // ── 4. Get current open orders (for selective update) ──
        let existingOrders: any[] = [];
        if (!paperTrading) {
          try {
            existingOrders = await client.getOpenOrders() || [];
            logs.push(`📋 Текущие ордера: ${existingOrders.length}`);
          } catch (e) {
            logs.push(`⚠️ Не удалось получить ордера: ${e.message}`);
          }
        }

        // ── 5. Process each market ──
        for (const market of selectedMarkets) {
          const tokenId = market.tokenId;
          const negRisk = market.negRisk ?? false;
          const marketId = market.conditionId || market.id || tokenId;
          const marketName = (market.question || "Unknown").slice(0, 50);

          let midPrice = market.mid;
          const priceSource = market.midSource;
          const range1h = market.range1h;

          // FIX #2: skip if mid is fallback (0.5 or empty)
          if (midPrice === 0 || priceSource === "empty" || priceSource === "fallback") {
            logs.push(`  ⏭️ [SKIP] ${marketName}: ${priceSource === "empty" ? "empty orderbook" : "fallback mid"}`);
            continue;
          }

          // External oracle for crypto markets
          if (useExternalOracle && isCryptoMarket(market.question || "")) {
            const extPrice = await getExternalPrice(market.question || "");
            if (extPrice !== null) {
              logs.push(`  🔮 Внешний оракул: ${extPrice} (${priceSource} mid: ${midPrice.toFixed(4)})`);
            }
          }

          // FIX #4: Dynamic spread with visibility
          const { finalBp: dynamicBp, sponsorAdj, volAdj } = calcDynamicSpread(baseBp, market.sponsorPool || 0, range1h);

          // FIX #3: Get net position for skew
          const netPos = await getNetPosition(sb, marketId);

          // Calculate base prices
          const spreadDecimal = dynamicBp / 10000;
          const buyPrice = midPrice - spreadDecimal;
          const sellPrice = midPrice + spreadDecimal;

          // Apply skew
          const skew = applySkew(buyPrice, sellPrice, orderSize, netPos, maxPosition, dynamicBp);

          // FIX #4: Detailed spread log
          const sponsorLabel = market.sponsorPool > 0 ? ` 🏆$${market.sponsorPool.toFixed(0)}` : "";
          let spreadDetail = `${dynamicBp}bp`;
          if (sponsorAdj || volAdj) {
            spreadDetail += ` (base ${baseBp}bp`;
            if (sponsorAdj) spreadDetail += ` sponsor ${sponsorAdj}`;
            if (volAdj) spreadDetail += ` vol ${volAdj}`;
            spreadDetail += `)`;
          }
          logs.push(`📈 ${marketName}: mid=${midPrice.toFixed(4)} (${priceSource}) spread=${spreadDetail}${sponsorLabel}`);

          // FIX #3: Skew log
          if (skew.skewLabel !== "none") {
            logs.push(`  ⚖️ SKEW ACTIVATED: pos=${netPos.toFixed(1)} → ${skew.skewLabel}`);
          } else if (Math.abs(netPos) > 0.01) {
            logs.push(`  📊 Позиция: ${netPos.toFixed(2)} USDC (no skew)`);
          }

          if (paperTrading) {
            // ── Paper mode ──
            if (!skew.pauseBuy) {
              logs.push(`  📝 [PAPER] BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
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
                if (existingBuy) {
                  try {
                    await client.cancelOrder(existingBuy.id);
                    logs.push(`  🗑️ Отменён BUY @ ${parseFloat(existingBuy.price).toFixed(4)}`);
                    await logTrade(sb, { market_name: marketName, market_id: marketId, action: "cancel", side: "BUY", price: parseFloat(existingBuy.price), size: parseFloat(existingBuy.original_size || existingBuy.size || "0"), paper: false });
                  } catch (e) {
                    logs.push(`  ⚠️ Ошибка отмены BUY: ${e.message}`);
                  }
                }
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
          JSON.stringify({
            ok: true, logs, ordersPlaced: orders.length,
            sponsoredMarkets: sponsoredCount,
            totalMarkets: selectedMarkets.length,
            avgSponsor: parseFloat(avgSponsor.toFixed(2)),
          }),
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
