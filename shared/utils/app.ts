
import moment from 'moment';
import type { Movie } from "../types/movie";
import type { Showing } from "../types/showing";
import { getRating } from './imdb';

export async function processData(data: any): Promise<Movie[]> {
    // Perform any further processing or rendering with the transformed data
    let movies: Record<number, Movie> = {}
    let promises = []
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

            let imdb_rating: string = await getRating(imdb_link);

            if (!(id in movies)) {

                let poster_uri = data_movie.content?.field_poster?.field_media_image?.img_element?.uri
                if (poster_uri == undefined) {
                    poster_uri = "https://api.kino.dk/sites/kino.dk/files/styles/isg_focal_point_348_522/public/2023-05/Kino-fallback-poster.webp?h=6c02f54b&itok=14CuSSHm"
                }
                movies[id] = {
                    title: title,
                    imdb_link: imdb_link,
                    imdb_rating: imdb_rating,
                    cinemas: {},
                    id: createUrlSlug(title),
                    poster: poster_uri,
                    release_date: release_date.toISOString(),
                    display_release_date: release_date.locale("en").format('DD. MMM. YYYY')
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