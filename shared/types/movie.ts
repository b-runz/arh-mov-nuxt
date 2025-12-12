import type { Cinema } from "./cinema";

export interface Movie {
    title: string;
    imdb_link: string;
    imdb_rating: string;
    id: string;
    cinemas: Record<number, Cinema>;
    poster: string;
    release_date: string; 
    display_release_date: string
  }