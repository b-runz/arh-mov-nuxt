// Define the type for the TMDB API response
interface TMDBResponse {
    movie_results?: Array<{
        poster_path: string | null;
    }>;
}

export async function get_poster_url(tt: string, tmdbApiKey: string) : Promise <string> {

    const bearer : string = tmdbApiKey;

    const url = `https://api.themoviedb.org/3/find/${tt}?external_source=imdb_id&language=en-US`;

    // A network hiccup or transient TMDB rate-limit here must not throw:
    // the caller does `await get_poster_url(...) || match.tmdbPosterUrl`,
    // so an unhandled rejection would skip that fallback entirely (which is
    // otherwise already-available, no-extra-request data) instead of
    // falling through to it -- turning one flaky request into a
    // permanently missing poster instead of just a missed optimization.
    let response: TMDBResponse;
    try {
        response = await $fetch<TMDBResponse>(url, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${bearer}`
            }
        });
    } catch (error) {
        const status = (error as any)?.response?.status ?? (error as any)?.statusCode ?? "no response";
        console.warn(`[tmdb_poster] find/${tt} failed (status: ${status}): ${(error as Error)?.message ?? error}`);
        return "";
    }

    if (response.movie_results && response.movie_results.length > 0) {
        const firstMovie = response.movie_results[0];
        if (firstMovie && firstMovie.poster_path) {
            return `https://image.tmdb.org/t/p/w500${firstMovie.poster_path}`;
        }
    }

    // Distinct from the catch above: the request succeeded, so this is TMDB
    // genuinely having no cross-linked result or no poster for this id --
    // not a network/rate-limit problem. Logged separately so the two causes
    // aren't conflated when reading the build output.
    console.warn(`[tmdb_poster] find/${tt} returned no usable poster (movie_results: ${response.movie_results?.length ?? 0})`);
    return "";
}