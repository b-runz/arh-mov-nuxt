import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MovieCache } from "~/shared/utils/movieCache";

export async function loadMovieCache(path: string): Promise<MovieCache> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MovieCache) : {};
  } catch {
    return {};
  }
}

export async function saveMovieCache(path: string, cache: MovieCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
}
