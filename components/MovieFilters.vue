<script setup lang="ts">
import type { Cinema } from '../shared/types/cinema'

export interface FilterState {
  date?: string
  range?: { from: string; to: string }
  cinemaIds?: number[]
}

const props = defineProps<{
  cinemas: Record<string, Cinema>
}>()

const emit = defineEmits<{
  'update:filter': [FilterState]
}>()

const activePicker = ref<'date' | 'range' | 'cinemas' | null>(null)
const selectedDate = ref('')
const rangeFrom = ref('')
const rangeTo = ref('')
const selectedCinemaIds = ref<number[]>([])

const cinemaList = computed(() => Object.values(props.cinemas))
const hasDate = computed(() => !!selectedDate.value)
const hasRange = computed(() => !!(rangeFrom.value && rangeTo.value))
const hasCinemas = computed(() => selectedCinemaIds.value.length > 0)

const cinemaByName = computed(() =>
  Object.fromEntries(cinemaList.value.map(c => [c.name, c.id]))
)
const cinemaById = computed(() =>
  Object.fromEntries(cinemaList.value.map(c => [String(c.id), c.name]))
)

const formatDate = (iso: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'numeric' }).format(date)
}

const dateLabel = computed(() => formatDate(selectedDate.value))
const rangeLabel = computed(() => `${formatDate(rangeFrom.value)} → ${formatDate(rangeTo.value)}`)
const cinemasLabel = computed(() =>
  cinemaList.value.filter(c => selectedCinemaIds.value.includes(c.id)).map(c => c.name).join(', ')
)

const emitFilter = () => {
  const f: FilterState = {}
  if (selectedDate.value) f.date = selectedDate.value
  if (rangeFrom.value && rangeTo.value) f.range = { from: rangeFrom.value, to: rangeTo.value }
  if (selectedCinemaIds.value.length) f.cinemaIds = [...selectedCinemaIds.value]
  emit('update:filter', f)
  syncHash()
}

const syncHash = () => {
  const p = new URLSearchParams()
  if (selectedDate.value) p.set('date', selectedDate.value)
  if (rangeFrom.value && rangeTo.value) p.set('range', `${rangeFrom.value}_${rangeTo.value}`)
  if (selectedCinemaIds.value.length) {
    const names = selectedCinemaIds.value.map(id => cinemaById.value[String(id)]).filter(Boolean)
    if (names.length) p.set('cinemas', names.join(','))
  }
  const h = p.toString()
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search)
}

const togglePicker = (p: 'date' | 'range' | 'cinemas') => {
  activePicker.value = activePicker.value === p ? null : p
}

const onDateChange = () => {
  rangeFrom.value = ''
  rangeTo.value = ''
  activePicker.value = null
  emitFilter()
}

const clearDate = () => {
  selectedDate.value = ''
  emitFilter()
}

const applyRange = () => {
  if (!rangeFrom.value || !rangeTo.value) return
  selectedDate.value = ''
  activePicker.value = null
  emitFilter()
}

const clearRange = () => {
  rangeFrom.value = ''
  rangeTo.value = ''
  emitFilter()
}

const toggleCinema = (id: number) => {
  const i = selectedCinemaIds.value.indexOf(id)
  if (i >= 0) selectedCinemaIds.value.splice(i, 1)
  else selectedCinemaIds.value.push(id)
  emitFilter()
}

const clearCinemas = () => {
  selectedCinemaIds.value = []
  activePicker.value = null
  emitFilter()
}

onMounted(() => {
  const hash = window.location.hash.slice(1)
  if (!hash) return
  const p = new URLSearchParams(hash)
  if (p.has('date')) selectedDate.value = p.get('date')!
  if (p.has('range')) {
    const parts = p.get('range')!.split('_')
    if (parts[0] && parts[1]) { rangeFrom.value = parts[0]; rangeTo.value = parts[1] }
  }
  if (p.has('cinemas')) {
    const names = p.get('cinemas')!.split(',')
    selectedCinemaIds.value = names.map(name => cinemaByName.value[name]).filter(Boolean)
  }
  if (hash) emitFilter()
})
</script>

