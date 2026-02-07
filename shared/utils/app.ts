
import moment from 'moment';
import type { Movie } from "../types/movie";
import type { Showing } from "../types/showing";
import { getImdbData, advanced_title_finder } from './imdb';
import { get_poster_url } from './tmdb_poster';

export async function processData(data: any, tmdbApiKey?: string): Promise<Movie[]> {
    // Perform any further processing or rendering with the transformed data
    let movies: Record<number, Movie> = {}
    let imdbPromises: Promise<void>[] = []
    moment.locale("da")

    let data_cinemas = data['content']['content']['content']
    for (let data_cinema of data_cinemas) {
        let data_cinema_id = data_cinema['id']
        let data_cinema_name = data_cinema['content']['label']

        for (let data_movie of data_cinema['movies']) {

            let id = data_movie['id']
            let title: string = "";
            if ("label" in data_movie.content) {
                title = data_movie.content.label;
            }
            if (title == "") {
                continue;
            }
            let release_date = moment('1900-01-01', 'YYYY-MM-DD')
            if ("field_premiere" in data_movie.content && data_movie.content.field_premiere) {
                release_date = moment(data_movie.content.field_premiere, 'D. MMM YYYY');
            }

            let imdb_link: string = "";
            if ("field_imdb" in data_movie.content) {
                imdb_link = data_movie.content.field_imdb;
            }

            if (!(id in movies)) {

                let poster_uri: string = data_movie.content?.field_poster?.field_media_image?.img_element?.uri
                if (poster_uri != undefined && poster_uri.includes("no-boost-poster") && tmdbApiKey) {
                    poster_uri = await get_poster_url(data_movie.content.field_imdb, tmdbApiKey)
                } else if (poster_uri != undefined && poster_uri.includes("Kino-fallback-poster") && tmdbApiKey) {
                    poster_uri = await get_poster_url(data_movie.content.field_imdb, tmdbApiKey)
                } else if (poster_uri != undefined && poster_uri.includes("plakat-paa-vej") && tmdbApiKey) {
                    poster_uri = await get_poster_url(data_movie.content.field_imdb, tmdbApiKey)
                } else if ((poster_uri == undefined || poster_uri == "") && tmdbApiKey && data_movie.content.field_imdb) {
                    // No poster available from original source, try TMDB
                    poster_uri = await get_poster_url(data_movie.content.field_imdb, tmdbApiKey)
                }

                if (poster_uri == undefined || poster_uri == "") {
                    poster_uri = "https://api.kino.dk/sites/kino.dk/files/styles/isg_focal_point_356_534/public/2023-05/Kino-fallback-poster.webp?h=6c02f54b&itok=efsQLlFH"
                }

                movies[id] = {
                    title: title,
                    imdb_link: imdb_link,
                    imdb_rating: '?', // Will be updated by IMDB promise
                    cinemas: {},
                    id: createUrlSlug(title),
                    poster: poster_uri,
                    release_date: release_date.toISOString(),
                    display_release_date: release_date.locale("en").format('DD. MMM. YYYY')
                }

                // Add IMDB data fetching promise for multithreading
                if (imdb_link) {
                    const imdbPromise = getImdbData(imdb_link).then(async imdbData => {
                        if (movies[id]) {
                            movies[id].imdb_rating = imdbData.rating;

                            // If IMDB rating is "?", try TMDB fallback
                            if (imdbData.rating === '?' && tmdbApiKey) {
                                try {
                                    const titleSearchResult = await advanced_title_finder(title);

                                    const fallbackImdbData = await getImdbData(titleSearchResult.id);
                                    if (fallbackImdbData.rating !== '?') {
                                        movies[id].imdb_rating = fallbackImdbData.rating;
                                        movies[id].imdb_link = titleSearchResult.id;
                                        imdbData = fallbackImdbData;
                                    }

                                    // Use TMDB poster if it's a fallback poster and TMDB has one
                                    if (poster_uri.includes("no-boost-poster") ||
                                        poster_uri.includes("Kino-fallback-poster") ||
                                        poster_uri.includes("plakat-paa-vej") ||
                                        poster_uri.includes("fallback-poster")) {
                                        movies[id].poster = await get_poster_url(titleSearchResult.id, tmdbApiKey);
                                    }
                                } catch (error) {
                                    //console.warn(`Failed to fetch TMDB fallback data for "${title}":`, error);
                                }
                            }

                            // Update release date with IMDB data if available and more accurate
                            if (imdbData.datePublished && release_date.year() == 1900) {
                                const imdbDate = moment(imdbData.datePublished, 'YYYY-MM-DD');
                                if (imdbDate.isValid()) {
                                    movies[id].release_date = imdbDate.toISOString();
                                    movies[id].display_release_date = formatDisplayDate(imdbDate);
                                }
                            }
                        }
                    }).catch(error => {
                        //console.warn(`Failed to fetch IMDB data for ${imdb_link}:`, error);
                    });

                    imdbPromises.push(imdbPromise);
                } else {
                    const imdbPromise = advanced_title_finder(title).then(async titleSearchResult => {
                        if (titleSearchResult.id !== "?") {
                            const imdbData = await getImdbData(titleSearchResult.id);
                            if (movies[id]) {
                                movies[id].imdb_rating = imdbData.rating;
                                const imdbDate = moment(imdbData.datePublished, 'YYYY-MM-DD');
                                if (imdbDate.isValid()) {
                                    movies[id].release_date = imdbDate.toISOString();
                                    movies[id].display_release_date = formatDisplayDate(imdbDate);
                                }
                                movies[id].imdb_link = titleSearchResult.id

                                if (poster_uri.includes("no-boost-poster") ||
                                    poster_uri.includes("Kino-fallback-poster") ||
                                    poster_uri.includes("plakat-paa-vej") ||
                                    poster_uri.includes("fallback-poster")) {
                                    movies[id].poster = await get_poster_url(titleSearchResult.id, tmdbApiKey!);

                                    if(movies[id].poster == ""){
                                        movies[id].poster = "https://api.kino.dk/sites/kino.dk/files/styles/isg_focal_point_356_534/public/2023-05/Kino-fallback-poster.webp?h=6c02f54b&itok=efsQLlFH"
                                    }
                                }
                            }
                        }
                    }).catch(error => {
                        // Handle errors silently to prevent blocking
                    });
                    imdbPromises.push(imdbPromise);
                }
            }
            let showings: Record<string, Showing[]> = {}

            const noTextList = [
                {
                    'textToReplace': 'IMAX',
                    'textToShow': 'IMAX'
                },
                {
                    'textToReplace': '3D',
                    'textToShow': '3D'
                },
                {
                    'textToReplace': 'Dansk',
                    'textToShow': 'Danish'
                },
                {
                    'textToReplace': 'Engelsk',
                    'textToShow': 'English'
                }
            ]

            for (let data_version of data_movie['versions']) {
                let appendText = ''
                if ('label' in data_version) {
                    for (let replaceTextLabel of noTextList) {
                        if (data_version['label'].includes(replaceTextLabel['textToReplace'])) {
                            appendText = ' - ' + replaceTextLabel['textToShow']
                        }
                    }
                }

                for (let data_showing of data_version['dates']) {
                    let date = data_showing['date']
                    for (let data_time of data_showing['showtimes']) {
                        if (!(date in showings)) {
                            showings[date] = []
                        }
                        showings[date]?.push({
                            link: "https://kino.dk/ticketflow/showtimes/" + data_time['id'],
                            time: data_time['time'] + appendText
                        })
                    }
                }
            }


            let movie = movies[id]
            if (movie) {
                movie.cinemas[data_cinema_id] = {
                    name: data_cinema_name,
                    id: data_cinema_id,
                    showing: showings
                }
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