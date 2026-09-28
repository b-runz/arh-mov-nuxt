import { fetchWithRetry } from "./fetchRetry";

// Define the type for the TMDB API response
interface TMDBResponse {
    movie_results?: Array<{
        poster_path: string | null;
        overview?: string;
        original_language?: string;
    }>;
}

export interface MovieMetadata {
    poster: string;
    plot: string;
    language: string;
}

const EMPTY_METADATA: MovieMetadata = { poster: "", plot: "", language: "" };

// Fetched for every matched movie regardless of whether the feed already
// supplied a poster -- plot/language aren't available from any other
// source, so this is the only chance to ever pick them up.
export async function get_movie_metadata(tt: string, tmdbApiKey: string): Promise<MovieMetadata> {

    const bearer : string = tmdbApiKey;

    const url = `https://api.themoviedb.org/3/find/${tt}?external_source=imdb_id&language=en-US`;

    // A network hiccup or transient TMDB rate-limit here must not throw:
    // the caller does `await get_movie_metadata(...) || ...`, so an
    // unhandled rejection would skip that fallback entirely instead of
    // falling through to it. fetchWithRetry already retries transient
    // failures (network errors, rate limiting, 5xx) before giving up, so
    // this only triggers on a persistent failure or a genuine client error.
    let response: TMDBResponse;
    try {
        const res = await fetchWithRetry(url, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${bearer}`
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        response = await res.json() as TMDBResponse;
    } catch (error) {
        console.warn(`[tmdb_poster] find/${tt} failed: ${(error as Error)?.message ?? error}`);
        return EMPTY_METADATA;
    }

    const firstMovie = response.movie_results?.[0];
    if (!firstMovie) {
        // Distinct from the catch above: the request succeeded, so this is
        // TMDB genuinely having no cross-linked result for this id -- not a
        // network/rate-limit problem. Logged separately so the two causes
        // aren't conflated when reading the build output.
        console.warn(`[tmdb_poster] find/${tt} returned no usable result (movie_results: ${response.movie_results?.length ?? 0})`);
        return EMPTY_METADATA;
    }

    return {
        poster: firstMovie.poster_path ? `https://image.tmdb.org/t/p/w500${firstMovie.poster_path}` : "",
        plot: firstMovie.overview ?? "",
        language: firstMovie.original_language ?? "",
    };
}
