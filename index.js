import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

/**
 * Shopify Client Credentials (server-to-server) access token cache
 * Token expires ~24h. We refresh 5 minutes early.
 */
let shopifyTokenCache = {
  token: null,
  expiresAt: 0
};

async function getShopifyAccessToken() {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!store || !clientId || !clientSecret) {
    throw new Error(
      "Missing Shopify env. Required: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET"
    );
  }

  const now = Date.now();
  if (shopifyTokenCache.token && now < shopifyTokenCache.expiresAt - 5 * 60 * 1000) {
    return shopifyTokenCache.token;
  }

  const url = `https://${store}/admin/oauth/access_token`;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const resp = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  const token = resp.data?.access_token;
  const expiresIn = resp.data?.expires_in || 86399;

  if (!token) throw new Error("No access_token returned from Shopify");

  shopifyTokenCache.token = token;
  shopifyTokenCache.expiresAt = now + expiresIn * 1000;

  return token;
}

const app = express();
app.use(cors());
app.use(express.json());

// Simple request log
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * GET /products-by-tags?tags=need_anxiety,species_dog,type_heartbeat
 * Returns up to 12 active, published products that contain ALL tags.
 */
app.get("/products-by-tags", async (req, res) => {
  try {
    const tags = (req.query.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (tags.length === 0) return res.json({ products: [] });

    const store = process.env.SHOPIFY_STORE;
    if (!store) {
      return res.status(500).json({
        error: "Missing Shopify env",
        detail: "SHOPIFY_STORE is not set"
      });
    }

    const token = await getShopifyAccessToken();

    // Use a stable Admin API version
    const url = `https://${store}/admin/api/2024-10/products.json?limit=50&fields=id,title,handle,tags,images,variants,status,published_at`;

    const resp = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": token }
    });

    const products = (resp.data.products || [])
      .filter((p) => p.status === "active" && p.published_at)
      .filter((p) => {
        const ptags = (p.tags || "").split(",").map((x) => x.trim());
        return tags.every((t) => ptags.includes(t));
      })
      .slice(0, 12)
      .map((p) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        tags: p.tags,
        image: p.images?.[0]?.src || null,
        variant_id: p.variants?.[0]?.id || null,
        price: p.variants?.[0]?.price || null
      }));

    res.json({ products });
  } catch (err) {
    console.error("SHOPIFY ERROR:", err?.response?.status, err?.message, err?.response?.data);
    res.status(500).json({
      error: "Shopify error",
      detail: err?.response?.data || err?.message || String(err)
    });
  }
});

/**
 * POST /analyze
 * Body: { "message": "..." }
 * Returns: { result: "<JSON string>" }
 */
app.post("/analyze", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Bad request", detail: "message is required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are Soulpawy's pet behavior triage assistant.
Return ONLY valid JSON matching this schema:

{
  "risk_flag": "none" | "urgent_vet" | "behavior_pro",
  "pet_type": "dog" | "cat" | "unknown",
  "needs": ["need_anxiety","need_separation","need_chewing","need_scratching","need_sleep","need_enrichment","need_boredom","need_high_energy","need_noise","need_feeding"],
  "daily_actions": [{"title":"","steps":["",""],"why":""}],
  "weekly_plan": [{"day_range":"days 1-2|days 3-4|days 5-7","focus":"","steps":["",""]}],
  "blog_tags": ["need_anxiety","need_separation","need_sleep","core_topic"],
  "product_tags": ["need_anxiety","need_separation","type_heartbeat","species_dog"],
  "short_summary": ""
}

Rules:
- Use ONLY tags from the allowed lists above.
- needs must be 1-5 items.
- daily_actions must be 3 items, weekly_plan must be 3 items.
- product_tags must include species_dog or species_cat.
- No extra text, no markdown, JSON only.
`
        },
        { role: "user", content: message }
      ]
    });

    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    console.error("AI ERROR:", err?.status, err?.message, err?.response?.data);
    res.status(500).json({
      error: "AI error",
      detail: err?.message || String(err)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
