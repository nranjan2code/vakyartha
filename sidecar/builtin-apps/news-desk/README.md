# News Desk

Headlines from publisher feeds you choose, newest first, with links to the original reporting, a reading list, and charts of what the feeds are covering. Feeds are read through the governed Web pages integration; nothing is summarized, rewritten or invented, and actions make no model request.

## Connect

In **Settings → Integrations**, enable **Web pages** and set `fetch_page` to **Allow**. Then open **Apps → News Desk** and press **Refresh**. Until a read succeeds the Headlines view says exactly this, with a link to review the feeds.

## Views

| View | What it shows |
| --- | --- |
| **Headlines** | Category filter and **Refresh**; a searchable grid of article cards (headline, feed, category, publication time, excerpt, **Read original**, **Save for later**) beside a Coverage panel with articles by category (pie), by publication day and by feed. On a phone the panel moves below the cards. |
| **Reading list** | Saved articles, searchable, each with **Remove**. Saved articles stay even after they leave the feed. |
| **Sources** | Your feeds as cards with **Remove**; name, category and URL fields with **Add feed** (up to six); **Restore the default feeds**; the latest 24 reads with time, item count and status. |

A refresh in which some feeds fail shows a warning naming the first failure; their earlier articles keep their original publication and retrieval times.

## Sources and limits

Default feeds are four BBC categories (World, Business, Technology, Science): one publisher, not a diversity claim. Any HTTPS RSS, Atom or JSON Feed (1.0/1.1) without credentials can be added. Up to 60 items per feed, 180 recent articles plus saved ones (240 in all) and 60 saved. Headlines up to 240 characters and excerpts up to 200; full articles and images are never copied. Exact URLs (without `utm_` parameters or fragments) are de-duplicated; the same event at different URLs is not merged. Category and feed names are your labels, not a classification or trust rating.

A 15-minute refresh is declared but off until you enable it under **Manage**; it runs only while the app and computer are awake.

## Data

Feeds, articles, bookmarks and receipts live in app state and are saved only when a run succeeds. Version-1 state (feeds as a JSON string) loads automatically.
