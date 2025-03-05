<script setup lang="ts">
import type { Movie } from '../shared/types/movie';

const { data: movies, status, error, refresh, clear } = await useAsyncData<Movie[]>(
  'movieShowings',
  async () => $fetch('/api/getMovieShowings')
)

</script>

<template>
  <div>
    <div class="row">
      <div class="col-12">
        <h1 class="text-center">Movies</h1>
      </div>
    </div>

    <div>
      <div v-for="movie in movies" :key="movie.id" class="row mt-3">
        <div class="col-3">
          <img :src="movie.poster" class="img-fluid" alt="Movie Poster">
        </div>
        <div class="col-9">
          <h2>{{ movie.title }}
          </h2>
          <p>
            <NuxtLink to="'https://www.imdb.com/title/' + {{movie.imdb_link}}">
              Rating: ?
            </NuxtLink>
          </p>
          <p>Release Date: {{ movie.display_release_date }}</p>
          <div class="mt-3">
            <button > Show Cinemas <i class="bi bi-arrow-down"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>