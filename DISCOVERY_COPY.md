# Event Discovery — Updated Copy for Learn Page

Use this copy to replace the current event discovery explanation on the frontend. It describes what the *corrected* flow actually does.

---

## Headline
**Detect New Event Announcements**

## Subheading
Automatically surface newly-announced events at your tracked venues with exact on-sale timing.

---

## How It Works

### The Problem
Event listings are published on Ticketmaster with a specific moment they become public. Most systems track "events I've seen before" by comparing against a database, which conflates "newly announced" with "events I haven't recorded yet"—mixing real announcements with months of backlog noise.

### The Solution
We query Ticketmaster's **announcement timeline**, not snapshots. For each venue, we ask: "What events *became publicly visible* since we last checked?" Ticketmaster's API returns exactly that via a timestamp filter, so we get pure signal: genuinely new announcements, not database gaps.

---

## Discovery Workflow

### Step 1: Resolve Venue → Ticketmaster ID
When you add a venue, we query Ticketmaster once to map your venue name to its unique Ticketmaster ID (e.g., "Madison Square Garden" → `id: 4332` in their system). This ID never changes, so we store it and reuse it forever.

### Step 2: Query for New Announcements
On each run, we ask: "Show me events at this venue that *became publicly visible* in the last 24 hours." Ticketmaster returns only those—a clean list of genuine announcements.

### Step 3: Extract Critical Dates
From each event, we capture:
- **Event Date** — when the show happens
- **Announcement Date** — when Ticketmaster published the listing
- **On-Sale Date** — when tickets become available
- **Event Details** — name, venue, URL

### Step 4: Alert on New Announcements
We record each newly-announced event and surface it to you with both dates: when the event happens *and* when tickets go live. This gives you the jump on arbitrage opportunities.

---

## Why This Matters

### Demand Predictability
Major events drive parking demand spikes. By detecting announcements *early*—before the market adjusts—you can position inventory at affected venues before prices shift.

### On-Sale Timing
Tickets going on sale is the moment demand accelerates. We surface that exact timing so you can adjust pricing proactively.

### No Backlog Noise
Unlike systems that show "events not yet in my database," we show "events Ticketmaster just announced." This means you see signal, not noise.

---

## Example

**Announcement:** Concert announced at Madison Square Garden on June 15, on-sale June 20.

**What You See:**
- Announcement Date: June 15
- Event Date: August 20
- Tickets On-Sale: June 20

**What You Do:**
- June 15: Venue's event load increases (announced)
- June 20: Demand spike as tickets go on sale
- August 20: Peak parking demand (event date)

You can align your pricing strategy to each phase.

---

## Data Points Captured

For each newly-announced event, you get:

| Field | Example | Use |
|-------|---------|-----|
| **Event Name** | "Concert: The Weeknd" | Marketing / identification |
| **Event Date** | 2026-08-15 20:00 | Parking demand forecast |
| **Announced** | 2026-06-10 14:30 | Signal recency |
| **Tickets On-Sale** | 2026-06-15 10:00 | Demand inflection point |
| **Venue** | Madison Square Garden | Correlation with your parking data |
| **Link** | ticketmaster.com/... | Deep dive into event details |

---

## Discovery Rules

We track events that:
- ✅ Became publicly announced in the last 24 hours (or since last run)
- ✅ Are at one of your tracked venues
- ✅ Have a confirmed on-sale date

We skip:
- ❌ Events announced months ago (handled on first venue setup)
- ❌ Events at venues you're not tracking
- ❌ Ticketmaster data gaps or errors (logged and skipped)

---

## Limitations & Transparency

**What We Don't Have:**
- Presale access (we track public on-sale only)
- Real-time updates (we poll every 24 hours, so there's a ~24h detection window)
- Events listed on non-Ticketmaster platforms (StubHub, AXS, etc.)

**How Accuracy Improves:**
- First venue setup captures 3 months of historical events (so you have context)
- Subsequent runs capture only announcements made since last poll
- Deduplication by Ticketmaster's event ID prevents repeats

---

## Getting Started

1. **Add your venues** in the dashboard (name, address, coordinates)
2. **Run event discovery** (manually or on a schedule)
3. **Review announced events** — see new events, on-sale dates, and parking impact
4. **Adjust strategy** — align pricing to demand inflection points

---

## FAQ

**Q: Why do I see old events on first run?**  
A: We capture the last 3 months of announcement history so you have context. Subsequent runs show only events announced in the last 24 hours.

**Q: How often do you poll?**  
A: We recommend running discovery once per day. You can run manually any time, or set up a scheduled job.

**Q: What if Ticketmaster's data is wrong?**  
A: We surface what they publish. If an event's date or on-sale time is incorrect upstream, we'll mirror that error. Always cross-check with Ticketmaster directly for critical decisions.

**Q: Can you track non-Ticketmaster venues?**  
A: Only if those venues also list on Ticketmaster. If a venue only uses AXS or StubHub, we can't detect their events yet.
