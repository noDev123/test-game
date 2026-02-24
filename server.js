const express = require("express");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const puppeteer = require("puppeteer");
const path = require("path");

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, "data.db");

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS global_stats (
    id INTEGER PRIMARY KEY,
    total_pulls TEXT,
    six_star_rate TEXT,
    users TEXT,
    scraped_at TEXT
  );

  CREATE TABLE IF NOT EXISTS banner_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    banner_name TEXT UNIQUE NOT NULL,
    pulls TEXT,
    six_star_rate TEXT,
    users TEXT,
    scraped_at TEXT
  );
`);

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeAndSave() {
  console.log(`[${new Date().toISOString()}] 🔍 Starting scrape...`);

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
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    );

    await page.goto("https://endfieldtools.dev/headhunt-tracker/#global", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await page.waitForSelector(".font-bold.text-text-primary", { timeout: 15000 });

    const scraped = await page.evaluate(() => {
      const getText = (el) => (el ? el.textContent.trim() : null);

      const allPrimary = document.querySelectorAll(".font-bold.text-text-primary");
      const allOrange = document.querySelectorAll(".font-bold.text-orange-500");
      const allBlue = document.querySelectorAll(".font-bold.text-blue-400");

      const global = {
        total_pulls: getText(allPrimary[0]),
        six_star_rate: getText(allOrange[0]),
        users: getText(allBlue[0]),
      };

      const bannerNames = [
        "Basic Headhunting",
        "Scars of the Forge",
        "Hues of Passion",
        "The Floaty Messenger",
      ];

      const banners = {};
      const allElements = document.querySelectorAll("*");

      for (const el of allElements) {
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

    const now = new Date().toISOString();

    // Save global stats (upsert)
    db.prepare(`
      INSERT INTO global_stats (id, total_pulls, six_star_rate, users, scraped_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_pulls = excluded.total_pulls,
        six_star_rate = excluded.six_star_rate,
        users = excluded.users,
        scraped_at = excluded.scraped_at
    `).run(scraped.global.total_pulls, scraped.global.six_star_rate, scraped.global.users, now);

    // Save each banner (upsert by name)
    for (const [name, stats] of Object.entries(scraped.banners)) {
      db.prepare(`
        INSERT INTO banner_stats (banner_name, pulls, six_star_rate, users, scraped_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(banner_name) DO UPDATE SET
          pulls = excluded.pulls,
          six_star_rate = excluded.six_star_rate,
          users = excluded.users,
          scraped_at = excluded.scraped_at
      `).run(name, stats.pulls, stats.six_star_rate, stats.users, now);
    }

    console.log(`[${now}] ✅ Scrape saved to database`);
    return scraped;

  } finally {
    await browser.close();
  }
}

// ─── CRON JOB (every 30 minutes) ─────────────────────────────────────────────
cron.schedule("*/30 * * * *", () => {
  scrapeAndSave().catch((err) => console.error("❌ Cron scrape failed:", err.message));
});

// Run once on startup
scrapeAndSave().catch((err) => console.error("❌ Initial scrape failed:", err.message));

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /stats — all stats
app.get("/stats", (req, res) => {
  const global = db.prepare("SELECT * FROM global_stats WHERE id = 1").get();
  const banners = db.prepare("SELECT * FROM banner_stats").all();

  if (!global) {
    return res.status(503).json({ error: "Data not yet available, scrape in progress. Try again in a moment." });
  }

  res.json({
    global: {
      total_pulls: global.total_pulls,
      six_star_rate: global.six_star_rate,
      users: global.users,
      last_updated: global.scraped_at,
    },
    banners: banners.reduce((acc, b) => {
      acc[b.banner_name] = {
        pulls: b.pulls,
        six_star_rate: b.six_star_rate,
        users: b.users,
        last_updated: b.scraped_at,
      };
      return acc;
    }, {}),
  });
});

// GET /stats/global
app.get("/stats/global", (req, res) => {
  const global = db.prepare("SELECT * FROM global_stats WHERE id = 1").get();
  if (!global) return res.status(503).json({ error: "Data not yet available, try again shortly." });

  res.json({
    total_pulls: global.total_pulls,
    six_star_rate: global.six_star_rate,
    users: global.users,
    last_updated: global.scraped_at,
  });
});

// GET /stats/banners
app.get("/stats/banners", (req, res) => {
  const banners = db.prepare("SELECT * FROM banner_stats").all();
  if (!banners.length) return res.status(503).json({ error: "Data not yet available, try again shortly." });

  res.json(
    banners.reduce((acc, b) => {
      acc[b.banner_name] = {
        pulls: b.pulls,
        six_star_rate: b.six_star_rate,
        users: b.users,
        last_updated: b.scraped_at,
      };
      return acc;
    }, {})
  );
});

// GET /stats/banner/:name
app.get("/stats/banner/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const banner = db.prepare("SELECT * FROM banner_stats WHERE banner_name = ?").get(name);

  if (!banner) {
    const available = db.prepare("SELECT banner_name FROM banner_stats").all().map((r) => r.banner_name);
    return res.status(404).json({
      error: `Banner "${name}" not found`,
      available: available.length ? available : ["No data yet, scrape in progress"],
    });
  }

  res.json({
    banner: banner.banner_name,
    pulls: banner.pulls,
    six_star_rate: banner.six_star_rate,
    users: banner.users,
    last_updated: banner.scraped_at,
  });
});

// GET /stats/refresh — manually trigger scrape
app.get("/stats/refresh", async (req, res) => {
  try {
    const data = await scrapeAndSave();
    res.json({ message: "Scrape successful", scraped_at: new Date().toISOString(), data });
  } catch (err) {
    console.error("❌ Manual refresh failed:", err);
    res.status(500).json({ error: "Scrape failed", details: err.message, stack: err.stack });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Headhunt Tracker API running at http://localhost:${PORT}`);
  console.log(`   GET /stats                    → All stats`);
  console.log(`   GET /stats/global             → Global stats only`);
  console.log(`   GET /stats/banners            → All banners`);
  console.log(`   GET /stats/banner/:name       → Specific banner`);
  console.log(`   GET /stats/refresh            → Manually trigger scrape`);
  console.log(`   ⏰ Auto-scrapes every 30 minutes`);
});