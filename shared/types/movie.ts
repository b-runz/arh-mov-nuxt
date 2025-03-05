import type { Cinema } from "./cinema";
import type { Moment } from 'moment';
export interface Movie {
    title: string;
    imdb_link: string;
    imdb_rating: string;
    id: string;
    cinemas: Record<number, Cinema>;
    poster: string;
    release_date: Moment,
    display_release_date: string
  }