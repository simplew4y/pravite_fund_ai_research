import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { LoginGate } from "./LoginGate";

const baseInfo = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  workflow_store: true,
  insights_store: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("LoginGate", () => {
  it("renders children directly in development mode", async () => {
    stubFetch({ "GET /v1/info": baseInfo });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    expect(await screen.findByText("content")).toBeInTheDocument();
  });

  it("shows the login form when cloud accounts reject the session", async () => {
    stubFetch({
      "GET /v1/info": { ...baseInfo, auth_mode: "cloud", accounts_enabled: true },
    });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    expect(await screen.findByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });
});
