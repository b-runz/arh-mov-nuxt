export interface ImdbData {
    rating: string;
    datePublished: string;
}

const IMDB_JSON_REGEX = /<script type="application\/ld\+json">(.*?)<\/script>/;

export async function getImdbData(tt: string): Promise<ImdbData> {
    console.log('Fetching IMDB data for:', tt);
    const imdbUrl = `https://www.imdb.com/title/${tt}/`;

    try {
        const html = await makeHttpsRequest(imdbUrl);

        // Parse IMDB JSON from HTML
        const match = html.match(IMDB_JSON_REGEX);
        if (!match) {
            console.warn(`No JSON-LD found for ${tt}`);
            return { rating: '?', datePublished: '' };
        }

        const jsonStr = match[1];
        if (!jsonStr) {
            console.warn(`Empty JSON-LD content for ${tt}`);
            return { rating: '?', datePublished: '' };
        }
        const imdbJson = JSON.parse(jsonStr);

        // Extract rating value
        const aggregateRating = imdbJson.aggregateRating || {};
        const rating = aggregateRating.ratingValue?.toString() || '?';

        // Extract date published
        const datePublished = imdbJson.datePublished || '';

        console.log('Extracted rating:', rating, 'Date:', datePublished);
        return { rating, datePublished };

    } catch (error: any) {
        // Handle 404 errors specifically
        if (error?.status === 404 || error?.statusCode === 404) {
            console.warn(`IMDB page not found for ${tt} (404)`);
            return { rating: '?', datePublished: '' };
        }

        console.warn(`Failed to fetch IMDB data for ${tt}:`, error.message);
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