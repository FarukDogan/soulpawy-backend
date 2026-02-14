import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
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

app.post("/analyze", async (req, res) => {
  try {
    const { message } = req.body;

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
        {
          role: "user",
          content: message
        }
      ]
    });

    res.json({
      result: completion.choices[0].message.content
    });

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
