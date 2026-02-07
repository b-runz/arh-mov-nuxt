export interface ImdbData {
    rating: string;
    datePublished: string;
}

const IMDB_JSON_REGEX = /<script type="application\/ld\+json">(.*?)<\/script>/;

export async function getImdbData(tt: string): Promise<ImdbData> {
    //console.log('Fetching IMDB data for:', tt);
    const imdbUrl = `https://www.imdb.com/title/${tt}/`;

    try {
        const html = await makeHttpsRequest(imdbUrl);

        // Parse IMDB JSON from HTML
        const match = html.match(IMDB_JSON_REGEX);
        if (!match) {
            //console.warn(`No JSON-LD found for ${tt}`);
            return { rating: '?', datePublished: '' };
        }

        const jsonStr = match[1];
        if (!jsonStr) {
            //console.warn(`Empty JSON-LD content for ${tt}`);
            return { rating: '?', datePublished: '' };
        }
        const imdbJson = JSON.parse(jsonStr);

        // Extract rating value
        const aggregateRating = imdbJson.aggregateRating || {};
        const rating = aggregateRating.ratingValue?.toString() || '?';

        // Extract date published
        const datePublished = imdbJson.datePublished || '';

        //console.log('Extracted rating:', rating, 'Date:', datePublished);
        return { rating, datePublished };

    } catch (error: any) {
        // Handle 404 errors specifically
        if (error?.status === 404 || error?.statusCode === 404) {
            //console.warn(`IMDB page not found for ${tt} (404)`);
            return { rating: '?', datePublished: '' };
        }

        //console.warn(`Failed to fetch IMDB data for ${tt}:`, error.message);
        return { rating: '?', datePublished: '' };
    }
}

// Backwards compatibility function
export async function getRating(tt: string): Promise<string> {
    const data = await getImdbData(tt);
    return data.rating;
}

// Helper function to make HTTPS requests with proper headers
async function makeHttpsRequest(url: string): Promise<string> {
    try {
        const response = await $fetch<string>(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36',
                'Accept': 'application/json'
            },
            // Ensure we get the raw response as text
            parseResponse: (txt) => txt,
            // Handle different response types
            responseType: 'text'
        });

        return response;
    } catch (error: any) {
        // $fetch throws errors for HTTP error statuses
        if (error?.status || error?.statusCode) {
            throw new Error(`HTTP ${error.status || error.statusCode}: ${error.statusText || error.message}`);
        }
        throw error;
    }
}

type ImdbItem = {
    id: string;
    l: string;
    q: string;
    qid: string;
    rank: number;
    s: string;
    y: number;
}

type imdb_response = {
    d: ImdbItem[];
}

export interface imdb_search_response {
    title: string,
    rank: number,
    id: string
}

async function imdb_search(title: string): Promise<imdb_search_response[]> {
    const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(title)}.json?includeVideos=0`

    const response = await fetch(url, {
        method: 'GET'
    })

    const data: imdb_response = await response.json() as imdb_response

    if (data.d.length == 0) {
        return [({
            id: "?",
            title: title,
            rank: 0
        })]
    }

    const cleanSearchTitle = cleanTitleString(title.toLowerCase());
    
    // Filter movies only
    const movies = data.d.filter(data => data.qid === "movie");
    
    if (movies.length === 0) {
        return [{
            id: "?",
            title: title,
            rank: 0
        }];
    }
    
    // Sort by year descending (newest first)
    const moviesByYear = movies.sort((a, b) => b.y - a.y);
    
    // Go through years, find exact title matches
    for (const movie of moviesByYear) {
        const movieCleanTitle = cleanTitleString(movie.l.toLowerCase());
        if (movieCleanTitle === cleanSearchTitle || cleanSearchTitle.includes(movieCleanTitle)) {
            return [{
                title: movie.l,
                rank: movie.rank,
                id: movie.id
            }];
        }
    }
    
    // If no exact matches, sort by rank and pick the highest ranked (lowest rank number)
    const moviesByRank = movies.sort((a, b) => a.rank - b.rank);
    
    return [{
        title: moviesByRank[0]!.l,
        rank: moviesByRank[0]!.rank,
        id: moviesByRank[0]!.id
    }];
}

export async function advanced_title_finder(title: string): Promise<imdb_search_response> {
    if (title.includes("(")) {
        const pattern = /(.*?)\((.*)\)/

        const titles = (title.match(pattern) ?? []).slice(1, 3).map(x => x.trim())

        const first_part_title = await imdb_search(titles[0]!)
        const second_part_title = await imdb_search(titles[1]!)

        for (let first_part_result of first_part_title) {
            for (let second_part_result of second_part_title) {
                if (first_part_result.id === second_part_result.id) {
                    return first_part_result
                }
            }
        }

        return first_part_title[0]!
    } else {
        return (await imdb_search(title))[0]!
    }

}
function cleanTitleString(title: string): string {
    return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}