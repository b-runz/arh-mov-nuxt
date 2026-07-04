
import moment from 'moment';
import type { Movie } from "../types/movie";
import { getRating } from './imdb';
import { resolveImdbId, type KinoMovieInput } from './imdbMatcher';
import { get_poster_url } from './tmdb_poster';

interface ApiShow {
    theaterName: string;
    theaterId: number;
    showStart: string;
    ticketSaleUrl: string;
}

interface ApiMovie {
    title: string;
    titleOriginal: string;
    mainVersionId: string;
    premiere: string;
    productionYear: string;
    nationalities: string[];
    lengthInMinutes: number;
    sanityImagePosterUrl: string;
    shows: ApiShow[];
}

function parseReleaseDate(premiere: string): moment.Moment {
    if (!premiere || premiere.startsWith('0001')) {
        return moment('1900-01-01', 'YYYY-MM-DD');
    }
    const date = moment(premiere);
    return date.isValid() ? date : moment('1900-01-01', 'YYYY-MM-DD');
}

function buildKinoMovieInput(apiMovie: ApiMovie, releaseDate: moment.Moment): KinoMovieInput {
    return {
        title: apiMovie.title,
        titleOriginal: apiMovie.titleOriginal || undefined,
        premiere: releaseDate.isValid() && releaseDate.year() !== 1900 ? releaseDate.toISOString() : undefined,
        productionYear: apiMovie.productionYear || undefined,
        nationalities: apiMovie.nationalities?.length ? apiMovie.nationalities : undefined,
        lengthInMinutes: apiMovie.lengthInMinutes || undefined,
        showCount: apiMovie.shows?.length,
    };
}

// Sanity serves the same placeholder image for every movie that doesn't
// have a real poster yet, but the placeholder's URL isn't a fixed constant
// we can hardcode (it's just whatever asset the CMS happens to use). A real
// poster is unique to its movie, so any sanityImagePosterUrl shared by 2+
// movies in the same batch is a placeholder, not an actual poster.
function findSharedPosterUrls(apiMovies: ApiMovie[]): Set<string> {
    const counts = new Map<string, number>();
    for (const apiMovie of apiMovies) {
        if (apiMovie.sanityImagePosterUrl) {
            counts.set(apiMovie.sanityImagePosterUrl, (counts.get(apiMovie.sanityImagePosterUrl) ?? 0) + 1);
        }
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([url]) => url));
}

export async function processData(data: any, tmdbApiKey?: string): Promise<Movie[]> {
    // Perform any further processing or rendering with the transformed data
    let movies: Record<string, Movie> = {}
    let imdbPromises: Promise<void>[] = []
    moment.locale("da")

    const apiMovies: ApiMovie[] = data?.data?.movieQuery?.getCurrentMovies ?? []
    const sharedPosterUrls = findSharedPosterUrls(apiMovies)

    for (const apiMovie of apiMovies) {
        const title = apiMovie.title
        if (!title) continue

        const id = createUrlSlug(title)
        const release_date = parseReleaseDate(apiMovie.premiere)

        if (!(id in movies)) {
            const isPlaceholderPoster = !apiMovie.sanityImagePosterUrl || sharedPosterUrls.has(apiMovie.sanityImagePosterUrl)
            // Empty string means "no real poster" -- the UI renders a
            // title-card fallback for this instead of a placeholder image.
            let poster_uri = isPlaceholderPoster ? '' : apiMovie.sanityImagePosterUrl

            movies[id] = {
                title: title,
                imdb_link: '',
                imdb_rating: '?', // Will be updated by IMDB promise
                cinemas: {},
                id: id,
                poster: poster_uri,
                release_date: release_date.toISOString(),
                display_release_date: release_date.locale("en").format('DD. MMM. YYYY')
            }

            // The GraphQL schedule API doesn't expose an IMDb id directly,
            // so every movie is resolved through the matching algorithm.
            const imdbPromise = resolveImdbId(buildKinoMovieInput(apiMovie, release_date), tmdbApiKey ?? "").then(async match => {
                if (match && (match.confidence === 'high' || match.confidence === 'medium')) {
                    const imdbData = await getRating(match.imdbId);
                    if (movies[id]) {
                        movies[id].imdb_rating = imdbData.rating;
                        movies[id].imdb_link = match.imdbId;

                        if (imdbData.datePublished && release_date.year() == 1900) {
                            const imdbDate = moment(imdbData.datePublished, 'YYYY-MM-DD');
                            if (imdbDate.isValid()) {
                                movies[id].release_date = imdbDate.toISOString();
                                movies[id].display_release_date = formatDisplayDate(imdbDate);
                            }
                        }

                        if (!movies[id].poster && tmdbApiKey) {
                            // TMDB doesn't always cross-link its own entry to the
                            // matched IMDb id, which makes the by-imdb-id lookup
                            // come back empty even though TMDB has the movie --
                            // fall back to the poster captured directly off the
                            // title-search hit during matching in that case.
                            const tmdbPoster = await get_poster_url(match.imdbId, tmdbApiKey) || match.tmdbPosterUrl;
                            if (tmdbPoster) {
                                movies[id].poster = tmdbPoster;
                            }
                        }
                    }
                }
            }).catch(error => {
                //console.warn(`Failed to resolve IMDb data for "${title}":`, error);
            });

            imdbPromises.push(imdbPromise);
        }

        const movie = movies[id]
        if (movie) {
            for (const show of apiMovie.shows ?? []) {
                const date = show.showStart.slice(0, 10);
                const time = show.showStart.slice(11, 16);

                if (!movie.cinemas[show.theaterId]) {
                    movie.cinemas[show.theaterId] = { id: show.theaterId, name: show.theaterName, showing: {} };
                }
                const cinema = movie.cinemas[show.theaterId]!;
                if (!cinema.showing[date]) {
                    cinema.showing[date] = [];
                }
                cinema.showing[date]!.push({ time, link: show.ticketSaleUrl });
            }
        }
    }

    // Wait for all IMDB data to be fetched
    await Promise.all(imdbPromises);

    return sortMoviesByPremiereDate(movies);
}

function sortMoviesByPremiereDate(movies: Record<number, Movie>): Movie[] {
    const now = new Date();

    // Split movies into two arrays based on release date
    const beforeNow: Movie[] = [];
    const afterNow: Movie[] = [];

    Object.values(movies).forEach(movie => {
        const releaseDate = new Date(movie.release_date);
        if (releaseDate < now) {
            beforeNow.push(movie);
        } else {
            afterNow.push(movie);
        }
    });

    // Sort both arrays by release date (most recent first)
    beforeNow.sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
    afterNow.sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());

    // Merge sorted arrays into one
    return [...beforeNow, ...afterNow];
}

function formatDisplayDate(date: moment.Moment): string {
    // Format as "01 March 2025"
    return date.locale("en").format('DD MMMM YYYY');
}

function createUrlSlug(title: string): string {
    return title
        .toLowerCase()
        .replace(/[æøå]/g, (match) => {
            const replacements: Record<string, string> = { 'æ': 'ae', 'ø': 'o', 'å': 'aa' };
            return replacements[match] || match;
        })
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}