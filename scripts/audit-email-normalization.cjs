/* Read-only diagnostic: find email normalization anomalies without printing full addresses. */
const path = require('node:path')
const mongoose = require('mongoose')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

async function main() {
  await mongoose.connect(process.env.MONGODB_URI)
  const users = mongoose.connection.db.collection('users')
  const docs = await users.find({}, { projection: { email: 1, passwordHash: 1 } }).toArray()

  const anomalies = []
  const byNormalized = new Map()
  for (const doc of docs) {
    const email = String(doc.email ?? '')
    const normalized = email.trim().toLowerCase()
    if (email !== normalized) {
      anomalies.push({ id: String(doc._id), issue: 'not-normalized', length: email.length })
    }
    const list = byNormalized.get(normalized) ?? []
    list.push(String(doc._id))
    byNormalized.set(normalized, list)
  }
  for (const [normalized, ids] of byNormalized) {
    if (ids.length > 1) {
      anomalies.push({ normalizedDomain: normalized.split('@')[1], count: ids.length, issue: 'duplicate-normalized-email' })
    }
  }

  console.log(JSON.stringify({ total: docs.length, anomalies }, null, 2))
  await mongoose.disconnect()
}

main().catch((error) => {
  console.error('audit failed:', error.name, error.message)
  process.exit(1)
})
