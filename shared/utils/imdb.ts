export interface ImdbData {
    rating: string;
    datePublished: string;
}

export async function getRating(tt: string): Promise<ImdbData> {
    try {
        const response = await makeHttpsRequest("https://graphql.imdb.com/", `{"query": "query {title(id:\\"${tt}\\") {ratingsSummary {aggregateRating} releaseDate {day month year}}}"}`);
        const title = response.data?.title;
        if (!title) return { rating: '?', datePublished: '' };
        return {
            rating: title.ratingsSummary?.aggregateRating?.toString() ?? '?',
            datePublished: title.releaseDate
                ? `${title.releaseDate.year}-${title.releaseDate.month}-${title.releaseDate.day}`
                : ''
        };
    } catch {
        return { rating: '?', datePublished: '' };
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