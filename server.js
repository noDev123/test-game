const express = require("express");
const puppeteer = require("puppeteer");
const cron = require("node-cron");

const app = express();
const PORT = 3000;

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
let cache = null;
let lastUpdated = null;

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeAndCache() {
  console.log(`[${new Date().toISOString()}] 🔍 Scraping...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");
    await page.goto("https://endfieldtools.dev/headhunt-tracker/#global", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await page.waitForSelector(".font-bold.text-text-primary", { timeout: 15000 });

    const data = await page.evaluate(() => {
      const getText = (el) => (el ? el.textContent.trim() : null);

      const global = {
        total_pulls: getText(document.querySelector(".font-bold.text-text-primary")),
        six_star_rate: getText(document.querySelector(".font-bold.text-orange-500")),
        users: getText(document.querySelector(".font-bold.text-blue-400")),
      };

      const bannerNames = [
        "Basic Headhunting",
        "Scars of the Forge",
        "Hues of Passion",
        "The Floaty Messenger",
      ];

      const banners = {};
      for (const el of document.querySelectorAll("*")) {
        for (const name of bannerNames) {
          if (el.textContent.trim() === name && el.children.length === 0) {
            let container = el.parentElement;
            for (let i = 0; i < 6; i++) {
              if (!container) break;
              const primary = container.querySelector(".font-bold.text-text-primary");
              const orange = container.querySelector(".font-bold.text-orange-500");
              const blue = container.querySelector(".font-bold.text-blue-400");
              if (primary || orange || blue) {
                banners[name] = {
                  pulls: getText(primary),
                  six_star_rate: getText(orange),
                  users: getText(blue),
                };
                break;
              }
              container = container.parentElement;
            }
          }
        }
      }

      return { global, banners };
    });

    cache = data;
    lastUpdated = new Date().toISOString();
    console.log(`[${lastUpdated}] ✅ Cache updated`);
    return data;

  } finally {
    await browser.close();
  }
}

// ─── CRON (every 30 min) ──────────────────────────────────────────────────────
cron.schedule("*/30 * * * *", () => {
  scrapeAndCache().catch((err) => console.error("❌ Cron failed:", err.message));
});

// Scrape on startup
scrapeAndCache().catch((err) => console.error("❌ Initial scrape failed:", err.message));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const notReady = (res) => res.status(503).json({ error: "Data not ready yet, try again in a moment." });

app.get("/stats", (req, res) => {
  if (!cache) return notReady(res);
  res.json({ last_updated: lastUpdated, ...cache });
});

app.get("/stats/global", (req, res) => {
  if (!cache) return notReady(res);
  res.json({ last_updated: lastUpdated, ...cache.global });
});

app.get("/stats/banners", (req, res) => {
  if (!cache) return notReady(res);
  res.json({ last_updated: lastUpdated, ...cache.banners });
});

app.get("/stats/banner/:name", (req, res) => {
  if (!cache) return notReady(res);
  const name = decodeURIComponent(req.params.name);
  const banner = cache.banners[name];
  if (!banner) {
    return res.status(404).json({
      error: `Banner "${name}" not found`,
      available: Object.keys(cache.banners),
    });
  }
  res.json({ last_updated: lastUpdated, banner: name, ...banner });
});

app.get("/stats/refresh", async (req, res) => {
  try {
    const data = await scrapeAndCache();
    res.json({ message: "Refreshed!", last_updated: lastUpdated, ...data });
  } catch (err) {
    res.status(500).json({ error: "Scrape failed", details: err.message, stack: err.stack });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ API running at http://localhost:${PORT}`);
  console.log(`   GET /stats`);
  console.log(`   GET /stats/global`);
  console.log(`   GET /stats/banners`);
  console.log(`   GET /stats/banner/:name`);
  console.log(`   GET /stats/refresh`);
  console.log(`   ⏰ Auto-scrapes every 30 minutes`);
});