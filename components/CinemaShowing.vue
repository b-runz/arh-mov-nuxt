<script setup lang="ts">
import type { Cinema } from '../shared/types/cinema';

interface Props {
  cinemas: Record<string, Cinema>;
}

defineProps<Props>();

// Reactive current time that updates every minute
const currentTime = ref(new Date());

// Update current time every minute
onMounted(() => {
  const interval = setInterval(() => {
    currentTime.value = new Date();
  }, 60000);

  onUnmounted(() => {
    clearInterval(interval);
  });
});

// Helper function to check if a showing time has passed
const hasShowingPassed = (dateStr: string, timeStr: string): boolean => {
  try {
    // Parse Danish date format: "fre, 13/12" (day, dd/mm)
    const parts = dateStr.split(', ');
    if (parts.length !== 2 || !parts[1]) return false;
    
    const datePart = parts[1]; // Get "13/12" part
    const dateParts = datePart.split('/');
    if (dateParts.length !== 2 || !dateParts[0] || !dateParts[1]) return false;
    
    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    
    if (isNaN(day) || isNaN(month)) return false;
    
    // Get current year
    const currentYear = currentTime.value.getFullYear();
    
    // Create date string in ISO format: YYYY-MM-DD
    const isoDate = `${currentYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    
    // Parse the full date and time
    const showDateTime = new Date(`${isoDate}T${timeStr}:00`);
    
    // Check if the date is valid
    if (isNaN(showDateTime.getTime())) return false;
    
    return showDateTime <= currentTime.value;
  } catch (error) {
    // If parsing fails, show the item (safer fallback)
    console.warn('Failed to parse Danish date/time:', dateStr, timeStr, error);
    return false;
  }
};

// Helper function to check if all showings for a date have passed
const haveAllShowingsPassed = (dateStr: string, showings: any[]): boolean => {
  return showings.every(show => hasShowingPassed(dateStr, show.time));
};
</script>

<template>
  <div v-if="Object.keys(cinemas).length > 0">
    <ul class="space-y-4">
      <li v-for="(cinema, cinemaId) in cinemas" :key="cinemaId">
        <div class="font-bold text-lg mb-2">{{ cinema.name }}</div>
        <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <template v-for="(showing, date) in cinema.showing" :key="date">
            <li v-if="!haveAllShowingsPassed(date, showing)" class="bg-gray-100 border border-gray-300 rounded p-3">
              <div class="font-bold mb-2">{{ date }}</div>
              <ul class="space-y-1">
                <template v-for="show in showing" :key="show.link">
                  <li v-if="!hasShowingPassed(date, show.time)">
                    <a :href="show.link" class="text-black visited:text-red-600 font-bold underline">{{ show.time }}</a>
                  </li>
                </template>
              </ul>
            </li>
          </template>
        </ul>
      </li>
    </ul>
  </div>
  <div v-else>
    <p class="text-gray-600">No cinemas available for this movie.</p>
  </div>
</template>