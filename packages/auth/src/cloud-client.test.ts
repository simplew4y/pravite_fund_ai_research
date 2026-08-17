import { describe, expect, it } from "vitest";

import { CloudAccountClient, CloudAccountError } from "./cloud-client.js";

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): CloudAccountClient {
  return new CloudAccountClient({
    baseUrl: "https://cloud.example/backend",
    fetchImplementation: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)) as typeof fetch,
  });
}

describe("CloudAccountClient raw endpoints", () => {
  it("treats 204 No Content as success (password reset contract)", async () => {
    const client = clientWith(
      () => new Response(null, { status: 204 }),
    );
    const result = await client.resetPassword({
      email: "user@example.com",
      code: "123456",
      password: "newpassword1",
    });
    expect(result.status).toBe(204);
    expect(result.payload).toEqual({ ok: true });
  });

  it("passes JSON payloads through with their upstream status", async () => {
    const client = clientWith(
      () =>
        new Response(
          JSON.stringify({ code: "invalid_or_expired_verification_code" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await client.resetPassword({
      email: "user@example.com",
      code: "000000",
      password: "newpassword1",
    });
    expect(result.status).toBe(400);
    expect(result.payload).toMatchObject({
      code: "invalid_or_expired_verification_code",
    });
  });

  it("maps reset requests onto the cloud contract (new_password field)", async () => {
    let seenBody: unknown;
    let seenUrl = "";
    const client = clientWith((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    });
    await client.resetPassword({
      email: "USER@Example.com ",
      code: "123456",
      password: "newpassword1",
    });
    expect(seenUrl).toBe(
      "https://cloud.example/backend/api/v1/auth/password/reset",
    );
    expect(seenBody).toEqual({
      email: "user@example.com",
      code: "123456",
      new_password: "newpassword1",
    });
  });

  it("send-code accepts empty 2xx bodies and JSON bodies alike", async () => {
    const jsonClient = clientWith(
      () =>
        new Response(JSON.stringify({ ok: true, resend_after: 60 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      (await jsonClient.sendPasswordResetCode("user@example.com")).payload,
    ).toMatchObject({ resend_after: 60 });

    const emptyClient = clientWith(() => new Response(null, { status: 202 }));
    expect(
      (await emptyClient.sendRegistrationCode("user@example.com")).payload,
    ).toEqual({ ok: true });
  });

  it("still fails closed on unparseable error responses", async () => {
    const client = clientWith(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(
      client.resetPassword({
        email: "user@example.com",
        code: "123456",
        password: "newpassword1",
      }),
    ).rejects.toThrow(CloudAccountError);
  });
});
