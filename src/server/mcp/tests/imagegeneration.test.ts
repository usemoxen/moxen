import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ClientApi } from "../../api.js";
import { availableMoxenTools, callMoxenTool } from "../tools.js";

it("does not offer image generation without eligibility, or to a delegated task", async () => {
  let available = true;
  const api = { query: vi.fn(async (query: { type: string }) => query.type === "research.run" ? null : ({ available })) } as unknown as ClientApi;
  expect((await availableMoxenTools(api, "parent", {})).some((tool) => tool.name === "image_gen")).toBe(true);
  available = false;
  expect((await availableMoxenTools(api, "parent", {})).some((tool) => tool.name === "image_gen")).toBe(false);
  expect((await availableMoxenTools(api, "parent", { delegated: true })).some((tool) => tool.name === "image_gen")).toBe(false);
  expect((await callMoxenTool(api, "parent", "image_gen", { prompt: "A tree" }, { delegated: true })).isError).toBe(true);
});

it("does not treat an agent's claimed image path or a failed native event as an image", async () => {
  const image = path.resolve("generated.png");
  const api = { query: vi.fn(async (query: { type: string }) => query.type === "thread.task.status" ? { task: { status: "completed", summary: `Saved ${image}` }, child: {}, background: { unknown: false, tasks: [] } } : { thread: { view: "turn-items", items: [
    { payload: { itemType: "image_generation", toolCallId: "one", data: { state: { status: "completed", input: { path: image } } } } },
    { payload: { itemType: "image_generation", toolCallId: "one", data: { state: { status: "failed", input: { path: image } } } } },
  ] } }) } as unknown as ClientApi;
  const response = await callMoxenTool(api, "parent", "image_gen", { taskId: "child", waitMs: 0 });
  expect(response.isError).toBe(true);
  const result = JSON.parse(response.text);
  expect(result.images).toEqual([]);
  expect(result.error).toContain("without a successful image-generation result");
});

it("returns only native image-generation paths after checking task ownership", async () => {
  const image = path.resolve("generated.png");
  const query = vi.fn(async (request: { type: string }) => request.type === "thread.task.status" ? { task: { status: "completed", summary: "done" }, child: {}, background: { unknown: false, tasks: [] } } : { thread: { view: "turn-items", items: [
    { payload: { itemType: "image_generation", toolCallId: "one", data: { state: { status: "completed", input: { path: image } } } } },
  ] } });
  const api = { query } as unknown as ClientApi;
  expect(JSON.parse((await callMoxenTool(api, "parent", "image_gen", { taskId: "child", waitMs: 0 })).text).images).toEqual([image]);
  expect(query.mock.calls[0]?.[0]).toMatchObject({ type: "thread.task.status", parentThreadId: "parent", taskId: "child" });
  query.mockRejectedValueOnce(new Error("not your task"));
  expect((await callMoxenTool(api, "parent", "image_gen", { taskId: "other" })).isError).toBe(true);
  expect(query).toHaveBeenCalledTimes(3);
});
