export interface ImdbData {
    rating: string;
    datePublished: string;
    /**
     * True only when the fetch itself failed (network error, rate-limit,
     * unexpected/missing response) -- NOT when the request succeeded but the
     * title simply has no rating yet (unreleased or too new for enough
     * votes). Both cases return rating: '?', but only a genuine failure is
     * worth retrying on the next build regardless of the cache TTL; a movie
     * with no rating yet won't suddenly get one before it's actually rated,
     * so retrying that case every single build is pure waste (see
     * planMovieFetch in movieCache.ts).
     */
    ratingFailed: boolean;
}

export async function getRating(tt: string): Promise<ImdbData> {
    try {
        const response = await makeHttpsRequest("https://graphql.imdb.com/", `{"query": "query {title(id:\\"${tt}\\") {ratingsSummary {aggregateRating} releaseDate {day month year}}}"}`);
        const title = response.data?.title;
        if (!title) return { rating: '?', datePublished: '', ratingFailed: true };
        return {
            rating: title.ratingsSummary?.aggregateRating?.toString() ?? '?',
            datePublished: title.releaseDate
                ? `${title.releaseDate.year}-${title.releaseDate.month}-${title.releaseDate.day}`
                : '',
            ratingFailed: false,
        };
    } catch (error) {
        console.warn(`[imdb] rating lookup failed for ${tt}: ${(error as Error)?.message ?? error}`);
        return { rating: '?', datePublished: '', ratingFailed: true };
    }
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
                'Content-Type': 'application/json',
                // IMDb's edge returns 403 without a same-site Referer/Origin,
                // regardless of caller IP -- reproduced with plain curl and
                // Node's native fetch, not just from GitHub Actions.
                'Referer': 'https://www.imdb.com/',
                'Origin': 'https://www.imdb.com'
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