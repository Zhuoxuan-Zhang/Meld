import { test, expect } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { suggestionsApi } from "../server/suggestions";
import { exampleSuggestion } from "../src/suggestions";

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

test("overlapping request bodies cannot start two model calls", async ({
  request,
}) => {
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const api = await serve(async () => {
    calls++;
    await gate;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(exampleSuggestion(["Productivity"])),
            },
          },
        ],
      }),
    );
  });
  try {
    let completeSlow!: (status: number) => void;
    const slowResponse = new Promise<number>((resolve) => {
      completeSlow = resolve;
    });
    const slow = httpRequest(
      api.address + "/api/ai/suggest",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        completeSlow(res.statusCode!);
      },
    );
    slow.write('{"domains":');
    const fastResponse = request.post(api.address + "/api/ai/suggest", {
      data: body,
    });
    await expect.poll(() => calls).toBe(1);
    slow.end('["Productivity"],"goal":"Plan my day"}');
    expect(await slowResponse).toBe(429);
    expect(calls).toBe(1);
    finish();
    expect((await fastResponse).status()).toBe(200);
  } finally {
    finish();
    await api.close();
  }
});
async function serve(
  transport: typeof fetch,
  env: Record<string, string> = { OPENROUTER_API_KEY: "server-only-test-key" },
) {
  const plugin = suggestionsApi(env, transport);
  let middleware: Middleware;
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: {
      use(handler: Middleware) {
        middleware = handler;
      },
    },
  });
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return { address, close };
}
const body = { domains: ["Productivity"], goal: "Help me focus on my tasks." };

test("local API keeps the key server-side and validates a real provider-shaped response", async ({
  request,
}) => {
  let sent: RequestInit | undefined;
  const plan = exampleSuggestion(["Productivity"])!;
  const api = await serve(async (_url, init) => {
    sent = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(plan) } }],
      }),
    );
  });
  try {
    const status = await request.get(api.address + "/api/ai/status");
    expect(await status.json()).toMatchObject({
      available: true,
      provider: "OpenRouter",
    });
    expect(await status.text()).not.toContain("server-only-test-key");
    const response = await request.post(api.address + "/api/ai/suggest", {
      data: body,
      headers: { Origin: api.address },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).plan).toMatchObject({
      name: plan.name,
      source: "ai",
    });
    expect(await response.text()).not.toContain("server-only-test-key");
    expect(new Headers(sent?.headers).get("Authorization")).toBe(
      "Bearer server-only-test-key",
    );
    const upstream = JSON.parse(sent!.body as string);
    expect(upstream.response_format.type).toBe("json_schema");
    expect(upstream.messages[1].content).toContain(body.goal);
    expect(upstream.messages[1].content).not.toContain("server-only-test-key");
    expect(
      JSON.parse(upstream.messages[1].content).catalog.map(
        (a: { id: string }) => a.id,
      ),
    ).toEqual(["forest", "ticktick", "notion"]);
  } finally {
    await api.close();
  }
});

test("local API rejects invalid input and cross-origin requests before calling the provider", async ({
  request,
}) => {
  let calls = 0;
  const api = await serve(async () => {
    calls++;
    throw new Error("Must not call provider");
  });
  try {
    for (const [data, status] of [
      [{}, 400],
      [{ ...body, goal: "x".repeat(601) }, 400],
      [{ ...body, domains: ["Gardening"] }, 422],
      [null, 400],
    ] as const) {
      const response = await request.post(api.address + "/api/ai/suggest", {
        data: JSON.stringify(data),
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status()).toBe(status);
    }
    expect(
      (
        await request.post(api.address + "/api/ai/suggest", {
          data: body,
          headers: { Origin: "https://unrelated.example" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post(api.address + "/api/ai/suggest", {
          data: "invalid",
          headers: { "Content-Type": "text/plain" },
        })
      ).status(),
    ).toBe(415);
    expect(
      (
        await request.post(api.address + "/api/ai/suggest", {
          data: "{",
          headers: { "Content-Type": "application/json" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.post(api.address + "/api/ai/suggest", {
          data: { ...body, goal: "x".repeat(17000) },
        })
      ).status(),
    ).toBe(413);
    expect(calls).toBe(0);
  } finally {
    await api.close();
  }
});

test("missing keys, provider errors, malformed responses and invented features produce safe errors", async ({
  request,
}) => {
  const missing = await serve(async () => {
    throw new Error("Must not call provider");
  }, {});
  try {
    expect(
      (await (await request.get(missing.address + "/api/ai/status")).json())
        .available,
    ).toBe(false);
    expect(
      (
        await request.post(missing.address + "/api/ai/suggest", { data: body })
      ).status(),
    ).toBe(503);
  } finally {
    await missing.close();
  }
  const plan = exampleSuggestion(["Productivity"])!;
  const cases: [Response | Error, string][] = [
    [new Response("", { status: 401 }), "key was rejected"],
    [new Response("", { status: 402 }), "needs credits"],
    [new Response("", { status: 429 }), "provider is busy"],
    [new Response("", { status: 500 }), "could not complete"],
    [new Response("not json"), "incomplete plan"],
    [
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
      ),
      "incomplete plan",
    ],
    [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...plan,
                  features: [
                    { appId: "forest", featureId: "invented", reason: "fake" },
                    ...plan.features.slice(1),
                  ],
                }),
              },
            },
          ],
        }),
      ),
      "incomplete plan",
    ],
    [new Error("secret internal provider detail"), "Could not reach"],
  ];
  for (const [result, message] of cases) {
    const api = await serve(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    try {
      const response = await request.post(api.address + "/api/ai/suggest", {
        data: body,
      });
      expect(response.status()).toBe(502);
      expect((await response.json()).error).toContain(message);
      expect(await response.text()).not.toContain("secret internal");
    } finally {
      await api.close();
    }
  }
});

test("a second generation is blocked while one is running and cancellation releases the slot", async ({
  request,
}) => {
  let entered = false;
  const api = await serve(async (_url, init) => {
    entered = true;
    await new Promise((_resolve, reject) =>
      init!.signal!.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      ),
    );
    throw new Error("unreachable");
  });
  try {
    const controller = new AbortController();
    const first = fetch(api.address + "/api/ai/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => entered).toBe(true);
    expect(
      (
        await request.post(api.address + "/api/ai/suggest", { data: body })
      ).status(),
    ).toBe(429);
    controller.abort();
    await first;
    await expect
      .poll(async () =>
        (
          await request.post(api.address + "/api/ai/suggest", {
            data: { ...body, goal: 123 },
          })
        ).status(),
      )
      .toBe(400);
  } finally {
    await api.close();
  }
});
