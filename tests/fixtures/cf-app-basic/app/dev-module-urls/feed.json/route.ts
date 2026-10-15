// Shares its path with dev-module-urls/feed.json in the project root, which
// dev must not serve in place of this route.
export function GET() {
  return Response.json({ from: "route" });
}
