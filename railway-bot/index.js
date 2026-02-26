// ═══════════════════════════════════════════════════════════════
//  Polymarket Market-Making Bot — Railway.app Edition (NO PROXY)
//  signature_type=2 (GNOSIS_SAFE) + funder proxy wallet
// ═══════════════════════════════════════════════════════════════

const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("ethers");
const express = require("express");

// ─── Config from ENV ───
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const GAMMA_API = "https://gamma-api.polymarket.com";
const SIGNATURE_TYPE = 2; // GNOSIS_SAFE
const FUNDER = process.env.FUNDER || "0x787328dc79BA60aF2c61De7773A536e2d4c504E1";

const ORDER_SIZE = parseInt(process.env.ORDER_SIZE || "6", 10);
const SPREAD_BP = parseInt(process.env.SPREAD_BP || "22", 10);
const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || "6", 10);
const MAX_MARKETS = parseInt(process.env.MAX_MARKETS || "12", 10);
const MAX_POSITION = parseInt(process.env.MAX_POSITION || "30", 10);
const TOTAL_CAPITAL = parseInt(process.env.TOTAL_CAPITAL || "65", 10);
const IS_PAPER = (process.env.IS_PAPER || "false").toLowerCase() === "true";
const MIN_LIQUIDITY_DEPTH = parseInt(process.env.MIN_LIQUIDITY_DEPTH || "80", 10);
const MIN_VOLUME_24H = parseInt(process.env.MIN_VOLUME_24H || "1500", 10);
const AGGRESSIVE_SHORT_TERM = (process.env.AGGRESSIVE_SHORT_TERM || "true").toLowerCase() === "true";
const USE_EXTERNAL_ORACLE = (process.env.USE_EXTERNAL_ORACLE || "false").toLowerCase() === "true";

// ─── State ───
let cachedCreds = null;
let cachedClient = null;
let cycleCount = 0;
let lastCycleTime = null;
let totalOrdersPlaced = 0;

// ─── Express Health-Check ───
const app = express();
app.get("/", (req, res) => {
  res.json({
    status: "✅ Polymarket Bot is running",
    mode: IS_PAPER ? "PAPER" : "REAL",
    cycles: cycleCount,
    lastCycle: lastCycleTime,
    totalOrders: totalOrdersPlaced,
    uptime: process.uptime().toFixed(0) + "s",
  });
});
app.get("/health", (req, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Health-check server on port ${process.env.PORT || 3000}`);
});

// ─── Trading Client ───
async function getTradingClient() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in env!");
  if (cachedClient) return cachedClient;

  const signer = new Wallet(privateKey);
  console.log("🔑 Деривация API credentials...");
  console.log(`   Signer: ${signer.address}`);
  console.log(`   Funder: ${FUNDER}`);

  // Step 1: temporary client → derive API creds
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  cachedCreds = creds;
  console.log(`✅ API creds получены: ${creds.apiKey?.slice(0, 12)}...`);

  // Step 2: main client with signature_type=2 + funder
  cachedClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);
  console.log(`✅ ClobClient создан с signature_type=${SIGNATURE_TYPE}, funder=${FUNDER}`);
  return cachedClient;
}

// ─── Gamma API ───
async function getMarkets(limit) {
  const url = `${GAMMA_API}/markets?limit=${Math.min(limit, 150)}&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url);
  if (!res.ok) {
    const res2 = await fetch(`${GAMMA_API}/markets?limit=${Math.min(limit, 150)}&active=true&closed=false`);
    if (!res2.ok) throw new Error(`Gamma API error: ${res2.status}`);
    return await res2.json();
  }
  return await res.json();
}

