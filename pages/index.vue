<script setup lang="ts">
import { useMovies } from '~/composables/useMovies';

// Set page title and meta
useHead({
  title: 'Movies in Aarhus',
  meta: [
    {
      name: 'description',
      content: 'Find movie showtimes and cinema information in Aarhus'
    }
  ]
})

const movies = await useMovies()

// Rating filter state
const showHighRatedOnly = ref(false);

// Computed property for filtered movies
const filteredMovies = computed(() => {
  if (!movies?.value) return [];

  if (showHighRatedOnly.value) {
    return movies.value.filter(movie => {
      const rating = parseFloat(movie.imdb_rating);
      return !isNaN(rating) && rating > 7.0;
    });
  }

  return movies.value;
});
</script>

<template>
  <div class="container mx-auto px-4 mt-6">
    <div class="mb-6">
      <h1 class="text-3xl font-bold text-center">Movies in Aarhus</h1>

      <!-- Rating Filter -->
      <div class="mt-4 flex justify-center">
        <label class="inline-flex items-center">
          <input
            type="checkbox"
            v-model="showHighRatedOnly"
            class="form-checkbox h-5 w-5 text-blue-600"
          />
          <span class="ml-2 text-gray-300">Show only movies with rating > 7.0</span>
        </label>
      </div>

      <div class="mt-4 flex justify-center">
        <NuxtLink to="/recommend" class="text-orange-400 hover:text-orange-300 underline text-sm">Get AI recommendations →</NuxtLink>
      </div>
    </div>
    <div v-if="!movies || movies.length === 0" class="mt-6">
      <div class="text-center">
        <p>Loading...</p>
      </div>
    </div>
    <div v-else-if="filteredMovies.length === 0 && showHighRatedOnly" class="mt-6">
      <div class="text-center">
        <p class="text-gray-400">No movies found with rating above 7.0</p>
      </div>
    </div>
    <div v-else class="space-y-6">
      <MovieCard v-for="movie in filteredMovies" :key="movie.id" :movie="movie" />
    </div>
  </div>
</template>
