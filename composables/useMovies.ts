import type { Movie } from '~/shared/types/movie';
import { processData } from '~/shared/utils/app';

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

export const useMovies = async () => {
  // Use asyncData to fetch at build time and embed in static HTML
  const { data: movies } = await useAsyncData<Movie[]>('movies', async () => {
    try {
      const config = useRuntimeConfig();
      const response = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { locations: ['Aarhus', 'Trøjborg'] } })
      });
      const data = await response.json();
      return await processData(data, config.tmdbApiKey as string);
    } catch (error) {
      console.error('Failed to fetch movies:', error);
      return [];
    }
  });

  return movies;
};