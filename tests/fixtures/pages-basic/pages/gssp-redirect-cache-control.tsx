import type { GetServerSideProps } from "next";

// A getServerSideProps redirect that sets its own Cache-Control. Next.js keeps
// it instead of applying the private/no-store getServerSideProps default, but
// treats an empty value (`?empty=true`) as unset.
export default function GsspRedirectCacheControlPage() {
  return <h1 data-testid="redirect-page">Redirect Page</h1>;
}

export const getServerSideProps: GetServerSideProps = async ({ query, res }) => {
  res.setHeader("Cache-Control", query.empty === "true" ? "" : "public, s-maxage=60");
  return {
    redirect: {
      destination: "/gssp-redirect-target",
      permanent: true,
    },
  };
};