// ─── Mid-price ───
async function getMidPrice(client, tokenId) {
  try {
    const book = await client.getOrderBook(tokenId);
    const hasBids = book?.bids?.length > 0;
    const hasAsks = book?.asks?.length > 0;

    if (hasBids && hasAsks) {
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk = parseFloat(book.asks[0].price);
      const bestBidSize = parseFloat(book.bids[0].size || "0");
      const bestAskSize = parseFloat(book.asks[0].size || "0");
      const range1h = ((bestAsk - bestBid) / ((bestBid + bestAsk) / 2)) * 100;
      return { mid: (bestBid + bestAsk) / 2, source: "orderbook", range1h, bidDepth: bestBidSize, askDepth: bestAskSize, bestBid, bestAsk };
    }
    if (book?.market?.lastTradePrice) {
      return { mid: parseFloat(book.market.lastTradePrice), source: "last_trade", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0 };
    }
    if (hasBids) return { mid: parseFloat(book.bids[0].price), source: "bid_only", range1h: 0, bidDepth: parseFloat(book.bids[0].size || "0"), askDepth: 0, bestBid: parseFloat(book.bids[0].price), bestAsk: 0 };
    if (hasAsks) return { mid: parseFloat(book.asks[0].price), source: "ask_only", range1h: 0, bidDepth: 0, askDepth: parseFloat(book.asks[0].size || "0"), bestBid: 0, bestAsk: parseFloat(book.asks[0].price) };
  } catch { /* silent */ }
  return { mid: 0, source: "empty", range1h: 0, bidDepth: 0, askDepth: 0, bestBid: 0, bestAsk: 0 };
}

// ─── External oracle (Binance) ───
const CRYPTO_KEYWORDS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "Up or Down", "5m", "5 min", "15 min"];
function isCryptoMarket(question) {
  const upper = question.toUpperCase();
  return CRYPTO_KEYWORDS.some((k) => upper.includes(k.toUpperCase()));
}

async function getExternalPrice(marketQuestion) {
  const cryptoMap = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", DOGE: "DOGEUSDT", XRP: "XRPUSDT", ADA: "ADAUSDT" };
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

// ─── Sponsor/rewards ───
const FORCE_SPONSOR_KEYWORDS = [
  { kw: "Leavitt", pool: 15 },
  { kw: "Elon Musk net worth", pool: 15 },
];

async function getSponsorPool(conditionId, tokenId, title) {
  try {
    const res = await fetch(`${CLOB_HOST}/rewards?conditionId=${conditionId}`);
    if (res.ok) {
      const data = await res.json();
      const amount = parseFloat(data?.rewardsAmount || data?.daily_reward_amount || data?.rewards_daily_rate || "0");
      if (amount > 0) return { pool: amount, method: "clob" };
    }
  } catch { /* silent */ }

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

  try {
    const res = await fetch(`${CLOB_HOST}/rewards/markets`);
    if (res.ok) {
      const data = await res.json();
      const markets = Array.isArray(data) ? data : data?.markets || [];
      const found = markets.find((m) => m.condition_id === conditionId || m.token_id === tokenId);
      if (found) {
        const amount = parseFloat(found.rewards_amount || found.daily_reward_amount || "500");
        return { pool: amount, method: "rewards_markets" };
      }
    }
  } catch { /* silent */ }

  const upper = (title || "").toUpperCase();
  for (const fs of FORCE_SPONSOR_KEYWORDS) {
    if (upper.includes(fs.kw.toUpperCase())) return { pool: fs.pool, method: "forced_keyword" };
  }
  return { pool: 0, method: "none" };
}

// ─── Category bonus ───
const TIER1_KEYWORDS = [
  "Leavitt", "Leavitt say", "press briefing", "Joe Biden", "Historic", "AI", "Artificial Intelligence",
  "Elon Musk # tweets", "Elon Musk net worth", "Elon tweets",
  "5 Minute", "5 min Up or Down", "15 min", "this hour", "today temperature", "highest temperature",
  "S&P", "Dow Jones", "SPX", "Bitcoin ETF Flows", "XRP above",
];
const TIER2_KEYWORDS = ["BTC", "ETH", "SOL", "Fed", "interest rates", "NBA", "NHL", "Champions League"];
const NEGATIVE_KEYWORDS = ["2028", "2029", "Democratic presidential", "Republican presidential", "Jesus Christ return", "Uzbekistan"];

function getCategoryBonus(title, sponsorPool, aggressiveShortTerm) {
  const upper = title.toUpperCase();
  let bonus = 0, category = "other", isTier1 = false;

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
        if (["BTC", "ETH", "SOL"].some((k) => kw.toUpperCase() === k.toUpperCase())) category = "crypto/short-term";
        else if (["NBA", "NHL", "Champions League"].some((k) => kw.toUpperCase() === k.toUpperCase())) category = "sports";
        else category = "macro";
        break;
      }
    }
  }
  if (sponsorPool > 0) { bonus += 8000; if (category === "other") category = "sponsored"; }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (upper.includes(kw.toUpperCase())) { bonus -= 15000; category = "long-term"; break; }
  }
  return { bonus, category, isTier1 };
}

