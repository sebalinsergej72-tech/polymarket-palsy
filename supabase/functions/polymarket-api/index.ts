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
const CLIENT_VERSION = "v3-ticksize-geoblock";

// ─── Helper: normalize error messages ───
function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ─── Supabase Admin Client ───
function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ─── Trading Client (env-driven signatureType & funder) ───
function getSignatureType(): number {
  const raw = Deno.env.get("POLYMARKET_SIGNATURE_TYPE");
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  if ([0, 1, 2].includes(parsed)) return parsed;
  console.warn(`Invalid POLYMARKET_SIGNATURE_TYPE="${raw}", fallback to 0 (EOA)`);
  return 0;
}

function getFunder(): string | undefined {
  return Deno.env.get("POLYMARKET_FUNDER") || undefined;
}

function getRuntimeIdentity() {
  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  const signer = new Wallet(privateKey);
  const signatureType = getSignatureType();
  const funder = getFunder();
  const expectedPortfolioAddress = signatureType === 0 ? signer.address : (funder || null);
  const apiKey = cachedCreds?.apiKey || cachedCreds?.key || null;
  return {
    signerAddress: signer.address,
    signatureType,
    funder: funder || null,
    expectedPortfolioAddress,
    apiKeyPrefix: apiKey ? String(apiKey).slice(0, 12) + "..." : null,
  };
}

function compactOrder(order: any) {
  return {
    id: order?.id || order?.orderID || order?.orderId || null,
    asset_id: order?.asset_id || order?.assetId || order?.tokenID || order?.tokenId || null,
    side: order?.side || null,
    price: order?.price || null,
    size: order?.original_size || order?.size || null,
    status: order?.status || order?.state || null,
  };
}

function toAuditNote(event: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    event,
    ts: new Date().toISOString(),
    ...payload,
  });
}

async function getTradingClient() {
  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  if (cachedClient) return cachedClient;

  const signer = new Wallet(privateKey);
  const signatureType = getSignatureType();
  const funder = getFunder();

  console.log(`🔑 Деривация API credentials... signer: ${signer.address}, signatureType: ${signatureType}, funder: ${funder || "none (EOA)"}`);

  // Step 1: temp client to derive API creds
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  cachedCreds = creds;
  console.log("✅ API creds получены:", JSON.stringify({ apiKey: (creds.apiKey || creds.key || "unknown").slice(0, 12) + "..." }));

  // Step 2: main client with signatureType and funder from env
  cachedClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    creds,
    signatureType,
    funder
  );
  console.log(`✅ ClobClient создан с signature_type=${signatureType}, funder=${funder || "none"}`);
  return cachedClient;
}

