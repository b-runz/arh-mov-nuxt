<script setup>
import { useAsyncData, useFetch } from "nuxt/app";

const { pending, data: productInfo, refresh, error } = useAsyncData(
  "productInfo",
  async () => {
    const [products, categories] = await Promise.all([
      $fetch("https://fakestoreapi.com/products"),
      $fetch("https://fakestoreapi.com/products/categories"),
    ]);

    return {
      products,
      categories,
    };
  },
  {
    lazy: false,
    transform: (productInfo) => {
      if (!productInfo || !productInfo.products) {
        throw new Error("Invalid API response");
      }

      return {
        categories: productInfo.categories,
        products: productInfo.products.map((product) => ({
          id: product.id,
          title: "product.title",
          image: product.image,
        })),
      };
    },
    onError: (err) => {
      console.error("Error fetching data:", err);
    },
  }
);
</script>

<template>
  <div v-if="pending">
    <p>Loading...</p>
  </div>
  <div v-else-if="error">
    <p>Error fetching data: {{ error.message }}</p>
  </div>
  <div v-else>
    <button @click="refresh">Refresh Data</button>
    <div class="grid grid-cols-5 gap-4">
      <div
        v-for="product in productInfo.products"
        :key="product.id"
        class="flex flex-col shadow-md bg-white p-6 rounded-md"
      >
        <img class="w-[75px] h-auto self-center" alt="" :src="product.image" />
        <h2 class="text-black mt-auto text-sm">{{ product.title }}</h2>
      </div>
    </div>
  </div>
</template>