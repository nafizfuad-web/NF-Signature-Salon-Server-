/* Read-only diagnostic: inspect user documents without printing credentials. */
const path = require('node:path')
const mongoose = require('mongoose')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI missing')

  await mongoose.connect(uri)
  const db = mongoose.connection.db
  const users = db.collection('users')

  const total = await users.countDocuments()
  const withHash = await users.countDocuments({ passwordHash: { $type: 'string' } })
  const withoutHash = await users.countDocuments({ passwordHash: { $exists: false } })
  const nullHash = await users.countDocuments({ passwordHash: null })
  const withGoogle = await users.countDocuments({ googleId: { $exists: true } })

  console.log(JSON.stringify({ total, withHash, withoutHash, nullHash, withGoogle }, null, 2))

  const sample = await users
    .find({}, { projection: { email: 1, role: 1, createdAt: 1, passwordHash: 1, googleId: 1 } })
    .sort({ createdAt: 1 })
    .limit(20)
    .toArray()

  for (const user of sample) {
    const [local, domain] = String(user.email || '').split('@')
    console.log({
      id: String(user._id),
      email: `${String(local).slice(0, 2)}***@${domain || '?'}`,
      role: user.role,
      hasPasswordHash: typeof user.passwordHash === 'string' && user.passwordHash.length > 0,
      hashPrefix: typeof user.passwordHash === 'string' ? user.passwordHash.slice(0, 4) : null,
      hashLength: typeof user.passwordHash === 'string' ? user.passwordHash.length : 0,
      hasGoogleId: typeof user.googleId === 'string' && user.googleId.length > 0,
      createdAt: user.createdAt,
    })
  }

  const indexes = await users.indexes()
  console.log('indexes:', indexes.map((index) => ({ name: index.name, key: index.key, unique: index.unique })))

  await mongoose.disconnect()
}

main().catch((error) => {
  console.error('audit failed:', error.name, error.message)
  process.exit(1)
})
