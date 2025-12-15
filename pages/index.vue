<script setup lang="ts">
import { useMovies } from '~/composables/useMovies';
import type { Movie } from '../shared/types/movie';

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

// Track unfolded cinemas
const unfoldedCinemas = ref<string[]>([]);

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

// Toggle cinemas function
const toggleCinemas = (movieId: string) => {
  if (unfoldedCinemas.value.includes(movieId)) {
    // If the movie's cinemas are already unfolded, remove it from the unfoldedCinemas array
    unfoldedCinemas.value = unfoldedCinemas.value.filter(id => id !== movieId);
  } else {
    // If the movie's cinemas are not unfolded, add it to the unfoldedCinemas array
    unfoldedCinemas.value.push(movieId);
  }
};
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
          <span class="ml-2 text-gray-700">Show only movies with rating > 7.0</span>
        </label>
      </div>
    </div>
    <div v-if="!movies || movies.length === 0" class="mt-6">
      <div class="text-center">
        <p>Loading...</p>
      </div>
    </div>
    <div v-else-if="filteredMovies.length === 0 && showHighRatedOnly" class="mt-6">
      <div class="text-center">
        <p class="text-gray-600">No movies found with rating above 7.0</p>
      </div>
    </div>
    <div v-else class="space-y-6">
      <div v-for="movie in filteredMovies" :key="movie.id" class="bg-white shadow-lg rounded-lg p-4">
        <!-- Mobile and desktop layout wrapper -->
        <div class="flex flex-row md:flex-row gap-4">
          <!-- Poster -->
          <div class="w-24 sm:w-28 md:w-1/4 flex-shrink-0">
            <img :src="movie.poster" class="w-full h-auto rounded" alt="Movie Poster">
          </div>
          
          <!-- Content -->
          <div class="flex-1 min-w-0">
            <h2 class="text-xl md:text-2xl font-semibold mb-2">
              <NuxtLink :to="'/movies/' + movie.id" class="text-blue-600 hover:text-blue-800">{{ movie.title }}</NuxtLink>
            </h2>
            <p class="mb-2">
              <a :href="'https://www.imdb.com/title/' + movie.imdb_link" target="_blank" class="text-gray-700 hover:text-gray-900"> 
                Rating: {{ movie.imdb_rating }}
              </a>
            </p>
            <p class="mb-4">Release Date: {{ movie.display_release_date }}</p>
            <div class="mt-3">
              <button 
                @click="toggleCinemas(movie.id)" 
                class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded inline-flex items-center" 
                v-if="!unfoldedCinemas.includes(movie.id)"
              > 
                Show Cinemas <i class="bi bi-arrow-down ml-2"></i>
              </button>
              <button 
                @click="toggleCinemas(movie.id)" 
                class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded inline-flex items-center" 
                v-else
              > 
                Hide Cinemas <i class="bi bi-arrow-up ml-2"></i>
              </button>
            </div>
          </div>
        </div>
        
        <!-- Cinema showings - displayed below poster on mobile -->
        <div v-if="unfoldedCinemas.includes(movie.id)" class="mt-4">
          <CinemaShowing :cinemas="movie.cinemas" />
        </div>
      </div>
    </div>
  </div>
</template>

