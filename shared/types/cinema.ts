import type { Showing } from "./showing";

export interface Cinema {
    name: string;
    showing: Record<string, Showing[]>;
    id: number;
  }