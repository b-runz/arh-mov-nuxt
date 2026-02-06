// Define the type for the TMDB API response
interface TMDBResponse {
    movie_results?: Array<{
        poster_path: string | null;
    }>;
}

export async function get_poster_url(tt: string, tmdbApiKey: string) : Promise <string> {

    const bearer : string = tmdbApiKey;

    const url = `https://api.themoviedb.org/3/find/${tt}?external_source=imdb_id&language=en-US`;

    const response = await $fetch<TMDBResponse>(url, {
        method: 'GET',
        headers: {
            'accept': 'application/json',
            'Authorization': `Bearer ${bearer}`
        }
    });

    if (response.movie_results && response.movie_results.length > 0) {
        const firstMovie = response.movie_results[0];
        if (firstMovie && firstMovie.poster_path) {
            return `https://image.tmdb.org/t/p/w500${firstMovie.poster_path}`;
        }
    }
    
    return "";
}