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
        <div class="flex flex-wrap gap-4">
          <template v-for="(showing, date) in cinema.showing" :key="date">
            <div v-if="!haveAllShowingsPassed(date, showing)" class="bg-gray-700 border border-gray-600 rounded p-3">
              <div class="font-bold mb-2">{{ date }}</div>
              <div class="flex flex-col gap-1">
                <template v-for="show in showing" :key="show.link">
                  <a v-if="!hasShowingPassed(date, show.time)" :href="show.link" class="text-white visited:text-orange-400 font-bold underline bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded text-sm w-fit">{{ show.time }}</a>
                </template>
              </div>
            </div>
          </template>
        </div>
      </li>
    </ul>
  </div>
  <div v-else>
    <p class="text-gray-400">No cinemas available for this movie.</p>
  </div>
</template>