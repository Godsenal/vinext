import type { NextApiRequest, NextApiResponse } from "next";

// Used by Vitest: pages-router.test.ts. Next.js applies next.config headers to
// `res` before the API handler runs, so the handler can read and extend them.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const link = res.getHeader("Link");
  res.setHeader("Link", `${link}, <https://example.com/doc>; rel="canonical"`);
  res.setHeader("x-config-override", "handler");
  res.status(200).json({ link: link ?? null });
}