<template>
  <div class="mt-3 text-sm">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-gray-300">

      <!-- Date filter -->
      <span v-if="hasDate" class="flex items-center gap-1">
        <button
          @click="togglePicker('date')"
          class="text-orange-400 hover:text-orange-300 transition-colors"
        >date: {{ dateLabel }}</button>
        <button
          @click="clearDate"
          class="text-gray-500 hover:text-white transition-colors leading-none px-0.5"
          aria-label="Clear date filter"
        >×</button>
      </span>
      <button
        v-else
        @click="togglePicker('date')"
        :class="['transition-colors underline underline-offset-2', activePicker === 'date' ? 'text-orange-300' : 'text-orange-400 hover:text-orange-300']"
      >select date</button>

      <span class="text-gray-600">·</span>

      <!-- Range filter -->
      <span v-if="hasRange" class="flex items-center gap-1">
        <button
          @click="togglePicker('range')"
          class="text-orange-400 hover:text-orange-300 transition-colors"
        >range: {{ rangeLabel }}</button>
        <button
          @click="clearRange"
          class="text-gray-500 hover:text-white transition-colors leading-none px-0.5"
          aria-label="Clear range filter"
        >×</button>
      </span>
      <button
        v-else
        @click="togglePicker('range')"
        :class="['transition-colors underline underline-offset-2', activePicker === 'range' ? 'text-orange-300' : 'text-orange-400 hover:text-orange-300']"
      >select date range</button>

      <span class="text-gray-600">·</span>

      <!-- Cinema filter -->
      <span v-if="hasCinemas" class="flex items-center gap-1">
        <button
          @click="togglePicker('cinemas')"
          class="text-orange-400 hover:text-orange-300 transition-colors"
        >cinemas: {{ cinemasLabel }}</button>
        <button
          @click="clearCinemas"
          class="text-gray-500 hover:text-white transition-colors leading-none px-0.5"
          aria-label="Clear cinema filter"
        >×</button>
      </span>
      <button
        v-else
        @click="togglePicker('cinemas')"
        :class="['transition-colors underline underline-offset-2', activePicker === 'cinemas' ? 'text-orange-300' : 'text-orange-400 hover:text-orange-300']"
      >select cinemas</button>
    </div>

    <!-- Date picker -->
    <div v-if="activePicker === 'date'" class="mt-2">
      <input
        v-model="selectedDate"
        type="date"
        @change="onDateChange"
        class="bg-gray-700 border border-gray-600 text-white rounded px-2 py-1 text-sm focus:outline-none focus:border-orange-500"
      />
    </div>

    <!-- Range picker -->
    <div v-if="activePicker === 'range'" class="mt-2 flex flex-wrap items-center gap-2">
      <input
        v-model="rangeFrom"
        type="date"
        class="bg-gray-700 border border-gray-600 text-white rounded px-2 py-1 text-sm focus:outline-none focus:border-orange-500"
      />
      <span class="text-gray-400">→</span>
      <input
        v-model="rangeTo"
        type="date"
        class="bg-gray-700 border border-gray-600 text-white rounded px-2 py-1 text-sm focus:outline-none focus:border-orange-500"
      />
      <button
        @click="applyRange"
        :disabled="!rangeFrom || !rangeTo"
        class="px-3 py-1 bg-orange-700 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs font-medium transition-colors"
      >Apply</button>
    </div>

    <!-- Cinema checkboxes -->
    <div v-if="activePicker === 'cinemas'" class="mt-2 space-y-1.5">
      <label
        v-for="cinema in cinemaList"
        :key="cinema.id"
        class="flex items-center gap-2 cursor-pointer select-none"
      >
        <input
          type="checkbox"
          :checked="selectedCinemaIds.includes(cinema.id)"
          @change="toggleCinema(cinema.id)"
          class="rounded accent-orange-500 cursor-pointer w-4 h-4"
        />
        <span>{{ cinema.name }}</span>
      </label>
      <button
        @click="activePicker = null"
        class="mt-1 px-3 py-1 bg-orange-700 hover:bg-orange-600 rounded text-xs font-medium transition-colors"
      >Close</button>
    </div>
  </div>
</template>