function scoreMarket(volume24h, sponsorPool, liquidityDepth, categoryBonus, isTier1) {
  const cappedVol = Math.min(volume24h, 500000);
  const cappedDepth = Math.min(liquidityDepth, 50000);
  const base = cappedVol * 0.03 + sponsorPool * 30 + cappedDepth * 0.8 + categoryBonus;
  return isTier1 ? base * 4.0 : base;
}

// ─── Dynamic spread ───
function calcDynamicSpread(baseBp, sponsorPool, range1h) {
  let spread = baseBp;
  let sponsorAdj = "", volAdj = "";
  if (sponsorPool > 2000) { spread *= 0.5; sponsorAdj = "-50%"; }
  else if (sponsorPool > 1000) { spread *= 0.7; sponsorAdj = "-30%"; }
  else if (sponsorPool > 500) { spread *= 0.85; sponsorAdj = "-15%"; }
  if (range1h > 4) { spread *= 1.4; volAdj = "+40%"; }
  else if (range1h > 2) { spread *= 1.2; volAdj = "+20%"; }
  return { finalBp: Math.max(5, Math.min(60, Math.round(spread))), sponsorAdj, volAdj };
}

// ─── Skew ───
function applySkew(buyPrice, sellPrice, orderSize, netPos, maxPos, baseBp) {
  const spreadDecimal = baseBp / 10000;
  let buySize = orderSize, sellSize = orderSize;
  let pauseBuy = false, pauseSell = false, skewLabel = "none";
  const threshold = maxPos * 0.6;

  if (netPos > threshold) {
    buyPrice -= spreadDecimal * 0.5;
    sellPrice -= spreadDecimal * 0.3;
    buySize = Math.max(2, Math.round(orderSize * 0.5));
    skewLabel = `LONG heavy → buy×0.5, sell×1.0`;
  } else if (netPos < -threshold) {
    sellPrice += spreadDecimal * 0.5;
    buyPrice += spreadDecimal * 0.3;
    sellSize = Math.max(2, Math.round(orderSize * 0.5));
    skewLabel = `SHORT heavy → sell×0.5, buy×1.0`;
  }
  if (netPos > maxPos) { pauseBuy = true; skewLabel = `PAUSED BUY (pos=${netPos.toFixed(0)}>${maxPos})`; }
  if (netPos < -maxPos) { pauseSell = true; skewLabel = `PAUSED SELL (pos=${netPos.toFixed(0)}<-${maxPos})`; }
  buyPrice = Math.max(0.01, buyPrice);
  sellPrice = Math.min(0.99, sellPrice);
  return { buyPrice, sellPrice, buySize, sellSize, pauseBuy, pauseSell, skewLabel };
}

function isWithinTolerance(existingPrice, targetPrice, toleranceBp = 0.5) {
  return Math.abs(existingPrice - targetPrice) <= toleranceBp / 10000;
}

// ─── In-memory position tracking (no DB in Railway version) ───
const positions = new Map(); // marketId → netPosition

function getNetPosition(marketId) {
  return positions.get(marketId) || 0;
}
function updateNetPosition(marketId, delta) {
  positions.set(marketId, (positions.get(marketId) || 0) + delta);
}

// ─── Daily PnL tracking (in-memory) ───
let dailyPnl = { date: new Date().toISOString().split("T")[0], realized: 0, trades: 0, circuitBreaker: false };

function resetDailyIfNeeded() {
  const today = new Date().toISOString().split("T")[0];
  if (dailyPnl.date !== today) {
    dailyPnl = { date: today, realized: 0, trades: 0, circuitBreaker: false };
    positions.clear();
    console.log("📅 Новый день — сброс PnL и позиций");
  }
}

