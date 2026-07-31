import type { Movie } from '~/shared/types/movie';

export const useMovies = async () => {
  const { data: movies } = await useFetch<Movie[]>('/api/movies');
  return movies;
};
