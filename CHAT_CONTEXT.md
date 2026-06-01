# Karakeep Setup & Social Platform Sync — Conversation Context

> This file captures the context from the initial planning conversation so work can resume in this project directory.

## Goal

Build a unified bookmark/link-saving system that:
1. Saves links from **Mac browser** (Chrome/Firefox/Safari extension)
2. Saves links from **iPhone browser** (iOS app with share sheet)
3. Aggregates bookmarks/saves from social platforms: **Instagram, X.com, Reddit, YouTube**
4. Uses cronjob-based AI agent sync to pull latest bookmarks from platforms after last sync
5. All stored in a single self-hosted system

## Decision: Karakeep (formerly Hoarder)

After researching all major open-source self-hosted bookmark managers (Karakeep, Linkwarden, Wallabag, Linkding, Shiori, Shaarli, Omnivore, Raindrop.io), **Karakeep** was chosen as the best fit.

### Why Karakeep

- **25k+ GitHub stars**, MIT licensed, very active (119+ contributors)
- **Browser extensions**: Chrome, Firefox, Safari (all official)
- **iOS app**: Native with share sheet support
- **Full REST API + webhooks**
- **AI features**: Auto-tagging & summarization via OpenAI or local Ollama
- **Docker Compose** self-hosting
- **Tech stack**: Next.js, TypeScript, Drizzle ORM, Meilisearch, Puppeteer — very forkable
- **Existing sync tool**: [karakeep-sync](https://github.com/sidoshi/karakeep-sync) already handles Reddit saves with built-in cron

### Runner-up: Linkwarden (~18k stars)
Similar browser/iOS coverage, more AI providers (Claude, Perplexity, OpenRouter), but zero existing social media sync tooling.

## Platform Sync Plan

### Already Covered
- **Reddit** — `karakeep-sync` community tool with `@daily`/`@hourly` cron scheduling

### Needs Custom Work
- **X/Twitter** — Twitter API v2 exposes bookmarks endpoint. Build sync script → poll API → push to Karakeep REST API
- **YouTube** — YouTube Data API v3 `playlistItems.list` for Watch Later / liked videos. Same poll-and-push pattern
- **Instagram** — No public "saved posts" API. Options: periodic data export, or browser automation to scrape saves

### Sync Architecture Options
1. **Extend `karakeep-sync`** — it already has the cron + Karakeep API integration pattern
2. **Self-host n8n** alongside Karakeep — visual workflow automation with built-in Twitter/YouTube nodes

## Next Steps

1. Set up Karakeep locally (Docker Compose)
2. Configure AI tagging (Ollama for local, or OpenAI API)
3. Clone and set up `karakeep-sync` for Reddit
4. Build custom sync scripts/agents for X, YouTube, Instagram
5. Set up cron scheduling for all sync jobs