// ═══════════════════════════════════════════
//  MAIN TRADING CYCLE
// ═══════════════════════════════════════════
async function runCycle() {
  resetDailyIfNeeded();
  cycleCount++;
  const cycleStart = Date.now();
  const logs = [];
  const paperTrading = IS_PAPER;

  const maxMarkets = MAX_MARKETS;
  const baseBp = SPREAD_BP;
  let orderSize = Math.min(ORDER_SIZE, Math.floor(TOTAL_CAPITAL * 0.08));
  if (orderSize < 1) orderSize = 1;
  const maxPosition = Math.min(MAX_POSITION, Math.floor(TOTAL_CAPITAL * 0.48));

  logs.push(`\n${"═".repeat(60)}`);
  logs.push(`🔄 Цикл #${cycleCount} | ${new Date().toLocaleString()} | ${paperTrading ? "📝 PAPER" : "💰 REAL"}`);
  logs.push(`${"═".repeat(60)}`);

  // Circuit breaker
  if (dailyPnl.circuitBreaker) {
    logs.push("🚨 CIRCUIT BREAKER ACTIVE — дневной лимит убытков превышен");
    logs.forEach((l) => console.log(l));
    return;
  }
  if (dailyPnl.realized < -(TOTAL_CAPITAL * 0.03)) {
    logs.push(`🚨 CIRCUIT BREAKER: PnL ${dailyPnl.realized.toFixed(2)} < -3% of $${TOTAL_CAPITAL}`);
    dailyPnl.circuitBreaker = true;
    logs.forEach((l) => console.log(l));
    return;
  }

  let client;
  try {
    client = await getTradingClient();
  } catch (e) {
    console.error("❌ Не удалось создать клиент:", e.message);
    return;
  }

  // Balance check (live mode)
  if (!paperTrading) {
    try {
      const balanceInfo = await client.getBalance?.();
      if (balanceInfo !== undefined) {
        logs.push(`💰 Баланс USDC: ${typeof balanceInfo === "object" ? JSON.stringify(balanceInfo) : balanceInfo}`);
      }
    } catch (e) {
      logs.push(`⚠️ Баланс: ${e.message}`);
    }
  }

  // Fetch markets
  let allMarkets;
  try {
    allMarkets = await getMarkets(90);
  } catch (e) {
    logs.push(`❌ Ошибка загрузки рынков: ${e.message}`);
    logs.forEach((l) => console.log(l));
    return;
  }

  // Pre-filter by volume
  const volumeFiltered = allMarkets.filter((m) => parseFloat(m.volume24hr || m.volume || "0") >= MIN_VOLUME_24H);
  const marketsToEnrich = volumeFiltered.slice(0, Math.min(maxMarkets * 3, 50));

  // Enrich
  const enriched = [];
  const skipReasons = { lowVol: allMarkets.length - volumeFiltered.length, emptyBook: 0, lowDepth: 0 };

  for (const m of marketsToEnrich) {
    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === "string") {
      try { tokenIds = JSON.parse(tokenIds); } catch { continue; }
    }
    if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) continue;
    const tokenId = tokenIds[0];
    const conditionId = m.conditionId || m.id || "";
    const question = m.question || m.title || "";

    // Sponsor
    const gammaReward = parseFloat(m.rewardsDaily || m.rewardPoolSize || m.liquidityRewards || m.rewardsAmount || "0");
    let sponsorPool = gammaReward;
    let sponsorMethod = gammaReward > 0 ? "gamma" : "none";
    if (sponsorPool === 0 && conditionId) {
      const result = await getSponsorPool(conditionId, tokenId, question);
      sponsorPool = result.pool;
      sponsorMethod = result.method;
    }

    // Mid-price
    const midResult = await getMidPrice(client, tokenId);
    const { mid, source, range1h, bidDepth, askDepth, bestBid, bestAsk } = midResult;
    const liquidityDepth = bidDepth + askDepth;
    const volume24h = parseFloat(m.volume24hr || m.volume || "0");

    if (mid === 0 || source === "empty") { skipReasons.emptyBook++; continue; }
    if (liquidityDepth < 80) { skipReasons.lowDepth++; continue; }

    const isCoinFlip = Math.abs(mid - 0.5) < 0.005;
    const coinFlipPenalty = isCoinFlip ? -2000 : 0;
    const bookSpread = bestBid > 0 && bestAsk > 0 ? (bestAsk - bestBid) / mid : 0;
    const wideSpreadPenalty = bookSpread > 0.1 ? -3000 : bookSpread > 0.05 ? -1000 : 0;
    const depthPenalty = liquidityDepth < MIN_LIQUIDITY_DEPTH ? -1500 : 0;

    const { bonus: categoryBonus, category, isTier1 } = getCategoryBonus(question, sponsorPool, AGGRESSIVE_SHORT_TERM);
    const score = scoreMarket(volume24h, sponsorPool, liquidityDepth, categoryBonus + coinFlipPenalty + wideSpreadPenalty + depthPenalty, isTier1);

    enriched.push({
      ...m, tokenId, conditionId, sponsorPool, sponsorMethod, volume24h, liquidityDepth,
      mid, midSource: source, range1h, bidDepth, askDepth, bestBid, bestAsk, score, category, categoryBonus, question,
    });
  }

  enriched.sort((a, b) => b.score - a.score);
  const selectedMarkets = enriched.slice(0, maxMarkets);

  const sponsoredCount = selectedMarkets.filter((m) => m.sponsorPool > 0).length;
  logs.push(`🔍 Загружено ${allMarkets.length} | После фильтров ${enriched.length} | Выбрано ${selectedMarkets.length} (${sponsoredCount} sponsored)`);
  logs.push(`🔍 Отфильтровано: vol<${MIN_VOLUME_24H}=${skipReasons.lowVol}, пустой стакан=${skipReasons.emptyBook}, глубина<80=${skipReasons.lowDepth}`);

  for (const m of selectedMarkets.slice(0, 10)) {
    const name = (m.question || "Unknown").slice(0, 45);
    const sponTag = m.sponsorPool > 0 ? ` 🏆$${m.sponsorPool.toFixed(0)}` : "";
    logs.push(`  📋 ${name} | vol=$${m.volume24h.toFixed(0)} | score=${m.score.toFixed(0)} [${m.category}]${sponTag}`);
  }

  // Get existing orders (live mode)
  let existingOrders = [];
  if (!paperTrading) {
    try {
      existingOrders = (await client.getOpenOrders()) || [];
      logs.push(`📋 Текущие ордера: ${existingOrders.length}`);
    } catch (e) {
      logs.push(`⚠️ Ордера: ${e.message}`);
    }
  }

  // Process markets
  let ordersPlaced = 0;

  for (const market of selectedMarkets) {
    const tokenId = market.tokenId;
    const negRisk = market.negRisk ?? false;
    const marketId = market.conditionId || market.id || tokenId;
    const marketName = (market.question || "Unknown").slice(0, 50);
    const midPrice = market.mid;
    const priceSource = market.midSource;
    const range1h = market.range1h;

    // External oracle
    if (USE_EXTERNAL_ORACLE && isCryptoMarket(market.question || "")) {
      const extPrice = await getExternalPrice(market.question || "");
      if (extPrice !== null) logs.push(`  🔮 Оракул: ${extPrice} (book mid: ${midPrice.toFixed(4)})`);
    }

    // Dynamic spread
    let { finalBp: dynamicBp, sponsorAdj, volAdj } = calcDynamicSpread(baseBp, market.sponsorPool || 0, range1h);

    let nearCertainLabel = "", onlyBuy = false, onlySell = false;
    if (midPrice > 0.92) { dynamicBp = Math.min(dynamicBp, 5); onlyBuy = true; nearCertainLabel = " [NEAR-YES]"; }
    else if (midPrice < 0.08) { dynamicBp = Math.min(dynamicBp, 5); onlySell = true; nearCertainLabel = " [NEAR-NO]"; }

    const netPos = getNetPosition(marketId);
    const spreadDecimal = dynamicBp / 10000;
    const buyPrice = midPrice - spreadDecimal;
    const sellPrice = midPrice + spreadDecimal;
    const skew = applySkew(buyPrice, sellPrice, orderSize, netPos, maxPosition, dynamicBp);

    if (onlyBuy) skew.pauseSell = true;
    if (onlySell) skew.pauseBuy = true;

    const sponsorLabel = market.sponsorPool > 0 ? ` 🏆$${market.sponsorPool.toFixed(0)}` : "";
    logs.push(`📈 ${marketName}${nearCertainLabel}: mid=${midPrice.toFixed(4)} (${priceSource}) spread=${dynamicBp}bp${sponsorLabel}`);

    if (skew.skewLabel !== "none") logs.push(`  ⚖️ SKEW: pos=${netPos.toFixed(1)} → ${skew.skewLabel}`);

    if (paperTrading) {
      // Paper mode
      if (!skew.pauseBuy) {
        logs.push(`  📝 [PAPER] BUY @ ${skew.buyPrice.toFixed(4)} (${skew.buySize} USDC)`);
        if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.4)) {
          const safeFillSize = Math.min(skew.buySize, maxPosition - Math.abs(netPos));
          const actualFill = Math.max(0, Math.round(safeFillSize * (0.3 + Math.random() * 0.7)));
          if (actualFill > 0 && Math.abs(netPos + actualFill) <= maxPosition) {
            updateNetPosition(marketId, actualFill);
            dailyPnl.realized += spreadDecimal * actualFill * 0.5;
            dailyPnl.trades++;
            logs.push(`  ✅ [PAPER] Fill BUY: ${actualFill} USDC`);
            ordersPlaced++;
          }
        }
      }
      if (!skew.pauseSell) {
        logs.push(`  📝 [PAPER] SELL @ ${skew.sellPrice.toFixed(4)} (${skew.sellSize} USDC)`);
        if (Math.random() < (dynamicBp <= 12 ? 0.65 : 0.4)) {
          const safeFillSize = Math.min(skew.sellSize, maxPosition - Math.abs(netPos));
          const actualFill = Math.max(0, Math.round(safeFillSize * (0.3 + Math.random() * 0.7)));
          if (actualFill > 0 && Math.abs(netPos - actualFill) <= maxPosition) {
            updateNetPosition(marketId, -actualFill);
            dailyPnl.realized += spreadDecimal * actualFill * 0.5;
            dailyPnl.trades++;
            logs.push(`  ✅ [PAPER] Fill SELL: ${actualFill} USDC`);
            ordersPlaced++;
          }
        }
      }
    } else {
      // ── LIVE mode ──
      let safeBuyPrice = Math.max(0.01, Math.min(0.99, Math.round(skew.buyPrice * 10000) / 10000));
      let safeSellPrice = Math.max(0.01, Math.min(0.99, Math.round(skew.sellPrice * 10000) / 10000));
      if (safeBuyPrice === 1 || safeBuyPrice === 0) safeBuyPrice = 0.99;
      if (safeSellPrice === 1 || safeSellPrice === 0) safeSellPrice = 0.01;

      const myBuys = existingOrders.filter((o) => o.asset_id === tokenId && (o.side === "BUY" || o.side === "buy"));
      const mySells = existingOrders.filter((o) => o.asset_id === tokenId && (o.side === "SELL" || o.side === "sell"));

      // BUY
      if (!skew.pauseBuy) {
        const existingBuy = myBuys[0];
        if (existingBuy && isWithinTolerance(parseFloat(existingBuy.price), safeBuyPrice)) {
          logs.push(`  ♻️ BUY @ ${parseFloat(existingBuy.price).toFixed(4)} kept`);
        } else {
          if (existingBuy) {
            try { await client.cancelOrder(existingBuy.id); logs.push(`  🗑️ Cancel BUY`); } catch (e) { logs.push(`  ⚠️ Cancel BUY: ${e.message}`); }
          }
          try {
            const t0 = Date.now();
            console.log(`🚀 Отправляем реальный BUY ордер: token=${tokenId}, price=${safeBuyPrice}, size=${skew.buySize}`);
            const buyOrder = await client.createAndPostOrder(
              { tokenID: tokenId, price: safeBuyPrice, size: skew.buySize, side: "BUY" },
              { tickSize: "0.01", negRisk },
              "GTC"
            );
            const latency = Date.now() - t0;
            console.log(`✅ Ордер успешно размещён! Latency: ${latency} ms`);
            logs.push(`  ✅ BUY @ ${safeBuyPrice.toFixed(4)} (${skew.buySize} USDC) [${latency}ms]`);
            ordersPlaced++;
          } catch (e) {
            console.error(`❌ BUY отклонён: ${e.message}`);
            logs.push(`  ❌ BUY failed: ${e.message}`);
          }
        }
        for (const extra of myBuys.slice(1)) {
          try { await client.cancelOrder(extra.id); } catch { /* silent */ }
        }
      } else {
        logs.push(`  ⏸️ BUY paused`);
        for (const b of myBuys) { try { await client.cancelOrder(b.id); } catch { /* silent */ } }
      }

      // SELL
      if (!skew.pauseSell) {
        const existingSell = mySells[0];
        if (existingSell && isWithinTolerance(parseFloat(existingSell.price), safeSellPrice)) {
          logs.push(`  ♻️ SELL @ ${parseFloat(existingSell.price).toFixed(4)} kept`);
        } else {
          if (existingSell) {
            try { await client.cancelOrder(existingSell.id); logs.push(`  🗑️ Cancel SELL`); } catch (e) { logs.push(`  ⚠️ Cancel SELL: ${e.message}`); }
          }
          try {
            const t0 = Date.now();
            console.log(`🚀 Отправляем реальный SELL ордер: token=${tokenId}, price=${safeSellPrice}, size=${skew.sellSize}`);
            const sellOrder = await client.createAndPostOrder(
              { tokenID: tokenId, price: safeSellPrice, size: skew.sellSize, side: "SELL" },
              { tickSize: "0.01", negRisk },
              "GTC"
            );
            const latency = Date.now() - t0;
            console.log(`✅ Ордер успешно размещён! Latency: ${latency} ms`);
            logs.push(`  ✅ SELL @ ${safeSellPrice.toFixed(4)} (${skew.sellSize} USDC) [${latency}ms]`);
            ordersPlaced++;
          } catch (e) {
            console.error(`❌ SELL отклонён: ${e.message}`);
            logs.push(`  ❌ SELL failed: ${e.message}`);
          }
        }
        for (const extra of mySells.slice(1)) {
          try { await client.cancelOrder(extra.id); } catch { /* silent */ }
        }
      } else {
        logs.push(`  ⏸️ SELL paused`);
        for (const s of mySells) { try { await client.cancelOrder(s.id); } catch { /* silent */ } }
      }
    }
  }

  totalOrdersPlaced += ordersPlaced;
  lastCycleTime = new Date().toISOString();
  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  logs.push(`\n${paperTrading ? "📝 PAPER" : "💰 REAL"} Итого: ${ordersPlaced} ордеров за ${elapsed}s | PnL сегодня: $${dailyPnl.realized.toFixed(4)} (${dailyPnl.trades} trades)`);

  logs.forEach((l) => console.log(l));
}

