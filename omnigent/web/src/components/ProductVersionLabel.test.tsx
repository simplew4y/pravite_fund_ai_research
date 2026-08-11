import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CapabilitiesContext } from "@/lib/CapabilitiesContext";
import type { ServerInfo } from "@/lib/capabilities";
import { ProductVersionLabel } from "./ProductVersionLabel";

const info: ServerInfo = {
  accounts_enabled: true,
  cloud_accounts_enabled: true,
  login_url: "/login",
  needs_setup: false,
  registration_mode: "open",
  databricks_features: false,
  managed_sandboxes_enabled: false,
  sandbox_provider: null,
  server_version: "0.3.0.dev0",
  product_version: "0.2.1",
  smart_routing_enabled: false,
  llm_configuration_enabled: true,
};

describe("ProductVersionLabel", () => {
  it("renders the product release reported by the server", () => {
    render(
      <CapabilitiesContext.Provider value={info}>
        <ProductVersionLabel />
      </CapabilitiesContext.Provider>,
    );

    expect(screen.getByTestId("product-version")).toHaveTextContent("v0.2.1");
  });

  it("stays hidden when the capability probe has no product version", () => {
    render(
      <CapabilitiesContext.Provider value={{ ...info, product_version: null }}>
        <ProductVersionLabel />
      </CapabilitiesContext.Provider>,
    );

    expect(screen.queryByTestId("product-version")).toBeNull();
  });
});
