<script setup lang="ts">
import { useMovies } from '~/composables/useMovies';
import { toRecommendable, recommendMovies } from '../shared/utils/geminiRecommend';

useHead({
  title: 'AI Recommendations - Movies in Aarhus',
  meta: [
    {
      name: 'description',
      content: 'AI-curated picks from the current Aarhus cinema listings'
    }
  ]
})

const movies = await useMovies()

// Gemini API key -- this is a static site with no server to hold a secret,
// so the key lives only in the user's own browser and is sent directly to
// Google, never to us. See shared/utils/geminiRecommend.ts. The key itself
// is restricted (HTTP referrer) to only work when called from this page.
const GEMINI_KEY_STORAGE = 'gemini_api_key';
const storedApiKey = ref<string | null>(null);
const apiKeyInput = ref('');
const recommending = ref(false);
const recommendedIds = ref<string[] | null>(null);
const recommendError = ref('');

onMounted(() => {
  try {
    storedApiKey.value = localStorage.getItem(GEMINI_KEY_STORAGE);
  } catch {
    // Private browsing / storage disabled -- just fall back to asking every time.
  }
});

const saveApiKey = () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  try {
    localStorage.setItem(GEMINI_KEY_STORAGE, key);
  } catch {
    // Ignore -- the key still works for this page load via storedApiKey.
  }
  storedApiKey.value = key;
  apiKeyInput.value = '';
};

const changeApiKey = () => {
  storedApiKey.value = null;
};

const getRecommendations = async () => {
  if (!storedApiKey.value || !movies?.value) return;
  recommending.value = true;
  recommendError.value = '';
  try {
    const candidates = movies.value.map(toRecommendable);
    recommendedIds.value = await recommendMovies(storedApiKey.value, candidates);
  } catch (error) {
    recommendError.value = error instanceof Error ? error.message : 'Recommendation request failed';
  } finally {
    recommending.value = false;
  }
};

const clearRecommendations = () => {
  recommendedIds.value = null;
  recommendError.value = '';
};

const recommendedMovies = computed(() => {
  if (!movies?.value || !recommendedIds.value) return [];
  const order = recommendedIds.value;
  return movies.value
    .filter(movie => order.includes(movie.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
});
</script>

<template>
  <div class="container mx-auto px-4 mt-6">
    <div class="mb-6">
      <h1 class="text-3xl font-bold text-center">AI Recommendations</h1>
      <p class="mt-2 text-center text-gray-400 text-sm">
        Gemini picks from the current listings, biased toward smaller / independent films, foreign-language films, one-off or limited screenings, and classic re-releases.
      </p>

      <div class="mt-4 flex flex-col items-center gap-2">
        <form v-if="!storedApiKey" @submit.prevent="saveApiKey" class="flex items-center gap-2">
          <input
            v-model="apiKeyInput"
            type="password"
            placeholder="Gemini API key"
            class="bg-gray-700 border border-gray-600 text-white rounded px-2 py-1 text-sm focus:outline-none focus:border-orange-500"
          />
          <button type="submit" class="bg-orange-700 hover:bg-orange-600 text-white rounded px-3 py-1 text-sm font-bold">Save</button>
        </form>
        <div v-else class="flex items-center gap-3">
          <button
            @click="getRecommendations"
            :disabled="recommending"
            class="bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white rounded px-4 py-2 font-bold"
          >{{ recommending ? 'Thinking…' : 'Recommend' }}</button>
          <button v-if="recommendedIds" @click="clearRecommendations" class="text-orange-400 hover:text-orange-300 underline text-sm">Clear</button>
          <button @click="changeApiKey" class="text-gray-500 hover:text-white text-sm underline">change key</button>
        </div>
        <p v-if="recommendError" class="text-red-400 text-sm">{{ recommendError }}</p>
        <NuxtLink to="/" class="mt-2 text-orange-400 hover:text-orange-300 underline text-sm">← Back to full list</NuxtLink>
      </div>
    </div>

    <div v-if="!movies || movies.length === 0" class="mt-6">
      <div class="text-center">
        <p>Loading...</p>
      </div>
    </div>
    <div v-else-if="recommendedIds === null" class="mt-6">
      <div class="text-center">
        <p class="text-gray-400">Click Recommend to get AI picks from the current listings.</p>
      </div>
    </div>
    <div v-else-if="recommendedMovies.length === 0" class="mt-6">
      <div class="text-center">
        <p class="text-gray-400">Gemini didn't find any matches for your taste in the current listings.</p>
      </div>
    </div>
    <div v-else class="space-y-6">
      <MovieCard v-for="movie in recommendedMovies" :key="movie.id" :movie="movie" />
    </div>
  </div>
</template>
