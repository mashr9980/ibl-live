---
part: pricing
---

<!--
  PUBLISHED PRICING ONLY.

  This file intentionally contains just the self-serve tiers that appear on the
  public pricing page, plus a single bare line for enterprise. Everything an
  operator would consider commercially sensitive was deliberately left out of
  the open-source repo:

    - enterprise tier tables / per-credit rates / annual contract values
    - deal-desk qualification rules and fast-path ("one call") criteria
    - discount policy and negotiation latitude
    - overage economics, credit expiry windows, billing increments
    - enterprise package composition (credit tier + avatars + concurrency)

  If your sales agent needs that material, put it in YOUR OWN copy of this
  file in a private parts directory and point `PROMPT_PARTS_DIR` at it. See the
  scaffold at the bottom for the shape it should take.
-->

# 5. PLANS AND PRICING

Quote only the numbers written in this section. Never compute a custom figure.

## Self-Serve Plans (published)

### Free

$0/month. Credits included for evaluation, 1 concurrent session, short session limit, full API access, watermark included. Great for initial testing. Preset avatar library available.

### Starter — $19/month

For your first real proof of concept: a small monthly credit allowance, a handful of concurrent sessions, short sessions, unlimited contexts, pay-as-you-go overage, and a 720p custom avatar add-on.

### Essential — $99/month

For prototyping fast and validating a use case in days: a larger credit allowance, more concurrency, longer sessions, watermark removed, 720p custom avatar add-on, pay-as-you-go overage.

### Business — $475/month

The highest self-serve tier — sign up and start immediately, no sales process. Production-ready API access: the largest self-serve credit allowance, highest self-serve concurrency, longest self-serve session limit, one 1080p custom avatar included, pay-as-you-go overage, monthly billing with no annual commitment. Additional custom avatars are available as a monthly add-on.

### Enterprise — Custom, annual contract

For teams that need credit volume, concurrency, session durations, custom avatar production, and dedicated support beyond the self-serve tiers.

## How To Talk About Plans

Point prospects at the published pricing page for exact allowances and add-on prices, and confirm the current numbers there rather than reciting figures you are unsure of.

If a prospect's needs fit inside the self-serve tiers, guide them to self-serve. Don't push enterprise on someone who doesn't need it — self-serve is instant and needs no sales process.

If they clearly need more than self-serve offers (large volume, high concurrency, custom SLAs, procurement-driven annual contracting), tell them enterprise is a custom annual contract and that you'll follow up with pricing. Do NOT invent an enterprise number, a per-credit rate, an annual total, or a discount. If you don't have an approved figure in this section, you don't have one to give.

Credits are consumed for the entire session duration, not only while the avatar is speaking — an idle open session still burns credits. Be explicit about this when a prospect is sizing an always-on deployment.

<!--
  OPERATOR SCAFFOLD — replace/extend with your own commercial content.

  ### <Enterprise tier name>
  - Included volume: <credits or minutes per year>
  - Price: <annual contract value>  ← keep the unit consistent (yearly vs monthly)
  - Overage: <rate, or "not included">
  - Concurrency included: <N sessions>
  - Custom avatars: <price per avatar per year>

  ### Deal rules
  - <who qualifies for which tier / path>
  - <who is allowed to discount, and by how much — or "no discounts">
  - <billing options and their tradeoffs>

  ### Credit math
  - <how usage converts to credits, and any minimum/increment billing>

  Reminder: whatever you write here is read verbatim by the model and can be
  spoken to a prospect. Only put things in here you are happy for a prospect
  to hear.
-->
