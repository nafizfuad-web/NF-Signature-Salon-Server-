// SalonBook — secure admin bootstrap.
//
// Usage:
//   ADMIN_EMAIL=admin@salonbook.test ADMIN_PASSWORD='...' npm run seed:admin
//
// The script is idempotent: if the admin already exists it reports that and
// exits without resetting the password or creating a duplicate user.

require('dotenv').config({ path: '.env', quiet: true })
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const password = process.env.ADMIN_PASSWORD || ''

function fail(message) {
  console.error(message)
  process.exit(1)
}

function validPassword(value) {
  return (
    value.length >= 8 &&
    Buffer.byteLength(value, 'utf8') <= 72 &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value)
  )
}

async function main() {
  if (!process.env.MONGODB_URI) fail('MONGODB_URI is required.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('ADMIN_EMAIL must be a valid email address.')
  if (!validPassword(password)) {
    fail('ADMIN_PASSWORD must be 8-72 bytes and contain a letter and a number.')
  }

  await mongoose.connect(process.env.MONGODB_URI)
  const users = mongoose.connection.db.collection('users')
  const existing = await users.findOne({ email })

  if (existing?.role === 'admin') {
    console.log(`Admin already exists for ${email}. No changes made.`)
    await mongoose.disconnect()
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const now = new Date()

  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      {
        $set: {
          role: 'admin',
          passwordHash,
          emailVerified: true,
          isBlocked: false,
          updatedAt: now,
        },
        $unset: {
          blockedAt: 1,
          blockedBy: 1,
          blockReason: 1,
        },
      },
    )
    console.log(`Promoted existing account ${email} to admin.`)
  } else {
    await users.insertOne({
      name: 'Salon Admin',
      email,
      role: 'admin',
      emailVerified: true,
      isBlocked: false,
      tokenVersion: 0,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    })
    console.log(`Created admin account for ${email}.`)
  }

  await mongoose.disconnect()
}

main().catch((error) => {
  console.error('Admin seed failed:', error?.name || 'UnknownError')
  process.exit(1)
})
