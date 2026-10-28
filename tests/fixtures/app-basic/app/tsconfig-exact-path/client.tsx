"use client";

import { useEffect, useState } from "react";
import { entrySource } from "fake-tsconfig-exact-lib";
import { runtimeSource } from "fake-tsconfig-exact-lib/runtime";

export function TsconfigExactPathClient() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <div data-testid="client" data-hydrated={hydrated ? "true" : undefined}>
      <p data-testid="client-entry">{entrySource}</p>
      <p data-testid="client-runtime">{runtimeSource}</p>
    </div>
  );
}
