# citemaps.org registry

Public catalog of citemap.json files on the open web. The neutral
index layer of the citemap spec — separate from any single AEO
tool so the registry stays governance-credible as the ecosystem
grows.

This Phase 1 build covers:

- `POST /api/registry/submit` — accept a citemap URL, validate it,
  index it.
- `GET /api/registry/status/{id}` — poll submission status.

Storage: Vercel KV (Upstash) for v1. Migrates to Postgres in
Phase 2+ as faceted-search needs grow.

## Architecture

```
Studio (citemaps.ai) ─┐
Manual API caller    ─┤─→ POST /api/registry/submit
Domain-probe worker  ─┘                │
(Phase 3)                              ▼
                              ┌────────────────┐
                              │ Validation     │
                              │ - fetch URL    │
                              │ - detect format│
                              │ - parse        │
                              │ - extract meta │
                              └───────┬────────┘
                                      ▼
                              ┌────────────────┐
                              │ KV persistence │
                              │ - reg:{id}     │
                              │ - reg-by-url   │
                              │ - reg-recent   │
                              └────────────────┘
```

## Local dev

```bash
npm install
vercel env pull .env.local     # one-time, after Vercel KV is set up
npm run dev
# http://localhost:3000
```

Submit a citemap:
```bash
curl -X POST http://localhost:3000/api/registry/submit \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/citemap.json", "source": "manual_api"}'
```

## Deployment

Vercel project. DNS: `api.citemaps.org` CNAMEs to the Vercel
deployment. KV: provisioned via Vercel Storage tab. Env vars
auto-populate.

## Spec context

The citemap.json spec lives at https://citemaps.org (the
GitHub-hosted spec docs site). This registry is the runtime
counterpart — the index that makes citemaps discoverable. See
the `citemaps-org-registry` ADR in the CiteMaps vault for the
full architectural rationale.

## What's NOT in Phase 1

- Public index pages (`/registry/{domain}`) — Phase 2
- Auto-discovery via customer-domain seeding — Phase 3
- Verification + claim flow (`citationContract.registryToken`)
  — Phase 4
- Common Crawl mining — Phase 5

## License

MIT.
