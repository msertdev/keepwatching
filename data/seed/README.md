# data/seed/

Seed measurements — one creator's channel, offered as a starting point.

**This directory is empty on purpose.** The repo is being published before its
seed data exists, because the alternative was publishing numbers ahead of the
CSVs that back them.

When seed data lands here it will be:

- `mapping-seed.csv` — the published-video → variant-id join for the seed set
- `samples-seed.json` — the normalised samples, exactly as `kw measure ingest`
  wrote them
- `NOTES.md` — the confounds: follower band, platform, posting cadence, and
  which topics ran through which formats

To fold it into a fresh clone:

```bash
cp data/seed/mapping-seed.csv measure/mapping.csv
cp data/seed/samples-seed.json measure/normalized/samples.json
npx kw measure report && npx kw measure apply
```

## Read this before trusting any of it

Seed data comes from **one account, one niche, one posting rhythm**. It is
enough to rank formats *against each other on that channel*, and not enough to
tell you what will happen on yours. The audience is different, the push is
different, and the topics are confounded with the formats.

That is the whole reason `kw measure` exists as a user-facing command rather
than a maintainer script: your own numbers beat the seed's, and sending them
back makes the ranking mean something.
