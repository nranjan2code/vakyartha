# Project Activity Desk

A working view of a public repository: recently updated issues, open pull requests and recent commits, charts of the sample, and local triage lanes for planning your attention. Records are read through the governed Web pages integration from the public repository API; triage never writes back, and actions make no model request.

## Connect

In **Settings → Integrations**, enable **Web pages** and set `fetch_page` to **Allow**. Open **Apps → Project Activity Desk**, type a public `owner/repository` (a full repository URL also works) and press **Refresh**. Until a read succeeds the Triage view says exactly this.

## Views

| View | What it shows |
| --- | --- |
| **Triage** | Repository field and **Refresh**; counts for open and closed issues, open pull requests and commits in the sample; charts of issues by state (pie), by label and by last-update day; a board of open issues in Review, Next and Watch lanes (drag, or use the keyboard); the issue table with numbers, labels, authors and update times. |
| **Activity** | Commits per day; recent commits as a timeline with author and short SHA links, beside the open pull requests table. |
| **Sources** | The latest 24 reads with URL, retrieval time, rows and status. |

Moving a card saves immediately. Changing the repository takes effect when you press Refresh and starts a fresh sample and empty lanes. A refresh in which some reads fail shows a warning naming the first failure and keeps earlier records.

## Sample and limits

Each refresh reads up to 20 recently updated issues (pull requests excluded), 10 open pull requests and 10 commits. Counts and charts describe this sample, not the whole backlog or throughput. Unauthenticated public API rate limits apply. A 15-minute refresh is declared but off until you enable it under **Manage**.

## Data

Records, lanes and receipts live in app state and are saved only when a run succeeds. Lanes are kept for issues that are still open in the sample.
