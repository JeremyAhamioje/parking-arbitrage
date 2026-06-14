import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

const PRICE_SPIKE_THRESHOLD = parseFloat(process.env.PRICE_SPIKE_THRESHOLD || '20')
const INVENTORY_DROP_THRESHOLD = parseFloat(process.env.INVENTORY_DROP_THRESHOLD || '40')

/**
 * Run change detection on the latest scraper data.
 *
 * Flow:
 * 1. Get latest snapshots (listings) grouped by venue/lot
 * 2. For each unique venue/lot, calculate avg price and total spaces
 * 3. Compare to previous parking_snapshot for that venue/lot
 * 4. If price change > PRICE_SPIKE_THRESHOLD or space drop > INVENTORY_DROP_THRESHOLD, tag it
 * 5. Create alerts for tagged signals
 */
async function runChangeDetection() {
  console.log('🔍 Starting change detection...\n')

  try {
    // Step 1: Get the most recent scraper run timestamp
    const { data: latestRun } = await db
      .from('snapshots')
      .select('scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1)
      .single()

    if (!latestRun) {
      console.log('No snapshots found. Run the scraper first.')
      return
    }

    const latestScrapedAt = latestRun.scraped_at
    console.log(`Latest scraper run: ${latestScrapedAt}\n`)

    // Step 2: Get all listings from the latest run, grouped by venue/lot
    const { data: latestSnapshots, error: snapshotError } = await db
      .from('snapshots')
      .select('venue_id, facility_name, address, city, state, total_price, available_spaces')
      .eq('scraped_at', latestScrapedAt)

    if (snapshotError) {
      throw new Error(`Failed to fetch snapshots: ${snapshotError.message}`)
    }

    if (!latestSnapshots || latestSnapshots.length === 0) {
      console.log('No snapshots in latest run.')
      return
    }

    // Get venue names
    const { data: venues } = await db.from('venues').select('id, name')
    const venueMap = Object.fromEntries((venues || []).map(v => [v.id, v.name]))

    // Group by venue/lot
    const groupedByLot = {}
    for (const snap of latestSnapshots) {
      const venueName = venueMap[snap.venue_id] || 'Unknown'
      const lotAddress = snap.address || 'Unknown'
      const key = `${venueName}|${lotAddress}`

      if (!groupedByLot[key]) {
        groupedByLot[key] = {
          venueName,
          lotAddress,
          prices: [],
          spaceCounts: [],
        }
      }
      groupedByLot[key].prices.push(snap.total_price || 0)
      groupedByLot[key].spaceCounts.push(snap.available_spaces || 0)
    }

    console.log(`Found ${Object.keys(groupedByLot).length} unique venue/lot combinations\n`)

    let signalsCreated = 0

    // Step 3: For each venue/lot, calculate aggregates and compare to previous
    for (const [key, data] of Object.entries(groupedByLot)) {
      const avgPrice = data.prices.reduce((a, b) => a + b, 0) / data.prices.length
      const totalSpaces = data.spaceCounts.reduce((a, b) => a + b, 0)

      // Get previous snapshot for this venue/lot
      const { data: prevSnapshot } = await db
        .from('parking_snapshots')
        .select('id, price, spaces')
        .eq('venue_name', data.venueName)
        .eq('lot_address', data.lotAddress)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .single()

      // Insert current snapshot
      const { error: insertError } = await db.from('parking_snapshots').insert({
        venue_name: data.venueName,
        lot_address: data.lotAddress,
        price: parseFloat(avgPrice.toFixed(2)),
        spaces: Math.round(totalSpaces),
        scraped_at: latestScrapedAt,
      })

      if (insertError) {
        console.error(`  ❌ Failed to insert snapshot for ${key}: ${insertError.message}`)
        continue
      }

      // If no previous snapshot, skip comparison
      if (!prevSnapshot) {
        console.log(`  → ${data.venueName} — ${data.lotAddress}: First run (baseline)`)
        continue
      }

      // Calculate deltas
      const priceDelta = avgPrice - prevSnapshot.price
      const priceChangePct = (priceDelta / prevSnapshot.price) * 100
      const spaceDelta = totalSpaces - prevSnapshot.spaces
      const spaceChangePct = prevSnapshot.spaces > 0
        ? (spaceDelta / prevSnapshot.spaces) * 100
        : 0

      // Check thresholds
      const isPriceSpike = priceChangePct > PRICE_SPIKE_THRESHOLD
      const isInventoryDrop = spaceChangePct < -INVENTORY_DROP_THRESHOLD
      const isBothConditions = isPriceSpike && isInventoryDrop

      if (isPriceSpike || isInventoryDrop) {
        console.log(`  ⭐ ${data.venueName} — ${data.lotAddress}`)
        if (isPriceSpike) {
          console.log(`     Price: ${prevSnapshot.price.toFixed(2)} → ${avgPrice.toFixed(2)} (${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(1)}%)`)
        }
        if (isInventoryDrop) {
          console.log(`     Spaces: ${prevSnapshot.spaces} → ${totalSpaces} (${spaceChangePct.toFixed(1)}%)`)
        }

        // Determine signal type
        let signalType = 'PRICE_SPIKE'
        if (isBothConditions) {
          signalType = 'HIGH_PROFILE'
        } else if (isInventoryDrop && !isPriceSpike) {
          signalType = 'INVENTORY_DROP'
        }

        // Create signal
        try {
          const { data: signal, error: signalError } = await db
            .from('venue_signals')
            .insert({
              venue_name: data.venueName,
              lot_address: data.lotAddress,
              signal_type: signalType,
              price_before: prevSnapshot.price,
              price_after: parseFloat(avgPrice.toFixed(2)),
              price_change_pct: parseFloat(priceChangePct.toFixed(2)),
              spaces_before: prevSnapshot.spaces,
              spaces_after: Math.round(totalSpaces),
              spaces_change_pct: parseFloat(spaceChangePct.toFixed(2)),
              resolved: false,
            })
            .select()

          if (signalError) {
            console.error(`      Signal creation failed: ${signalError.message}`)
            continue
          }

          // Create alert
          const alertType = signalType === 'HIGH_PROFILE'
            ? 'HIGH_PROFILE'
            : isPriceSpike
            ? 'PRICE_SPIKE'
            : 'INVENTORY_DROP'

          const message = isBothConditions
            ? `🚨 ${data.venueName} — Price up ${priceChangePct.toFixed(1)}%, spaces down ${Math.abs(spaceChangePct).toFixed(1)}%. HIGH PROFILE.`
            : isPriceSpike
            ? `📈 ${data.venueName} — ${data.lotAddress}: Price up ${priceChangePct.toFixed(1)}% (${prevSnapshot.price.toFixed(2)} → ${avgPrice.toFixed(2)})`
            : `📉 ${data.venueName} — ${data.lotAddress}: Spaces down ${Math.abs(spaceChangePct).toFixed(1)}% (${prevSnapshot.spaces} → ${totalSpaces})`

          const { error: alertError } = await db.from('alerts').insert({
            type: alertType,
            venue_id: null,
            message,
            metadata: {
              venue_name: data.venueName,
              lot_address: data.lotAddress,
              price_before: prevSnapshot.price,
              price_after: parseFloat(avgPrice.toFixed(2)),
              price_change_pct: parseFloat(priceChangePct.toFixed(2)),
              spaces_before: prevSnapshot.spaces,
              spaces_after: Math.round(totalSpaces),
              spaces_change_pct: parseFloat(spaceChangePct.toFixed(2)),
              signal_type: signalType,
            },
          })

          if (alertError) {
            console.error(`      Alert creation failed: ${alertError.message}`)
          } else {
            signalsCreated++
          }
        } catch (err) {
          console.error(`      Error processing signal: ${err.message}`)
        }
      } else {
        console.log(`  ✓ ${data.venueName} — ${data.lotAddress} (stable)`)
      }
    }

    console.log(`\n✅ Change detection complete. ${signalsCreated} signal(s) created.`)
  } catch (error) {
    console.error('Change detection failed:', error.message)
    process.exit(1)
  }
}

runChangeDetection()