// ═══════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🚀 Polymarket Market-Making Bot");
  console.log("═".repeat(60));
  console.log(`   Режим:           ${IS_PAPER ? "📝 PAPER (симуляция)" : "💰 REAL TRADING"}`);
  console.log(`   Funder:          ${FUNDER}`);
  console.log(`   Signature type:  ${SIGNATURE_TYPE} (GNOSIS_SAFE)`);
  console.log(`   Host:            ${CLOB_HOST}`);
  console.log(`   Order size:      $${ORDER_SIZE}`);
  console.log(`   Spread:          ${SPREAD_BP} bp`);
  console.log(`   Interval:        ${INTERVAL_SEC}s`);
  console.log(`   Max markets:     ${MAX_MARKETS}`);
  console.log(`   Max position:    $${MAX_POSITION}`);
  console.log(`   Total capital:   $${TOTAL_CAPITAL}`);
  console.log("═".repeat(60));

  // Initial client creation + balance
  try {
    const client = await getTradingClient();
    try {
      const balance = await client.getBalance?.();
      if (balance !== undefined) {
        console.log(`💰 Баланс USDC внутри Polymarket: ${typeof balance === "object" ? JSON.stringify(balance) : "$" + balance}`);
      }
    } catch { /* silent */ }
  } catch (e) {
    console.error("❌ Ошибка инициализации клиента:", e.message);
    console.error("   Проверьте PRIVATE_KEY в переменных окружения");
    process.exit(1);
  }

  console.log(`\n⏱️ Запуск циклов каждые ${INTERVAL_SEC}s...\n`);

  // Run first cycle immediately, then schedule
  await runCycle();
  setInterval(runCycle, INTERVAL_SEC * 1000);
}

main().catch((e) => {
  console.error("💥 Fatal error:", e);
  process.exit(1);
});
