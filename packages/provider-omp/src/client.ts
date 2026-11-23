import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "Oh My Pi",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M12 1a11 11 0 1 0 0 22a11 11 0 1 0 0-22zm0 2.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17z",
        fillRule: "evenodd",
      },
      { d: "M7 7.5h10v2.25H7z" },
      { d: "M8.75 9.75h2.25v7.25H8.75z" },
      { d: "M13 9.75h2.25v5.25c0 .4.3.75.75.75h.5v1.25h-1.25A2.25 2.25 0 0 1 13 14.75z" },
    ],
  },
});
