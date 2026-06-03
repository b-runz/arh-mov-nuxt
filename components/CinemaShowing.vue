<script setup lang="ts">
import type { Cinema } from '../shared/types/cinema'

interface FilterState {
  date?: string
  range?: { from: string; to: string }
  cinemaIds?: number[]
}

interface Props {
  cinemas: Record<string, Cinema>
  filter?: FilterState
}

const props = defineProps<Props>()

const currentTime = ref(new Date())

onMounted(() => {
  const interval = setInterval(() => {
    currentTime.value = new Date()
  }, 60000)
  onUnmounted(() => clearInterval(interval))
})

const hasShowingPassed = (dateStr: string, timeStr: string): boolean => {
  try {
    const parts = dateStr.split(', ')
    if (parts.length !== 2 || !parts[1]) return false
    const datePart = parts[1]
    const dateParts = datePart.split('/')
    if (dateParts.length !== 2 || !dateParts[0] || !dateParts[1]) return false
    const day = parseInt(dateParts[0], 10)
    const month = parseInt(dateParts[1], 10)
    if (isNaN(day) || isNaN(month)) return false
    const currentYear = currentTime.value.getFullYear()
    const isoDate = `${currentYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    const showDateTime = new Date(`${isoDate}T${timeStr}:00`)
    if (isNaN(showDateTime.getTime())) return false
    return showDateTime <= currentTime.value
  } catch (error) {
    console.warn('Failed to parse Danish date/time:', dateStr, timeStr, error)
    return false
  }
}

const haveAllShowingsPassed = (dateStr: string, showings: any[]): boolean => {
  return showings.every(show => hasShowingPassed(dateStr, show.time))
}

const parseDanishDate = (dateStr: string): Date | null => {
  const parts = dateStr.split(', ')
  if (parts.length < 2 || !parts[1]) return null
  const dateParts = parts[1].split('/')
  if (dateParts.length < 2) return null
  const day = parseInt(dateParts[0], 10)
  const month = parseInt(dateParts[1], 10)
  if (isNaN(day) || isNaN(month)) return null
  return new Date(currentTime.value.getFullYear(), month - 1, day)
}

const dateMatchesFilter = (dateStr: string): boolean => {
  const f = props.filter
  if (!f?.date && !f?.range) return true
  const d = parseDanishDate(dateStr)
  if (!d) return true

  if (f.date) {
    const [, fm, fd] = f.date.split('-').map(Number)
    return d.getMonth() === fm - 1 && d.getDate() === fd
  }

  if (f.range) {
    const [fy, fm, fd] = f.range.from.split('-').map(Number)
    const [ty, tm, td] = f.range.to.split('-').map(Number)
    const from = new Date(fy, fm - 1, fd)
    const to = new Date(ty, tm - 1, td, 23, 59, 59)
    return d >= from && d <= to
  }

  return true
}

const filteredCinemas = computed(() => {
  const ids = props.filter?.cinemaIds
  if (!ids?.length) return props.cinemas
  return Object.fromEntries(
    Object.entries(props.cinemas).filter(([, cinema]) => ids.includes(cinema.id))
  )
})

const hasVisibleDates = (cinema: Cinema): boolean => {
  return Object.entries(cinema.showing).some(([date, showings]) =>
    !haveAllShowingsPassed(date, showings) && dateMatchesFilter(date)
  )
}

const hasAnyVisibleContent = computed(() =>
  Object.values(filteredCinemas.value).some(cinema => hasVisibleDates(cinema))
)
</script>

<template>
  <div v-if="Object.keys(cinemas).length > 0">
    <ul class="space-y-4">
      <li v-for="(cinema, cinemaId) in filteredCinemas" :key="cinemaId" v-show="hasVisibleDates(cinema)">
        <div class="font-bold text-lg mb-2">{{ cinema.name }}</div>
        <div class="flex flex-wrap gap-4">
          <template v-for="(showing, date) in cinema.showing" :key="date">
            <div
              v-if="!haveAllShowingsPassed(String(date), showing) && dateMatchesFilter(String(date))"
              class="bg-gray-700 border border-gray-600 rounded p-3 min-w-[8rem] text-center"
            >
              <div class="font-bold mb-2">{{ date }}</div>
              <div class="flex flex-col gap-1">
                <template v-for="show in showing" :key="show.link">
                  <a
                    v-if="!hasShowingPassed(String(date), show.time)"
                    :href="show.link"
                    class="text-white visited:text-orange-400 font-bold underline bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded text-sm min-w-[3.5rem] text-center inline-block"
                  >{{ show.time }}</a>
                </template>
              </div>
            </div>
          </template>
        </div>
      </li>
    </ul>
    <p v-if="!hasAnyVisibleContent" class="text-gray-500 text-sm mt-2 italic">
      No showtimes match the selected filters.
    </p>
  </div>
  <div v-else>
    <p class="text-gray-400">No cinemas available for this movie.</p>
  </div>
</template>
