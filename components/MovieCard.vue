<script setup lang="ts">
import type { Movie } from '../shared/types/movie'

defineProps<{ movie: Movie }>()

const showCinemas = ref(false)
</script>

<template>
  <div class="bg-gray-800 shadow-lg rounded-lg p-4">
    <!-- Mobile and desktop layout wrapper -->
    <div class="flex flex-row md:flex-row gap-4">
      <!-- Poster -->
      <div class="w-24 sm:w-28 md:w-1/4 flex-shrink-0">
        <img v-if="movie.poster" :src="movie.poster" class="w-full h-auto rounded" alt="Movie Poster">
        <div v-else class="w-full aspect-[2/3] rounded bg-gray-700 flex items-center justify-center p-2 text-center">
          <span class="text-sm font-semibold text-gray-200 leading-snug">{{ movie.title }}</span>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 min-w-0">
        <h2 class="text-xl md:text-2xl font-semibold mb-2">
          <NuxtLink :to="'/movies/' + movie.id" class="text-white hover:text-orange-500 underline">{{ movie.title }}</NuxtLink>
        </h2>
        <p class="mb-2">
          <a :href="'https://www.imdb.com/title/' + movie.imdb_link" target="_blank" class="text-white hover:text-orange-500 underline">
            Rating: {{ movie.imdb_rating }}
          </a>
        </p>
        <p class="mb-4">Release Date: {{ movie.display_release_date }}</p>
        <div class="mt-3">
          <button
            @click="showCinemas = !showCinemas"
            class="bg-orange-700 text-white hover:bg-orange-600 rounded flex items-center justify-center pl-4 pr-4 pt-2 pb-2 font-bold"
          >
            <span>{{ showCinemas ? 'Hide Cinemas' : 'Show Cinemas' }}</span>
            <i :class="showCinemas ? 'bi bi-arrow-up' : 'bi bi-arrow-down'"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- Cinema showings - displayed below poster on mobile -->
    <div v-if="showCinemas" class="mt-4">
      <CinemaShowing :cinemas="movie.cinemas" />
    </div>
  </div>
</template>
