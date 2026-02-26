import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ClobClient } from "npm:@polymarket/clob-client@4.22.8";
import { Wallet } from "npm:ethers@5.7.2";

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

async function getTradingClient() {
  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not set");

  if (cachedClient) return cachedClient;

  const signer = new Wallet(privateKey);

  // Derive L2 API credentials from private key
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  cachedCreds = creds;

  // Create full trading client with L2 creds
  cachedClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);
  return cachedClient;
}

async function getMarkets(limit: number) {
  const res = await fetch(
    `${GAMMA_API}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`
  );
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
  return await res.json();
}

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
        return new Response(
          JSON.stringify({ ok: true, address: cachedCreds?.apiKey?.slice(0, 8) + "..." }),
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

      case "place_order": {
        const client = await getTradingClient();
        const { tokenId, price, size, side, tickSize, negRisk } = params;
        const order = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: parseFloat(price),
            size: parseFloat(size),
            side: side || "BUY",
          },
          { tickSize: tickSize || "0.01", negRisk: negRisk ?? false },
          "GTC"
        );
        return new Response(JSON.stringify({ ok: true, order }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "run_cycle": {
        // Full market-making cycle
        const client = await getTradingClient();
        const logs: string[] = [];

        // 1. Cancel existing orders
        logs.push("🗑️ Отмена всех открытых ордеров...");
        try {
          await client.cancelAll();
          logs.push("✅ Все ордера отменены");
        } catch (e) {
          logs.push(`⚠️ Ошибка отмены: ${e.message}`);
        }

        // 2. Fetch top markets
        const maxMarkets = params.maxMarkets || 5;
        logs.push(`📊 Загрузка топ-${maxMarkets} рынков...`);
        const markets = await getMarkets(maxMarkets);

        const spread = params.spread || 15;
        const orderSize = params.orderSize || 50;
        const orders: any[] = [];

        // 3. Place orders on each market
        for (const market of markets.slice(0, maxMarkets)) {
          if (!market.clobTokenIds || market.clobTokenIds.length === 0) {
            logs.push(`⏭️ ${market.question?.slice(0, 40)}... — нет tokenId`);
            continue;
          }

          const tokenId = market.clobTokenIds[0];
          const negRisk = market.negRisk ?? false;

          // Get current price from orderbook
          let midPrice = 0.5;
          try {
            const book = await client.getOrderBook(tokenId);
            if (book?.bids?.length && book?.asks?.length) {
              const bestBid = parseFloat(book.bids[0].price);
              const bestAsk = parseFloat(book.asks[0].price);
              midPrice = (bestBid + bestAsk) / 2;
            }
          } catch {
            // Use default mid
          }

          const spreadDecimal = spread / 10000;
          const buyPrice = Math.max(0.01, midPrice - spreadDecimal);
          const sellPrice = Math.min(0.99, midPrice + spreadDecimal);

          const marketName = (market.question || "Unknown").slice(0, 50);
          logs.push(`📈 ${marketName}: mid=${midPrice.toFixed(4)}`);

          try {
            const buyOrder = await client.createAndPostOrder(
              { tokenID: tokenId, price: parseFloat(buyPrice.toFixed(2)), size: orderSize, side: "BUY" },
              { tickSize: "0.01", negRisk },
              "GTC"
            );
            logs.push(`  ✅ BUY @ ${buyPrice.toFixed(4)} (${orderSize} USDC)`);
            orders.push(buyOrder);
          } catch (e) {
            logs.push(`  ❌ BUY failed: ${e.message}`);
          }

          try {
            const sellOrder = await client.createAndPostOrder(
              { tokenID: tokenId, price: parseFloat(sellPrice.toFixed(2)), size: orderSize, side: "SELL" },
              { tickSize: "0.01", negRisk },
              "GTC"
            );
            logs.push(`  ✅ SELL @ ${sellPrice.toFixed(4)} (${orderSize} USDC)`);
            orders.push(sellOrder);
          } catch (e) {
            logs.push(`  ❌ SELL failed: ${e.message}`);
          }
        }

        logs.push(`📋 Итого: ${orders.length} ордеров размещено`);

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
