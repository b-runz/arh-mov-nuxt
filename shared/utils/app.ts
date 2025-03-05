
import moment from 'moment';
import type { Movie } from "../types/movie";
import type { Showing } from "../types/showing";
import { createHash } from 'node:crypto'

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

            let imdb_rating: string = "?";

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
                    id: md5(title),
                    poster: poster_uri,
                    release_date: release_date,
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
                        showings[date].push({
                            link: "https://kino.dk/ticketflow/showtimes/" + data_time['id'],
                            time: data_time['time'] + appendText
                        })
                    }
                }
            }


            let movie = movies[id]
            movie.cinemas[data_cinema_id] = {
                name: data_cinema_name,
                id: data_cinema_id,
                showing: showings
            }

        }
    }
    return sortMoviesByPremiereDate(movies);
}

function sortMoviesByPremiereDate(movies: Record<number, Movie>): Movie[] {
    const now = moment();

    // Split movies into two arrays based on release date
    const beforeNow: Movie[] = [];
    const afterNow: Movie[] = [];

    Object.values(movies).forEach(movie => {
      if (movie.release_date.isBefore(now)) {
        beforeNow.push(movie);
      } else {
        afterNow.push(movie);
      }
    });

    // Sort both arrays by release date (most recent first)
    beforeNow.sort((a, b) => b.release_date.diff(a.release_date));
    afterNow.sort((a, b) => b.release_date.diff(a.release_date));

    // Merge sorted arrays into one
    return [...beforeNow, ...afterNow];
}

function md5(content) {
    return createHash('md5').update(content).digest('hex')
}