// ─── Tick size helpers ───
function getTickSize(book: any): number {
  const raw = book?.tick_size || book?.tickSize || book?.market?.tick_size || book?.market?.tickSize;
  if (raw) {
    const parsed = parseFloat(String(raw));
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 0.01; // fallback
}

function floorToTick(price: number, tick: number): number {
  return Math.floor(price / tick) * tick;
}

function ceilToTick(price: number, tick: number): number {
  return Math.ceil(price / tick) * tick;
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
  tickSize: number;
}

async function getMidPrice(client: any, tokenId: string): Promise<MidResult> {
  try {
    const book = await client.getOrderBook(tokenId);
    const tick = getTickSize(book);
    const hasBids = book?.bids?.length > 0;
    const hasAsks = book?.asks?.length > 0;

    if (hasBids && hasAsks) {
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk = parseFloat(book.asks[0].price);
      const bestBidSize = parseFloat(book.bids[0].size || "0");
      const bestAskSize = parseFloat(book.asks[0].size || "0");
      const range1h = (bestAsk - bestBid) / ((bestBid + bestAsk) / 2) * 100;
      return { mid: (bestBid + bestAsk) / 2, source: "orderbook", range1h, bidDepth: bestBidSize, askDepth: bestAskSize, bestBid, bestAsk, tickSize: tick };
    }

    if (book?.market?.lastTradePrice) {
      return { mid: parseFloat(book.market.lastTradePrice), source: "last_trade", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0, tickSize: tick };
    }

    if (hasBids) return { mid: parseFloat(book.bids[0].price), source: "bid_only", range1h: 0, bidDepth: parseFloat(book.bids[0].size || "0"), askDepth: 0, bestBid: parseFloat(book.bids[0].price), bestAsk: 0, tickSize: tick };
    if (hasAsks) return { mid: parseFloat(book.asks[0].price), source: "ask_only", range1h: 0, bidDepth: 0, askDepth: parseFloat(book.asks[0].size || "0"), bestBid: 0, bestAsk: parseFloat(book.asks[0].price), tickSize: tick };
  } catch {
    // silent
  }
  return { mid: 0, source: "empty", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0, tickSize: 0.01 };
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

  for (const kw of TIER1_KEYWORDS) {
    if (upper.includes(kw.toUpperCase())) {
      bonus += aggressiveShortTerm ? 35000 : 17500;
      category = "top-tier";
      isTier1 = true;
      break;
    }
  }

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

  if (sponsorPool > 0) {
    bonus += 8000;
    if (category === "other") category = "sponsored";
  }

  for (const kw of NEGATIVE_KEYWORDS) {
    if (upper.includes(kw.toUpperCase())) {
      bonus -= 15000;
      category = "long-term";
      break;
    }
  }

  return { bonus, category, isTier1 };
}

function scoreMarket(volume24h: number, sponsorPool: number, liquidityDepth: number, categoryBonus: number, isTier1: boolean): number {
  const cappedVol = Math.min(volume24h, 500000);
  const cappedDepth = Math.min(liquidityDepth, 50000);
  const base = (cappedVol * 0.03) + (sponsorPool * 30) + (cappedDepth * 0.8) + categoryBonus;
  return isTier1 ? base * 4.0 : base;
}

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

function applySkew(
  buyPrice: number, sellPrice: number, orderSize: number,
  netPos: number, maxPos: number, baseBp: number,
  minPrice: number, maxPrice: number
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

  buyPrice = Math.max(minPrice, Math.min(maxPrice, buyPrice));
  sellPrice = Math.max(minPrice, Math.min(maxPrice, sellPrice));

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
      case "check_geoblock": {
        try {
          const res = await fetch("https://polymarket.com/api/geoblock");
          const data = await res.json();
          return new Response(
            JSON.stringify({ ok: true, geoblock: data, httpStatus: res.status }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ ok: false, error: getErrorMessage(e) }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

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

      case "order_audit": {
        const client = await getTradingClient();
        const sb = getSupabase();
        const limit = Math.max(1, Math.min(Number(params.limit || 50), 200));
        const response: Record<string, unknown> = {
          ok: true,
          serverTime: new Date().toISOString(),
          clob: { openOrdersCount: 0, openOrdersSample: [] },
          db: { recentLiveEvents: [] },
        };
        try {
          const openOrders = await client.getOpenOrders();
          response.clob = {
            openOrdersCount: openOrders?.length || 0,
            openOrdersSample: (openOrders || []).slice(0, 30).map(compactOrder),
          };
        } catch (e) { response.clob = { error: getErrorMessage(e) }; }
        try {
          const { data } = await sb
            .from("bot_trade_log")
            .select("timestamp,market_name,market_id,action,side,price,size,paper,notes")
            .eq("paper", false)
            .order("timestamp", { ascending: false })
            .limit(limit);
          response.db = { recentLiveEvents: data || [] };
        } catch (e) { response.db = { error: getErrorMessage(e) }; }
        return new Response(
          JSON.stringify(response),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "whoami": {
        const client = await getTradingClient();
        const sb = getSupabase();
        const identity = getRuntimeIdentity();
        const diagnostics: Record<string, unknown> = {
          version: CLIENT_VERSION,
          serverTime: new Date().toISOString(),
          identity,
          geoblock: null,
          clob: { openOrdersCount: 0, openOrdersSample: [] },
          db: { recentLiveActions: [] },
        };
        try {
          const res = await fetch("https://polymarket.com/api/geoblock");
          diagnostics.geoblock = { status: res.status, ...(await res.json()) };
        } catch (e) { diagnostics.geoblock = { error: getErrorMessage(e) }; }
        try {
          const openOrders = await client.getOpenOrders();
          diagnostics.clob = {
            openOrdersCount: openOrders?.length || 0,
            openOrdersSample: (openOrders || []).slice(0, 20).map(compactOrder),
          };
        } catch (e) { diagnostics.clob = { error: getErrorMessage(e) }; }
        try {
          const { data: liveActions } = await sb
            .from("bot_trade_log")
            .select("timestamp,market_name,market_id,action,side,price,size,paper")
            .eq("paper", false)
            .order("timestamp", { ascending: false })
            .limit(30);
          diagnostics.db = { recentLiveActions: liveActions || [] };
        } catch (e) { diagnostics.db = { error: getErrorMessage(e) }; }
        return new Response(
          JSON.stringify({ ok: true, diagnostics }),
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
          console.error("Error fetching orders:", getErrorMessage(e));
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

      case "reset_positions": {
        const sb = getSupabase();
        await sb.from("bot_positions").delete().neq("market_id", "dummy");
        return new Response(
          JSON.stringify({ ok: true, message: "🗑️ Все позиции сброшены до 0" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "cancel_all": {
        const client = await getTradingClient();
        try {
          const result = await client.cancelAll();
          return new Response(JSON.stringify({ ok: true, result }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: getErrorMessage(e) }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
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
        // ═══ PRODUCTION MARKET-MAKING CYCLE v5 — TickSize + Geoblock + Error Normalization ═══
        const client = await getTradingClient();
        const sb = getSupabase();
        const logs: string[] = [];

        const maxMarkets = params.maxMarkets || 12;
        const baseBp = params.spread || 22;
        let orderSize = params.orderSize || 6;
        const liveTrading = params.liveTrading ?? false;
        let paperTrading = !liveTrading;
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

        logs.push(`🔄 РЕЖИМ: ${paperTrading ? '📝 PAPER' : '💰 LIVE TRADING'}`);

        // Balance check for live mode
        if (!paperTrading) {
          try {
            const balanceInfo = await client.getBalance?.();
            if (balanceInfo !== undefined) {
              logs.push(`💰 Баланс USDC внутри Polymarket: ${typeof balanceInfo === 'object' ? JSON.stringify(balanceInfo) : balanceInfo}`);
            }
          } catch (e) {
            logs.push(`⚠️ Не удалось получить баланс: ${getErrorMessage(e)}`);
          }
        }

        if (!paperTrading && totalCapital < 150) {
          logs.push("⚠️ ВНИМАНИЕ: LIVE торговля с маленьким капиталом $" + totalCapital + " — возможны редкие филлы и маленькая прибыль");
        }

        if (paperTrading) {
          logs.push(`🧪 PAPER MODE: позиции будут ограничиваться maxPosition=${maxPosition} и totalCapital=${totalCapital}`);
        }

        logs.push(`⚙️ Параметры: sponsor min=${minSponsorPool}, volume min=${minVolume24h}, depth min=${minLiquidityDepth}, order=${orderSize}, maxPos=${maxPosition}`);

        const { error: resetError } = await sb
          .from("bot_positions")
          .update({ net_position: 0 })
          .gt("net_position", maxPosition * 1.5);
        if (!resetError) logs.push(`🔄 Авто-сброс старых огромных позиций (>${maxPosition * 1.5} USDC)`);

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

        // ── 1. Fetch top 90 active markets from Gamma API ──
        logs.push(`📊 Загрузка рынков (мин.объём: $${minVolume24h}, мин.глубина: $${minLiquidityDepth}, aggressive: ${aggressiveShortTerm ? "ON" : "OFF"})...`);
        let allMarkets: any[];
        try {
          allMarkets = await getMarkets(90);
        } catch (e) {
          logs.push(`❌ Ошибка загрузки рынков: ${getErrorMessage(e)}`);
          return new Response(
            JSON.stringify({ ok: true, logs, ordersPlaced: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // ── 2. Pre-filter by 24h volume BEFORE enrichment ──
        const volumeFiltered = allMarkets.filter(m => {
          const vol = parseFloat(m.volume24hr || m.volume || "0");
          return vol >= minVolume24h;
        });

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
          const { mid, source, range1h, bidDepth, askDepth, bestBid, bestAsk, tickSize } = midResult;
          const liquidityDepth = bidDepth + askDepth;
          const volume24h = parseFloat(m.volume24hr || m.volume || "0");
          const question = m.question || m.title || "";

          if (mid === 0 || source === "empty") {
            skipReasons.emptyBook++;
            continue;
          }

          if (liquidityDepth < 80) {
            skipReasons.lowDepth++;
            continue;
          }

          if (sponsorPool < minSponsorPool) {
            skipReasons.lowSponsor++;
            continue;
          }

          const isCoinFlip = Math.abs(mid - 0.5) < 0.005;
          const coinFlipPenalty = isCoinFlip ? -2000 : 0;

          const bookSpread = (bestBid > 0 && bestAsk > 0) ? (bestAsk - bestBid) / mid : 0;
          const wideSpreadPenalty = bookSpread > 0.10 ? -3000 : bookSpread > 0.05 ? -1000 : 0;

          const depthPenalty = liquidityDepth < minLiquidityDepth ? -1500 : 0;

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
            tickSize,
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

        logs.push(`🔍 Загружено ${allMarkets.length} | После фильтров ${enriched.length} | Выбрано ${selectedMarkets.length} (${sponsoredCount} со спонсорами, ${cryptoCount} short-term/crypto, ${macroCount} macro)`);
        const topTierCount = selectedMarkets.filter(m => m.category === "top-tier").length;
        const tier1InTop10 = selectedMarkets.slice(0, 10).filter(m => m.category === "top-tier").length;
        logs.push(`🔥 Sponsor fetch: ${sponsorClobCount} via CLOB, ${sponsorFallbackCount} via /rewards (Leavitt/Elon detected!) — Tier 1 markets in top 10: ${tier1InTop10}`);
        logs.push(`🎯 Выбрано ${selectedMarkets.length} (${sponsoredCount} sponsored/daily, ${cryptoCount + topTierCount} short-term/crypto, ${macroCount + sportsCount} macro) — Tier 1 markets in top 10: ${tier1InTop10}!`);
        logs.push(`🔍 Отфильтровано: vol<${minVolume24h}=${skipReasons.lowVol}, пустой стакан=${skipReasons.emptyBook}, глубина<80=${skipReasons.lowDepth}, спонсор<${minSponsorPool}=${skipReasons.lowSponsor}`);

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
            logs.push(`⚠️ Не удалось получить ордера: ${getErrorMessage(e)}`);
          }
        }

        // ── 6. Process each market ──
        for (const market of selectedMarkets) {
          const tokenId = market.tokenId;
          const negRisk = market.negRisk ?? false;
          const marketId = market.conditionId || market.id || tokenId;
          const marketName = (market.question || "Unknown").slice(0, 50);
          const tickSize = market.tickSize || 0.01;
          const tickSizeStr = String(tickSize);
          const minPrice = tickSize;
          const maxPrice = Math.max(minPrice, 1 - tickSize);

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

          // ── NEAR-CERTAIN MARKET HANDLING ──
          let nearCertainLabel = "";
          let onlyBuy = false;
          let onlySell = false;
          if (midPrice > 0.92) {
            dynamicBp = Math.min(dynamicBp, 5);
            onlyBuy = true;
            nearCertainLabel = " [NEAR-YES]";
          } else if (midPrice < 0.08) {
            dynamicBp = Math.min(dynamicBp, 5);
            onlySell = true;
            nearCertainLabel = " [NEAR-NO]";
          }

          // Get net position for skew
          const netPos = await getNetPosition(sb, marketId);

          // Calculate base prices
          const spreadDecimal = dynamicBp / 10000;
          const rawBuyPrice = midPrice - spreadDecimal;
          const rawSellPrice = midPrice + spreadDecimal;

          // Apply skew
          const skew = applySkew(rawBuyPrice, rawSellPrice, orderSize, netPos, maxPosition, dynamicBp, minPrice, maxPrice);

          // Near-certain override
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
          logs.push(`📈 ${marketName}${nearCertainLabel}: mid=${midPrice.toFixed(4)} (${priceSource}) spread=${spreadDetail} tick=${tickSizeStr}${sponsorLabel}`);

          if (skew.skewLabel !== "none") {
            logs.push(`  ⚖️ SKEW: pos=${netPos.toFixed(1)} → ${skew.skewLabel}`);
          } else if (Math.abs(netPos) > 0.01) {
            logs.push(`  📊 pos=${netPos.toFixed(2)} USDC`);
          }

          if (paperTrading) {
            // ── Paper mode with position limits ──
            if (!skew.pauseBuy) {
              logs.push(`  📝 [PAPER] BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
              if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.40)) {
                const safeFillSize = Math.min(skew.buySize, maxPosition - Math.abs(netPos));
                const actualFill = Math.max(0, Math.round(safeFillSize * (0.3 + Math.random() * 0.7)));
                const newPos = netPos + actualFill;
                if (actualFill <= 0 || Math.abs(newPos) > maxPosition) {
                  logs.push(`  ⛔ [PAPER] Skip fill BUY — would exceed maxPosition (${Math.abs(newPos).toFixed(0)} > ${maxPosition})`);
                } else {
                  await updateNetPosition(sb, marketId, marketName, tokenId, actualFill);
                  await upsertDailyPnl(sb, spreadDecimal * actualFill * 0.5, totalCapital, 1, false);
                  logs.push(`  ✅ [PAPER] Fill BUY: ${actualFill} USDC (pos: ${newPos.toFixed(0)}/${maxPosition})`);
                }
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ BUY paused${nearCertainLabel ? " (near-certain)" : " (max pos)"}`);
            }
            if (!skew.pauseSell) {
              logs.push(`  📝 [PAPER] SELL @ ${skew.sellPrice.toFixed(4)} (${skew.sellSize} USDC)`);
              if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.40)) {
                const safeFillSize = Math.min(skew.sellSize, maxPosition - Math.abs(netPos));
                const actualFill = Math.max(0, Math.round(safeFillSize * (0.3 + Math.random() * 0.7)));
                const newPos = netPos - actualFill;
                if (actualFill <= 0 || Math.abs(newPos) > maxPosition) {
                  logs.push(`  ⛔ [PAPER] Skip fill SELL — would exceed maxPosition (${Math.abs(newPos).toFixed(0)} > ${maxPosition})`);
                } else {
                  await updateNetPosition(sb, marketId, marketName, tokenId, -actualFill);
                  await upsertDailyPnl(sb, spreadDecimal * actualFill * 0.5, totalCapital, 1, false);
                  logs.push(`  ✅ [PAPER] Fill SELL: ${actualFill} USDC (pos: ${newPos.toFixed(0)}/${maxPosition})`);
                }
              }
              orders.push({ paper: true });
            } else {
              logs.push(`  ⏸️ SELL paused${nearCertainLabel ? " (near-certain)" : " (max pos)"}`);
            }
          } else {
            // ── LIVE mode: Selective Order Update with tick-aligned prices ──
            const decimals = (tickSizeStr.split(".")[1] || "").length;

            let safeBuyPrice = floorToTick(Math.max(minPrice, Math.min(maxPrice, skew.buyPrice)), tickSize);
            let safeSellPrice = ceilToTick(Math.max(minPrice, Math.min(maxPrice, skew.sellPrice)), tickSize);

            safeBuyPrice = Number(safeBuyPrice.toFixed(decimals));
            safeSellPrice = Number(safeSellPrice.toFixed(decimals));

            // Validate buy < sell; skip market if not
            if (!skew.pauseBuy && !skew.pauseSell && safeBuyPrice >= safeSellPrice) {
              logs.push(`  ⏭️ [SKIP] ${marketName}: invalid grid after tick align buy=${safeBuyPrice} sell=${safeSellPrice} tick=${tickSizeStr}`);
              continue;
            }

            const myBuys = existingOrders.filter(
              (o: any) => o.asset_id === tokenId && (o.side === "BUY" || o.side === "buy")
            );
            const mySells = existingOrders.filter(
              (o: any) => o.asset_id === tokenId && (o.side === "SELL" || o.side === "sell")
            );

            // ── BUY side ──
            if (!skew.pauseBuy) {
              const existingBuy = myBuys[0];
              if (existingBuy && isWithinTolerance(parseFloat(existingBuy.price), safeBuyPrice)) {
                logs.push(`  ♻️ BUY @ ${parseFloat(existingBuy.price).toFixed(4)} kept`);
              } else {
                if (existingBuy) {
                  try {
                    await client.cancelOrder(existingBuy.id);
                    logs.push(`  🗑️ Cancel BUY @ ${parseFloat(existingBuy.price).toFixed(4)}`);
                    await logTrade(sb, {
                      market_name: marketName, market_id: marketId, action: "cancel", side: "BUY",
                      price: parseFloat(existingBuy.price), size: parseFloat(existingBuy.original_size || existingBuy.size || "0"),
                      paper: false, notes: toAuditNote("cancel", { orderId: existingBuy.id || null, reason: "replace_buy" }),
                    });
                  } catch (e) {
                    logs.push(`  ⚠️ Cancel BUY err: ${getErrorMessage(e)}`);
                  }
                }
                try {
                  const t0 = Date.now();
                  console.log(`🚀 Отправляем реальный BUY ордер: token=${tokenId}, price=${safeBuyPrice}, size=${skew.buySize}, tick=${tickSizeStr}`);
                  const buyOrder = await client.createAndPostOrder(
                    { tokenID: tokenId, price: safeBuyPrice, size: skew.buySize, side: "BUY" },
                    { tickSize: tickSizeStr, negRisk },
                    "GTC"
                  );
                  const latency = Date.now() - t0;
                  console.log(`✅ BUY ордер принят Polymarket (${latency}ms):`, JSON.stringify(buyOrder));
                  logs.push(`  ✅ BUY @ ${safeBuyPrice.toFixed(4)} (${skew.buySize} USDC) latency=${latency}ms`);
                  orders.push(buyOrder);
                  await logTrade(sb, {
                    market_name: marketName, market_id: marketId, action: "place", side: "BUY",
                    price: safeBuyPrice, size: skew.buySize, paper: false,
                    notes: toAuditNote("place", {
                      orderId: buyOrder?.id || buyOrder?.orderID || buyOrder?.orderId || null,
                      status: buyOrder?.status || buyOrder?.state || null,
                      tickSize: tickSizeStr, latencyMs: latency,
                    }),
                  });
                } catch (e) {
                  const errMsg = getErrorMessage(e);
                  console.error(`❌ BUY ордер отклонён: ${errMsg}`);
                  logs.push(`  ❌ BUY failed: ${errMsg}`);
                  logTrade(sb, {
                    market_name: marketName, market_id: marketId, action: "error", side: "BUY",
                    price: safeBuyPrice, size: skew.buySize, paper: false,
                    notes: toAuditNote("place_error", { tickSize: tickSizeStr, error: errMsg }),
                  }).catch(() => {});
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
              if (existingSell && isWithinTolerance(parseFloat(existingSell.price), safeSellPrice)) {
                logs.push(`  ♻️ SELL @ ${parseFloat(existingSell.price).toFixed(4)} kept`);
              } else {
                if (existingSell) {
                  try {
                    await client.cancelOrder(existingSell.id);
                    logs.push(`  🗑️ Cancel SELL @ ${parseFloat(existingSell.price).toFixed(4)}`);
                    await logTrade(sb, {
                      market_name: marketName, market_id: marketId, action: "cancel", side: "SELL",
                      price: parseFloat(existingSell.price), size: parseFloat(existingSell.original_size || existingSell.size || "0"),
                      paper: false, notes: toAuditNote("cancel", { orderId: existingSell.id || null, reason: "replace_sell" }),
                    });
                  } catch (e) {
                    logs.push(`  ⚠️ Cancel SELL err: ${getErrorMessage(e)}`);
                  }
                }
                try {
                  const t0 = Date.now();
                  console.log(`🚀 Отправляем реальный SELL ордер: token=${tokenId}, price=${safeSellPrice}, size=${skew.sellSize}, tick=${tickSizeStr}`);
                  const sellOrder = await client.createAndPostOrder(
                    { tokenID: tokenId, price: safeSellPrice, size: skew.sellSize, side: "SELL" },
                    { tickSize: tickSizeStr, negRisk },
                    "GTC"
                  );
                  const latency = Date.now() - t0;
                  console.log(`✅ SELL ордер принят Polymarket (${latency}ms):`, JSON.stringify(sellOrder));
                  logs.push(`  ✅ SELL @ ${safeSellPrice.toFixed(4)} (${skew.sellSize} USDC) latency=${latency}ms`);
                  orders.push(sellOrder);
                  await logTrade(sb, {
                    market_name: marketName, market_id: marketId, action: "place", side: "SELL",
                    price: safeSellPrice, size: skew.sellSize, paper: false,
                    notes: toAuditNote("place", {
                      orderId: sellOrder?.id || sellOrder?.orderID || sellOrder?.orderId || null,
                      status: sellOrder?.status || sellOrder?.state || null,
                      tickSize: tickSizeStr, latencyMs: latency,
                    }),
                  });
                } catch (e) {
                  const errMsg = getErrorMessage(e);
                  console.error(`❌ SELL ордер отклонён: ${errMsg}`);
                  logs.push(`  ❌ SELL failed: ${errMsg}`);
                  logTrade(sb, {
                    market_name: marketName, market_id: marketId, action: "error", side: "SELL",
                    price: safeSellPrice, size: skew.sellSize, paper: false,
                    notes: toAuditNote("place_error", { tickSize: tickSizeStr, error: errMsg }),
                  }).catch(() => {});
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
    const errMsg = getErrorMessage(error);
    console.error("Edge function error:", errMsg);
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
