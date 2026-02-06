import type { Movie } from '~/shared/types/movie';
import { processData } from '~/shared/utils/app';

export const useMovies = async () => {
  // Use asyncData to fetch at build time and embed in static HTML
  const { data: movies } = await useAsyncData<Movie[]>('movies', async () => {
    try {
      const config = useRuntimeConfig();
      const response = await fetch('https://api.kino.dk/ticketflow/showtimes?format=json&region=content&city=94-70-55-79&sort=alphabetical');
      const data = await response.json();
      return await processData(data, config.tmdbApiKey as string);
    } catch (error) {
      console.error('Failed to fetch movies:', error);
      return [];
    }
  });
  
  return movies;
};