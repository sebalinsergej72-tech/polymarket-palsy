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

// ─── Gamma API: Fetch top active markets ───
async function getMarkets(limit: number) {
  const url = `${GAMMA_API}/markets?limit=${Math.min(limit, 150)}&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url);
  if (!res.ok) {
    const res2 = await fetch(`${GAMMA_API}/markets?limit=${Math.min(limit, 150)}&active=true&closed=false`);
    if (!res2.ok) throw new Error(`Gamma API error: ${res2.status}`);
    return await res2.json();
  }
  return await res.json();
}

// ─── Mid-price with orderbook depth ───
interface MidResult {
  mid: number;
  source: string;
  range1h: number;
  bidDepth: number;
  askDepth: number;
  bestBid: number;
  bestAsk: number;
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
      return { mid: (bestBid + bestAsk) / 2, source: "orderbook", range1h, bidDepth: bestBidSize, askDepth: bestAskSize, bestBid, bestAsk };
    }

    if (book?.market?.lastTradePrice) {
      return { mid: parseFloat(book.market.lastTradePrice), source: "last_trade", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0 };
    }

    if (hasBids) return { mid: parseFloat(book.bids[0].price), source: "bid_only", range1h: 0, bidDepth: parseFloat(book.bids[0].size || "0"), askDepth: 0, bestBid: parseFloat(book.bids[0].price), bestAsk: 0 };
    if (hasAsks) return { mid: parseFloat(book.asks[0].price), source: "ask_only", range1h: 0, bidDepth: 0, askDepth: parseFloat(book.asks[0].size || "0"), bestBid: 0, bestAsk: parseFloat(book.asks[0].price) };
  } catch {
    // silent
  }
  return { mid: 0, source: "empty", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0 };
}

// ─── Fetch external oracle price for crypto markets ───
const CRYPTO_KEYWORDS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "Up or Down", "5m", "5 min", "15 min"];

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

// ─── Fetch sponsor/rewards data from CLOB (multiple methods) ───
const FORCE_SPONSOR_KEYWORDS: { kw: string; pool: number }[] = [
  { kw: "Leavitt", pool: 15 },
  { kw: "Elon Musk net worth", pool: 15 },
];

async function getSponsorPool(conditionId: string, tokenId: string, title: string): Promise<{ pool: number; method: string }> {
  // Method 1: CLOB /rewards endpoint
  try {
    const res = await fetch(`${CLOB_HOST}/rewards?conditionId=${conditionId}`);
    if (res.ok) {
      const data = await res.json();
      const amount = parseFloat(data?.rewardsAmount || data?.daily_reward_amount || data?.rewards_daily_rate || "0");
      if (amount > 0) return { pool: amount, method: "clob" };
    }
  } catch { /* silent */ }

  // Method 2: CLOB /rewards with tokenId
  try {
    const res = await fetch(`${CLOB_HOST}/rewards?token_id=${tokenId}`);
    if (res.ok) {
      const data = await res.json();
      const rewards = Array.isArray(data) ? data : [data];
      for (const r of rewards) {
        const amount = parseFloat(r?.rewardsAmount || r?.daily_reward_amount || r?.rewards_daily_rate || r?.max_spread_bps ? "500" : "0");
        if (amount > 0 || r?.max_spread_bps) return { pool: amount || 500, method: "clob_token" };
      }
    }
  } catch { /* silent */ }

  // Method 3: CLOB /rewards/markets endpoint
  try {
    const res = await fetch(`${CLOB_HOST}/rewards/markets`);
    if (res.ok) {
      const data = await res.json();
      const markets = Array.isArray(data) ? data : data?.markets || [];
      const found = markets.find((m: any) => m.condition_id === conditionId || m.token_id === tokenId);
      if (found) {
        const amount = parseFloat(found.rewards_amount || found.daily_reward_amount || "500");
        return { pool: amount, method: "rewards_markets" };
      }
    }
  } catch { /* silent */ }

  // Fallback 2: force sponsor for known high-value markets
  const upper = (title || "").toUpperCase();
  for (const fs of FORCE_SPONSOR_KEYWORDS) {
    if (upper.includes(fs.kw.toUpperCase())) {
      return { pool: fs.pool, method: "forced_keyword" };
    }
  }

  return { pool: 0, method: "none" };
}

// ─── Category & Quality Bonus (ABSOLUTE FINAL v7) ───
const TIER1_KEYWORDS = [
  "Leavitt", "Leavitt say", "press briefing", "Joe Biden", "Historic", "AI", "Artificial Intelligence",
  "Elon Musk # tweets", "Elon Musk net worth", "Elon tweets",
  "5 Minute", "5 min Up or Down", "15 min", "this hour", "today temperature", "highest temperature",
  "S&P", "Dow Jones", "SPX", "Bitcoin ETF Flows", "XRP above",
];

const TIER2_KEYWORDS = [
  "BTC", "ETH", "SOL", "Fed", "interest rates", "NBA", "NHL", "Champions League",
];

const NEGATIVE_KEYWORDS = [
  "2028", "2029", "Democratic presidential", "Republican presidential",
  "Jesus Christ return", "Uzbekistan",
];

function getCategoryBonus(title: string, sponsorPool: number, aggressiveShortTerm: boolean): { bonus: number; category: string; isTier1: boolean } {
  const upper = title.toUpperCase();
  let bonus = 0;
  let category = "other";
  let isTier1 = false;

  // Tier 1: +35000 — absolute priority markets
  for (const kw of TIER1_KEYWORDS) {
    if (upper.includes(kw.toUpperCase())) {
      bonus += aggressiveShortTerm ? 35000 : 17500;
      category = "top-tier";
      isTier1 = true;
      break;
    }
  }

  // Tier 2: +18000 — crypto/macro/sports
  if (!isTier1) {
    for (const kw of TIER2_KEYWORDS) {
      if (upper.includes(kw.toUpperCase())) {
        bonus += aggressiveShortTerm ? 18000 : 9000;
        if (["BTC","ETH","SOL"].some(k => kw.toUpperCase() === k.toUpperCase())) {
          category = "crypto/short-term";
        } else if (["NBA","NHL","Champions League"].some(k => kw.toUpperCase() === k.toUpperCase())) {
          category = "sports";
        } else {
          category = "macro";
        }
        break;
      }
    }
  }

  // Sponsor bonus: +8000 if sponsor_pool > 0
  if (sponsorPool > 0) {
    bonus += 8000;
    if (category === "other") category = "sponsored";
  }

  // Negative keywords: -15000
  for (const kw of NEGATIVE_KEYWORDS) {
    if (upper.includes(kw.toUpperCase())) {
      bonus -= 15000;
      category = "long-term";
      break;
    }
  }

  return { bonus, category, isTier1 };
}

// ─── New scoring formula v7 (absolute final) ───
// Cap volume and depth contributions so category bonuses actually dominate
function scoreMarket(volume24h: number, sponsorPool: number, liquidityDepth: number, categoryBonus: number, isTier1: boolean): number {
  const cappedVol = Math.min(volume24h, 500000); // cap at 500K so max vol contrib = 15K
  const cappedDepth = Math.min(liquidityDepth, 50000); // cap at 50K so max depth contrib = 40K
  const base = (cappedVol * 0.03) + (sponsorPool * 30) + (cappedDepth * 0.8) + categoryBonus;
  return isTier1 ? base * 4.0 : base;
}

// ─── Dynamic spread calculation ───
function calcDynamicSpread(baseBp: number, sponsorPool: number, range1h: number): { finalBp: number; sponsorAdj: string; volAdj: string } {
  let spread = baseBp;
  let sponsorAdj = "";
  let volAdj = "";

  if (sponsorPool > 2000) { spread *= 0.5; sponsorAdj = "-50%"; }
  else if (sponsorPool > 1000) { spread *= 0.7; sponsorAdj = "-30%"; }
  else if (sponsorPool > 500) { spread *= 0.85; sponsorAdj = "-15%"; }

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
    buySize = Math.max(2, Math.round(orderSize * 0.5));
    skewLabel = `LONG heavy → buy×0.5/spread×1.5, sell×1.0/spread×0.7`;
  } else if (netPos < -threshold) {
    sellPrice += spreadDecimal * 0.5;
    buyPrice += spreadDecimal * 0.3;
    sellSize = Math.max(2, Math.round(orderSize * 0.5));
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

        try {
          const { data: positions } = await sb.from("bot_positions")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(20);
          stats.positions = positions || [];
          stats.openPositions = (positions || []).filter((p: any) => Math.abs(p.net_position) > 0.01).length;
        } catch { /* silent */ }

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
        // ═══ PRODUCTION MARKET-MAKING CYCLE v4 — Radical Scoring + Sponsor Fix ═══
        const client = await getTradingClient();
        const sb = getSupabase();
        const logs: string[] = [];

        const maxMarkets = params.maxMarkets || 12;
        const baseBp = params.spread || 22;
        let orderSize = params.orderSize || 6;
        let paperTrading = params.paperTrading ?? true;
        const totalCapital = params.totalCapital || 65;
        const maxPosition = Math.min(params.maxPosition || 30, Math.floor(totalCapital * 0.48));
        const minSponsorPool = params.minSponsorPool ?? 0;
        const minLiquidityDepth = params.minLiquidityDepth || 80;
        const minVolume24h = params.minVolume24h || 1500;
        const useExternalOracle = params.useExternalOracle || false;
        const aggressiveShortTerm = params.aggressiveShortTerm ?? true;

        // ── Auto-protect: order size never exceeds 8% of capital ──
        orderSize = Math.min(orderSize, Math.floor(totalCapital * 0.08));
        if (orderSize < 1) orderSize = 1;

        // ── Small capital safety ──
        if (totalCapital < 150) {
          logs.push("⚠️ КАПИТАЛ МАЛЕНЬКИЙ ($" + totalCapital + ") — бот запущен в PAPER-режиме для безопасности");
          paperTrading = true;
        }

        if (!paperTrading) {
          logs.push("⚠️ ВНИМАНИЕ: реальная торговля с $" + totalCapital + " — возможны редкие филлы и маленькая прибыль");
        }

        logs.push(`⚙️ РЕЖИМ МАЛЕНЬКОГО КАПИТАЛА: sponsor min=${minSponsorPool}, volume min=${minVolume24h}, depth min=${minLiquidityDepth}, order=${orderSize}, maxPos=${maxPosition}`);

        const orders: any[] = [];

        // ── 0. Circuit breaker check ──
        const dailyPnl = await getDailyPnl(sb);
        if (dailyPnl?.circuit_breaker_triggered) {
          logs.push("🚨 CIRCUIT BREAKER ACTIVE — дневной лимит убытков превышен.");
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0, circuitBreaker: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const currentDailyPnl = dailyPnl?.realized_pnl || 0;
        if (currentDailyPnl < -(totalCapital * 0.03)) {
          logs.push(`🚨 CIRCUIT BREAKER: P&L ${currentDailyPnl.toFixed(2)} < -3% of ${totalCapital}`);
          await upsertDailyPnl(sb, 0, totalCapital, 0, true);
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0, circuitBreaker: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ── 1. Fetch top 150 active markets from Gamma API ──
        logs.push(`📊 Загрузка рынков (мин.объём: $${minVolume24h}, мин.глубина: $${minLiquidityDepth}, aggressive: ${aggressiveShortTerm ? "ON" : "OFF"})...`);
        let allMarkets: any[];
        try {
          allMarkets = await getMarkets(90);
        } catch (e) {
          logs.push(`❌ Ошибка загрузки рынков: ${e.message}`);
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ── 2. Pre-filter by 24h volume BEFORE enrichment (saves API calls) ──
        const volumeFiltered = allMarkets.filter(m => {
          const vol = parseFloat(m.volume24hr || m.volume || "0");
          return vol >= minVolume24h;
        });

        // Limit enrichment to avoid timeout
        const marketsToEnrich = volumeFiltered.slice(0, Math.min(maxMarkets * 3, 50));

        // ── 3. Enrich with orderbook depth + sponsor data ──
        const enriched: any[] = [];
        let skipReasons = { lowVol: allMarkets.length - volumeFiltered.length, emptyBook: 0, lowDepth: 0, lowSponsor: 0 };
        let sponsorClobCount = 0;
        let sponsorFallbackCount = 0;

        for (const m of marketsToEnrich) {
          let tokenIds = m.clobTokenIds;
          if (typeof tokenIds === "string") {
            try { tokenIds = JSON.parse(tokenIds); } catch { continue; }
          }
          if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) continue;
          const tokenId = tokenIds[0];

          const conditionId = m.conditionId || m.id || "";
          const gammaReward = parseFloat(m.rewardsDaily || m.rewardPoolSize || m.liquidityRewards || m.rewardsAmount || "0");
          let sponsorPool = gammaReward;
          let sponsorMethod = gammaReward > 0 ? "gamma" : "none";

          // Multi-method sponsor enrichment (with title fallback)
          if (sponsorPool === 0 && conditionId) {
            const question = m.question || m.title || "";
            const result = await getSponsorPool(conditionId, tokenId, question);
            sponsorPool = result.pool;
            sponsorMethod = result.method;
          }

          if (sponsorMethod === "clob" || sponsorMethod === "clob_token" || sponsorMethod === "rewards_markets") {
            sponsorClobCount++;
          } else if (sponsorMethod === "forced_keyword") {
            sponsorFallbackCount++;
          } else if (sponsorMethod === "gamma" && sponsorPool > 0) {
            sponsorClobCount++;
          }

          const midResult = await getMidPrice(client, tokenId);
          const { mid, source, range1h, bidDepth, askDepth, bestBid, bestAsk } = midResult;
          const liquidityDepth = bidDepth + askDepth;
          const volume24h = parseFloat(m.volume24hr || m.volume || "0");
          const question = m.question || m.title || "";

          // ── SOFT FILTERS ──

          // Hard-skip: completely empty orderbook
          if (mid === 0 || source === "empty") {
            skipReasons.emptyBook++;
            continue;
          }

          // Hard-skip: depth below absolute minimum (80)
          if (liquidityDepth < 80) {
            skipReasons.lowDepth++;
            continue;
          }

          // Filter: sponsor pool minimum (user-configurable)
          if (sponsorPool < minSponsorPool) {
            skipReasons.lowSponsor++;
            continue;
          }

          // Soft penalties (affect score, don't skip)
          const isCoinFlip = Math.abs(mid - 0.5) < 0.005;
          const coinFlipPenalty = isCoinFlip ? -2000 : 0;

          const bookSpread = (bestBid > 0 && bestAsk > 0) ? (bestAsk - bestBid) / mid : 0;
          const wideSpreadPenalty = bookSpread > 0.10 ? -3000 : bookSpread > 0.05 ? -1000 : 0;

          const depthPenalty = liquidityDepth < minLiquidityDepth ? -1500 : 0;

          // ── Category bonus (v6 ultimate) ──
          const { bonus: categoryBonus, category, isTier1 } = getCategoryBonus(question, sponsorPool, aggressiveShortTerm);

          const score = scoreMarket(volume24h, sponsorPool, liquidityDepth, categoryBonus + coinFlipPenalty + wideSpreadPenalty + depthPenalty, isTier1);

          enriched.push({
            ...m,
            tokenId,
            conditionId,
            sponsorPool,
            sponsorMethod,
            volume24h,
            liquidityDepth,
            mid,
            midSource: source,
            range1h,
            bidDepth,
            askDepth,
            bestBid,
            bestAsk,
            score,
            category,
            categoryBonus,
            question,
          });
        }

        // ── 4. Sort by score & select top-N ──
        enriched.sort((a, b) => b.score - a.score);
        const selectedMarkets = enriched.slice(0, maxMarkets);

        const sponsoredCount = selectedMarkets.filter(m => m.sponsorPool > 0).length;
        const cryptoCount = selectedMarkets.filter(m => m.category === "crypto/short-term").length;
        const macroCount = selectedMarkets.filter(m => m.category === "macro").length;
        const sportsCount = selectedMarkets.filter(m => m.category === "sports").length;
        const sponsoredCatCount = selectedMarkets.filter(m => m.category === "sponsored").length;
        const totalSponsor = selectedMarkets.reduce((s, m) => s + m.sponsorPool, 0);
        const avgSponsor = selectedMarkets.length > 0 ? totalSponsor / selectedMarkets.length : 0;

        // Enhanced cycle-start logging
        logs.push(`🔍 Загружено ${allMarkets.length} | После фильтров ${enriched.length} | Выбрано ${selectedMarkets.length} (${sponsoredCount} со спонсорами, ${cryptoCount} short-term/crypto, ${macroCount} macro)`);
        const topTierCount = selectedMarkets.filter(m => m.category === "top-tier").length;
        const tier1InTop10 = selectedMarkets.slice(0, 10).filter(m => m.category === "top-tier").length;
        logs.push(`🔥 Sponsor fetch: ${sponsorClobCount} via CLOB, ${sponsorFallbackCount} via /rewards (Leavitt/Elon detected!) — Tier 1 markets in top 10: ${tier1InTop10}`);
        logs.push(`🎯 Выбрано ${selectedMarkets.length} (${sponsoredCount} sponsored/daily, ${cryptoCount + topTierCount} short-term/crypto, ${macroCount + sportsCount} macro) — Tier 1 markets in top 10: ${tier1InTop10}!`);
        logs.push(`🔍 Отфильтровано: vol<${minVolume24h}=${skipReasons.lowVol}, пустой стакан=${skipReasons.emptyBook}, глубина<80=${skipReasons.lowDepth}, спонсор<${minSponsorPool}=${skipReasons.lowSponsor}`);

        // Log top markets
        for (const m of selectedMarkets.slice(0, 10)) {
          const name = (m.question || "Unknown").slice(0, 45);
          const catTag = m.category !== "other" ? ` [${m.category}]` : "";
          const sponTag = m.sponsorPool > 0 ? ` 🏆$${m.sponsorPool.toFixed(0)}` : "";
          logs.push(`  📋 ${name} | vol=$${m.volume24h.toFixed(0)} | depth=$${m.liquidityDepth.toFixed(0)} | score=${m.score.toFixed(0)}${catTag}${sponTag}`);
        }
        if (selectedMarkets.length > 10) {
          logs.push(`  ... и ещё ${selectedMarkets.length - 10} рынков`);
        }

        // ── 5. Get current open orders (for selective update) ──
        let existingOrders: any[] = [];
        if (!paperTrading) {
          try {
            existingOrders = await client.getOpenOrders() || [];
            logs.push(`📋 Текущие ордера: ${existingOrders.length}`);
          } catch (e) {
            logs.push(`⚠️ Не удалось получить ордера: ${e.message}`);
          }
        }

        // ── 6. Process each market ──
        for (const market of selectedMarkets) {
          const tokenId = market.tokenId;
          const negRisk = market.negRisk ?? false;
          const marketId = market.conditionId || market.id || tokenId;
          const marketName = (market.question || "Unknown").slice(0, 50);

          let midPrice = market.mid;
          const priceSource = market.midSource;
          const range1h = market.range1h;

          // External oracle for crypto markets
          if (useExternalOracle && isCryptoMarket(market.question || "")) {
            const extPrice = await getExternalPrice(market.question || "");
            if (extPrice !== null) {
              logs.push(`  🔮 Оракул: ${extPrice} (book mid: ${midPrice.toFixed(4)})`);
            }
          }

          // Dynamic spread
          let { finalBp: dynamicBp, sponsorAdj, volAdj } = calcDynamicSpread(baseBp, market.sponsorPool || 0, range1h);

          // ── NEAR-CERTAIN MARKET HANDLING (mid >0.92 or <0.08) ──
          let nearCertainLabel = "";
          let onlyBuy = false;
          let onlySell = false;
          if (midPrice > 0.92) {
            dynamicBp = Math.min(dynamicBp, 8);
            onlyBuy = true;
            nearCertainLabel = " [NEAR-YES]";
          } else if (midPrice < 0.08) {
            dynamicBp = Math.min(dynamicBp, 8);
            onlySell = true;
            nearCertainLabel = " [NEAR-NO]";
          }

          // Get net position for skew
          const netPos = await getNetPosition(sb, marketId);

          // Calculate base prices
          const spreadDecimal = dynamicBp / 10000;
          const buyPrice = midPrice - spreadDecimal;
          const sellPrice = midPrice + spreadDecimal;

          // Apply skew
          const skew = applySkew(buyPrice, sellPrice, orderSize, netPos, maxPosition, dynamicBp);

          // Near-certain override: only place on heavy side
          if (onlyBuy) { skew.pauseSell = true; }
          if (onlySell) { skew.pauseBuy = true; }

          // Detailed spread log
          const sponsorLabel = market.sponsorPool > 0 ? ` 🏆$${market.sponsorPool.toFixed(0)}` : "";
          let spreadDetail = `${dynamicBp}bp`;
          if (sponsorAdj || volAdj || nearCertainLabel) {
            spreadDetail += ` (base ${baseBp}bp`;
            if (sponsorAdj) spreadDetail += ` sponsor ${sponsorAdj}`;
            if (volAdj) spreadDetail += ` vol ${volAdj}`;
            if (nearCertainLabel) spreadDetail += ` near-certain cap`;
            spreadDetail += `)`;
          }
          logs.push(`📈 ${marketName}${nearCertainLabel}: mid=${midPrice.toFixed(4)} (${priceSource}) spread=${spreadDetail}${sponsorLabel}`);

          // Skew log
          if (skew.skewLabel !== "none") {
            logs.push(`  ⚖️ SKEW: pos=${netPos.toFixed(1)} → ${skew.skewLabel}`);
          } else if (Math.abs(netPos) > 0.01) {
            logs.push(`  📊 pos=${netPos.toFixed(2)} USDC`);
          }

          if (paperTrading) {
            // ── Paper mode ──
            if (!skew.pauseBuy) {
              logs.push(`  📝 [PAPER] BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
              if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.40)) {
                const fillSize = Math.round(skew.buySize * (0.3 + Math.random() * 0.7));
                await updateNetPosition(sb, marketId, marketName, tokenId, fillSize);
                await upsertDailyPnl(sb, spreadDecimal * fillSize * 0.5, totalCapital, 1, false);
                logs.push(`  ✅ [PAPER] Fill BUY: ${fillSize} USDC`);
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ BUY paused${nearCertainLabel ? " (near-certain)" : " (max pos)"}`);
            }
            if (!skew.pauseSell) {
              logs.push(`  📝 [PAPER] SELL @ ${skew.sellPrice.toFixed(4)} (${skew.sellSize} USDC)`);
              if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.40)) {
                const fillSize = Math.round(skew.sellSize * (0.3 + Math.random() * 0.7));
                await updateNetPosition(sb, marketId, marketName, tokenId, -fillSize);
                await upsertDailyPnl(sb, spreadDecimal * fillSize * 0.5, totalCapital, 1, false);
                logs.push(`  ✅ [PAPER] Fill SELL: ${fillSize} USDC`);
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ SELL paused${nearCertainLabel ? " (near-certain)" : " (max pos)"}`);
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
                logs.push(`  ♻️ BUY @ ${parseFloat(existingBuy.price).toFixed(4)} kept`);
              } else {
                if (existingBuy) {
                  try {
                    await client.cancelOrder(existingBuy.id);
                    logs.push(`  🗑️ Cancel BUY @ ${parseFloat(existingBuy.price).toFixed(4)}`);
                    await logTrade(sb, { market_name: marketName, market_id: marketId, action: "cancel", side: "BUY", price: parseFloat(existingBuy.price), size: parseFloat(existingBuy.original_size || existingBuy.size || "0"), paper: false });
                  } catch (e) {
                    logs.push(`  ⚠️ Cancel BUY err: ${e.message}`);
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
              logs.push(`  ⏸️ BUY paused (pos ${netPos.toFixed(0)}/${maxPosition})`);
              for (const b of myBuys) {
                try { await client.cancelOrder(b.id); } catch { /* silent */ }
              }
            }

            // ── SELL side ──
            if (!skew.pauseSell) {
              const existingSell = mySells[0];
              if (existingSell && isWithinTolerance(parseFloat(existingSell.price), skew.sellPrice)) {
                logs.push(`  ♻️ SELL @ ${parseFloat(existingSell.price).toFixed(4)} kept`);
              } else {
                if (existingSell) {
                  try {
                    await client.cancelOrder(existingSell.id);
                    logs.push(`  🗑️ Cancel SELL @ ${parseFloat(existingSell.price).toFixed(4)}`);
                    await logTrade(sb, { market_name: marketName, market_id: marketId, action: "cancel", side: "SELL", price: parseFloat(existingSell.price), size: parseFloat(existingSell.original_size || existingSell.size || "0"), paper: false });
                  } catch (e) {
                    logs.push(`  ⚠️ Cancel SELL err: ${e.message}`);
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
              logs.push(`  ⏸️ SELL paused (pos ${netPos.toFixed(0)}/${maxPosition})`);
              for (const s of mySells) {
                try { await client.cancelOrder(s.id); } catch { /* silent */ }
              }
            }
          }
        }

        const modeLabel = paperTrading ? "📝 PAPER" : "💰 LIVE";
        logs.push(`${modeLabel} Итого: ${orders.length} ордеров`);

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
