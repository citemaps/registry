// Minimal landing page. The real public-facing surface for
// citemaps.org lives on the static GitHub Pages site at the
// apex. This API host (api.citemaps.org) just needs SOMETHING
// at / so curious visitors don't get a 404.

export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
        lineHeight: 1.6,
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#666",
            marginBottom: 4,
          }}
        >
          citemaps.org · registry
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>
          Citemap registry API
        </h1>
      </header>

      <p style={{ fontSize: 15 }}>
        This is the API host for the public registry of citemap.json files
        on the open web. The spec itself lives at{" "}
        <a href="https://citemaps.org" style={{ color: "#0066cc" }}>
          citemaps.org
        </a>
        .
      </p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>
        Endpoints
      </h2>
      <ul style={{ fontSize: 14, paddingLeft: 20 }}>
        <li>
          <code>POST /api/registry/submit</code> — register a citemap URL
        </li>
        <li>
          <code>GET /api/registry/status/{"{"}id{"}"}</code> — poll
          submission status
        </li>
      </ul>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>
        Submit a citemap
      </h2>
      <pre
        style={{
          background: "#f0f0f0",
          padding: 16,
          borderRadius: 4,
          overflowX: "auto",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
{`curl -X POST https://api.citemaps.org/api/registry/submit \\
  -H 'Content-Type: application/json' \\
  -d '{"url": "https://your-domain.com/citemap.json"}'`}
      </pre>

      <p style={{ fontSize: 13, color: "#666", marginTop: 48 }}>
        Phase 1. Public index + faceted browse + verification flow land in
        subsequent phases.
      </p>
    </main>
  );
}
