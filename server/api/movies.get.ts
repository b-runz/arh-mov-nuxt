import { processData } from '~/shared/utils/app';
import { MOVIE_CACHE_PATH } from '~/shared/utils/movieCache';
import { loadMovieCache, saveMovieCache } from '~/server/utils/movieCacheStorage';
import type { Movie } from '~/shared/types/movie';

// api.kino.dk (the old Drupal-backed showtimes endpoint) is down; this hits
// the same GraphQL schedule API kino2 uses instead (see kino2/cinema-schedule.bru).
const GRAPHQL_ENDPOINT = 'https://kinodk-movieinfoqs.azurewebsites.net/graphql';

const QUERY = `
  query($locations: [String]) {
    movieQuery {
      getCurrentMovies(locations: $locations removePastShows: true) {
        title
        titleOriginal
        mainVersionId
        premiere
        productionYear
        nationalities
        lengthInMinutes
        sanityImagePosterUrl
        shows {
          theaterName
          theaterId
          showStart
          ticketSaleUrl
        }
      }
    }
  }
`;

export default defineEventHandler(async (): Promise<Movie[]> => {
  const config = useRuntimeConfig();
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { locations: ['Aarhus', 'Trøjborg'] } })
    });
    const data = await response.json();

    const cache = await loadMovieCache(MOVIE_CACHE_PATH);
    const result = await processData(data, config.tmdbApiKey as string, cache);
    await saveMovieCache(MOVIE_CACHE_PATH, cache);
    return result;
  } catch (error) {
    console.error('Failed to fetch movies:', error);
    return [];
  }
});
