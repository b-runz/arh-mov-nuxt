<script setup lang="ts">
import { useMovies } from '~/composables/useMovies';
import type { Movie } from '../../shared/types/movie';

const route = useRoute();
const movieId = route.params.id as string;

// Use the same composable to get movies data (will be cached/shared)
const movies = await useMovies();

// Find the specific movie by ID
const movie = computed(() => {
  if (!movies.value) return null;
  return movies.value.find((m: Movie) => m.id === movieId);
});

// Set page title dynamically based on movie title
watchEffect(() => {
  if (movie.value) {
    useHead({
      title: `${movie.value.title} - Movies in Aarhus`,
      meta: [
        {
          name: 'description',
          content: `Find showtimes for ${movie.value.title} in Aarhus cinemas. IMDB Rating: ${movie.value.imdb_rating}`
        }
      ]
    })
  }
});

// Scroll to top when component mounts
onMounted(() => {
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: 'instant',
  });
});
</script>

<template>
  <div class="container mx-auto px-4 mt-6">
    <div v-if="!movie" class="mt-6">
      <div class="text-center">
        <p>Loading...</p>
      </div>
    </div>
    <div v-else>
      <div class="mb-6">
        <h1 class="text-3xl font-bold text-center text-white">{{ movie.title }}</h1>
      </div>
      <div class="bg-gray-800 shadow-lg rounded-lg p-4">
        <!-- Mobile and desktop layout wrapper -->
        <div class="flex flex-row md:flex-row gap-4">
          <!-- Poster -->
          <div class="w-24 sm:w-28 md:w-1/4 flex-shrink-0">
            <img :src="movie.poster" class="w-full h-auto rounded shadow-lg" alt="Movie Poster">
          </div>
          
          <!-- Content -->
          <div class="flex-1 min-w-0">
            <p class="mb-2">
              <a :href="'https://www.imdb.com/title/' + movie.imdb_link" target="_blank" class="text-orange-400 hover:text-orange-300 underline">
                Rating: {{ movie.imdb_rating }}
              </a>
            </p>
            <p class="mb-4 md:mb-6">Release Date: {{ movie.display_release_date }}</p>
            
            <!-- Cinema showings - next to poster on desktop, below on mobile -->
            <div class="hidden md:block">
              <CinemaShowing :cinemas="movie.cinemas" />
            </div>
          </div>
        </div>
        
        <!-- Cinema showings - displayed below poster on mobile only -->
        <div class="mt-4 md:hidden">
          <CinemaShowing :cinemas="movie.cinemas" />
        </div>
      </div>
    </div>
  </div>
</template>

