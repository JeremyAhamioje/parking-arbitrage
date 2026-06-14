import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

async function seedVenues() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'venue-coords.json'), 'utf8')
    const venueData = JSON.parse(rawData)

    const venues = Object.entries(venueData).map(([name, data]) => ({
      name,
      lat: data.lat,
      lon: data.lon,
      spothero_destination_id: data.spotheroDestinationId ? parseInt(data.spotheroDestinationId) : null,
    }))

    console.log(`📍 Seeding ${venues.length} venues...`)

    const { data, error } = await supabase.from('venues').insert(venues).select()

    if (error) {
      console.error('❌ Error seeding venues:', error)
      return
    }

    console.log(`✅ Successfully seeded ${data.length} venues`)
    console.log('\nVenues:')
    data.forEach(v => console.log(`  - ${v.name}`))
  } catch (err) {
    console.error('❌ Seed failed:', err.message)
  }
}

seedVenues()
