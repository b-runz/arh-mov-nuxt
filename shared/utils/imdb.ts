export interface ImdbData {
    rating: string;
    datePublished: string;
}

export async function getRating(tt: string): Promise<ImdbData> {
    const response = await makeHttpsRequest("https://graphql.imdb.com/", `{"query": "query {title(id:\\"${tt}\\") {ratingsSummary {aggregateRating} releaseDate {day month year}}}"}`);
    return {
        rating: response.data.title.ratingsSummary.aggregateRating.toString(),
        datePublished: `${response.data.title.releaseDate.year}-${response.data.title.releaseDate.month}-${response.data.title.releaseDate.day}`
    };
}

type ImdbRatingResponse = {
  data: {
    title: {
      ratingsSummary: {
        aggregateRating: number;
      },
      releaseDate: {
        day: number,
        month: number,
        year: number
      }
    };
  };
};

// Helper function to make HTTPS requests with proper headers
async function makeHttpsRequest(url: string, body: string): Promise<ImdbRatingResponse> {
    try {
        const response = await $fetch<ImdbRatingResponse>(url, {
            method: 'POST',
            body: body,
            headers: {
                'Content-Type': 'application/json' 
            }            
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