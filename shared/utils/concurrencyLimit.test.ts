import { describe, test, expect } from "bun:test";
import { runWithConcurrencyLimit } from "./concurrencyLimit";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWithConcurrencyLimit", () => {
  test("runs every task and returns results in the original order", async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
      await sleep(Math.random() * 5);
      return n * 10;
    });

    const results = await runWithConcurrencyLimit(tasks, 2);

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test("never runs more than the given limit concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return i;
    });

    await runWithConcurrencyLimit(tasks, 3);

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually exercised some concurrency
  });

  test("handles a limit larger than the number of tasks", async () => {
    const tasks = [1, 2].map((n) => async () => n);
    const results = await runWithConcurrencyLimit(tasks, 10);
    expect(results).toEqual([1, 2]);
  });

  test("returns an empty array for no tasks", async () => {
    const results = await runWithConcurrencyLimit([], 5);
    expect(results).toEqual([]);
  });

  test("propagates a task's rejection", async () => {
    const tasks = [async () => 1, async () => { throw new Error("boom"); }, async () => 3];
    await expect(runWithConcurrencyLimit(tasks, 2)).rejects.toThrow("boom");
  });
});
